import { createClient } from '@supabase/supabase-js';
import type { PosterConfig } from './types.js';

export interface HeartbeatPayload {
  agentName: string;
  browserHealthy: boolean;
  status: 'idle' | 'busy' | 'error';
  profilePath: string;
  metadata?: Record<string, unknown>;
}

export async function sendHeartbeat(config: PosterConfig, payload: HeartbeatPayload): Promise<void> {
  const supabase = createClient(config.supabaseUrl, config.supabaseKey);

  const { error } = await supabase
    .from('poster_heartbeats')
    .upsert(
      {
        agent_name: payload.agentName,
        browser_healthy: payload.browserHealthy,
        status: payload.status,
        profile_path: payload.profilePath,
        metadata: payload.metadata ?? {},
        last_check_at: new Date().toISOString(),
      },
      { onConflict: 'agent_name' }
    );

  if (error) {
    console.error('[heartbeat] Supabase upsert failed:', error.message);
  }
}
