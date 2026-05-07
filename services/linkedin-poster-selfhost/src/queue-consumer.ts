/**
 * queue-consumer.ts — Supabase queue consumer for the self-hosted LinkedIn poster.
 *
 * Polls two queues:
 *   1. linkedin_engagement_queue — approved items (comment / connect / like)
 *   2. linkedin_poster_jobs      — RPC jobs (publish_post variants, fetch_profile_posts)
 *
 * All dispatches go through the local HTTP server so the inFlight guard and
 * 30s cooldown are enforced in one place. Writes results back to Supabase.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PosterConfig } from './types.js';

// ---------------------------------------------------------------------------
// Types mirroring the Supabase tables
// ---------------------------------------------------------------------------

interface EngagementQueueItem {
  id: string;
  status: string;
  sender_id: string | null;
  author_name: string | null;
  author_profile_url: string | null;
  post_url: string | null;
  actions: string[];
  draft_comment: string | null;
  connection_note: string | null;
}

interface PosterJob {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  requested_by: string | null;
}

// ---------------------------------------------------------------------------
// QueueConsumer
// ---------------------------------------------------------------------------

export class QueueConsumer {
  private supabase: SupabaseClient;
  private config: PosterConfig;
  private baseUrl: string;
  private engagementProcessing = false;
  private jobProcessing = false;
  private engagementTimer: ReturnType<typeof setInterval> | null = null;
  private jobTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PosterConfig) {
    this.config = config;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.baseUrl = `http://127.0.0.1:${config.port}`;
  }

  start(): void {
    console.log(`[queue] Starting consumers for user=${this.config.userId}`);
    this.engagementTimer = setInterval(() => this.processEngagementQueue(), 15_000);
    this.jobTimer = setInterval(() => this.processJobQueue(), 5_000);

    // Immediate first tick (staggered 2s apart to avoid double-fire on startup)
    setTimeout(() => this.processEngagementQueue(), 2_000);
    setTimeout(() => this.processJobQueue(), 4_000);
  }

  stop(): void {
    if (this.engagementTimer) clearInterval(this.engagementTimer);
    if (this.jobTimer) clearInterval(this.jobTimer);
    console.log('[queue] Consumers stopped');
  }

  // ---------------------------------------------------------------------------
  // Engagement queue — linkedin_engagement_queue
  // ---------------------------------------------------------------------------

  private async processEngagementQueue(): Promise<void> {
    if (this.engagementProcessing) return;
    this.engagementProcessing = true;

    try {
      // Claim one approved item scoped to this sender UUID (or unscoped items).
      // sender_id is a UUID column — pass senderUuid, not the human userId string.
      const { data: items, error } = await this.supabase
        .from('linkedin_engagement_queue')
        .select('id,status,sender_id,author_name,author_profile_url,post_url,actions,draft_comment,connection_note')
        .eq('status', 'approved')
        .or(`sender_id.eq.${this.config.senderUuid},sender_id.is.null`)
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        console.error('[queue/engagement] Fetch error:', error.message);
        return;
      }
      if (!items || items.length === 0) return;

      const item = items[0] as EngagementQueueItem;
      console.log(`[queue/engagement] Processing: ${item.author_name} actions=${item.actions?.join('+')}`);

      const today = new Date().toISOString().slice(0, 10);
      const actionsTaken: string[] = [];

      // Comment
      if (item.actions?.includes('comment') && item.draft_comment && item.post_url) {
        const res = await this.dispatch('/comment', { postUrl: item.post_url, commentText: item.draft_comment });
        if (res.success) {
          await this.supabase.from('linkedin_engagements').insert({
            queue_item_id: item.id,
            author_name: item.author_name,
            author_linkedin_url: item.author_profile_url || item.post_url,
            post_url: item.post_url,
            action_type: 'commented',
            comment_text: item.draft_comment,
            session_date: today,
          });
          actionsTaken.push('commented');
        } else {
          console.error(`[queue/engagement] Comment failed: ${res.error}`);
        }
        // Enforce 30s gap between actions within the same item
        if (item.actions.length > 1) await sleep(30_000);
      }

      // Connect
      if (item.actions?.includes('connect') && item.author_profile_url) {
        const res = await this.dispatch('/connect', {
          profileUrl: item.author_profile_url,
          noteText: item.connection_note ?? undefined,
        });
        if (res.success) {
          await this.supabase.from('linkedin_engagements').insert({
            queue_item_id: item.id,
            author_name: item.author_name,
            author_linkedin_url: item.author_profile_url,
            action_type: 'connected',
            connection_note: item.connection_note ?? null,
            session_date: today,
          });
          actionsTaken.push('connected');
        } else if (res.skipped) {
          console.log(`[queue/engagement] Connect skipped: ${res.reason}`);
          actionsTaken.push('connect_skipped');
        } else {
          console.error(`[queue/engagement] Connect failed: ${res.error}`);
        }
      }

      // Mark queue item as posted or skipped
      const hasRealAction = actionsTaken.some(a => !a.endsWith('_skipped'));
      const newStatus = hasRealAction ? 'posted' : 'skipped';
      await this.supabase
        .from('linkedin_engagement_queue')
        .update({ status: newStatus, ...(newStatus === 'skipped' ? { skip_reason: 'all_actions_failed_or_skipped' } : {}) })
        .eq('id', item.id);

      console.log(`[queue/engagement] ${item.author_name}: ${actionsTaken.join('+') || 'none'} -> ${newStatus}`);
    } catch (err) {
      console.error('[queue/engagement] Error:', (err as Error).message);
    } finally {
      this.engagementProcessing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // RPC job queue — linkedin_poster_jobs
  // ---------------------------------------------------------------------------

  private async processJobQueue(): Promise<void> {
    if (this.jobProcessing) return;
    this.jobProcessing = true;

    try {
      // Claim one pending job. Identity-scoped kinds (publish_*) require
      // requested_by to match this user; fetch_profile_posts is sender-agnostic.
      const SENDER_SCOPED_KINDS = ['publish_post', 'publish_post_with_image', 'publish_post_with_images'];

      // Atomically claim by updating status pending -> claimed.
      // requested_by is a UUID column — use senderUuid, not the human userId string.
      // NOTE: Supabase JS .update().order() translates to a PATCH with ?order= which
      // PostgREST does not support for UPDATE operations — omit ordering here to avoid
      // "column does not exist" errors. First-pending semantics are fine for correctness.
      const { data: claimed, error: claimErr } = await this.supabase
        .from('linkedin_poster_jobs')
        .update({ status: 'claimed', claimed_at: new Date().toISOString() })
        .eq('status', 'pending')
        .or(
          `and(kind.not.in.(${SENDER_SCOPED_KINDS.join(',')})),` +
          `and(requested_by.eq.${this.config.senderUuid})`
        )
        .limit(1)
        .select('id,kind,status,payload,requested_by');

      if (claimErr) {
        console.error('[queue/jobs] Claim error:', claimErr.message);
        return;
      }
      if (!claimed || claimed.length === 0) return;

      const job = claimed[0] as PosterJob;
      console.log(`[queue/jobs] Claimed job ${job.id} kind=${job.kind}`);

      let result: unknown = null;
      let jobError: string | null = null;

      try {
        switch (job.kind) {
          case 'publish_post':
          case 'publish_post_with_image':
          case 'publish_post_with_images': {
            // Identity check — only process our own posts.
            // Compare against senderUuid (UUID), not userId (short string handle).
            if (job.requested_by !== this.config.senderUuid) {
              throw new Error(`unauthorized_requester:${job.requested_by ?? 'null'}`);
            }
            const payload = job.payload ?? {};
            const postText = payload['postText'] as string;
            if (!postText) throw new Error('postText required');

            let imagePaths: string[] | undefined;
            if (job.kind === 'publish_post_with_image') {
              const p = payload['image_path'] as string;
              if (!p) throw new Error('image_path required');
              imagePaths = [await this.downloadStorageImage(job.id, p, 0)];
            } else if (job.kind === 'publish_post_with_images') {
              const paths = payload['image_paths'] as string[];
              if (!Array.isArray(paths) || paths.length === 0) throw new Error('image_paths required');
              imagePaths = await Promise.all(paths.map((p, i) => this.downloadStorageImage(job.id, p, i)));
            }

            const res = await this.dispatch('/post', { postText, imagePaths });
            if (!res['success']) throw new Error((res['error'] as string | undefined) ?? 'publish_post failed');
            result = res;
            break;
          }

          case 'fetch_profile_posts': {
            // Self-hosted poster doesn't run agent-browser; return not-supported
            // so the Mac poster can pick it up instead.
            throw new Error('fetch_profile_posts not supported by selfhost poster — re-queue for Mac poster');
          }

          default:
            throw new Error(`unknown_kind:${job.kind}`);
        }
      } catch (err) {
        jobError = (err as Error).message;
      }

      // Write result back
      await this.supabase
        .from('linkedin_poster_jobs')
        .update(
          jobError
            ? { status: 'failed', error: jobError, completed_at: new Date().toISOString() }
            : { status: 'completed', result, completed_at: new Date().toISOString() }
        )
        .eq('id', job.id);

      console.log(`[queue/jobs] Job ${job.id} ${jobError ? 'failed' : 'completed'}`);
    } catch (err) {
      console.error('[queue/jobs] Error:', (err as Error).message);
    } finally {
      this.jobProcessing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async dispatch(path: string, body: unknown): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async downloadStorageImage(jobId: string, storagePath: string, idx: number): Promise<string> {
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const url = `${this.config.supabaseUrl}/storage/v1/object/content-images/${storagePath}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.supabaseKey}` },
    });
    if (!res.ok) throw new Error(`Storage download failed for ${storagePath}: http_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmpPath = join(tmpdir(), `poster-${jobId}-${idx + 1}.png`);
    writeFileSync(tmpPath, buf);
    return tmpPath;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
