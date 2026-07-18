import https from 'https';
import fs from 'fs';
import path from 'path';
import { CTX_FRAMEWORK_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

const SECRETS_DIR = path.join(CTX_FRAMEWORK_ROOT, 'orgs', 'atlasos', 'secrets');
const CLIENT_SECRET_PATH = path.join(SECRETS_DIR, 'gmail_client_secret.json');
const TOKEN_FILE = path.join(SECRETS_DIR, 'gmail_tokens.json');
const CALENDAR_TZ = 'America/Denver';

function loadClientSecret() {
  const raw = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  return raw.installed || raw.web || Object.values(raw)[0] as Record<string, string>;
}

function post(url: string, data: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let out = '';
      res.on('data', (d: Buffer) => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function calGet(accessToken: string, path_: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: path_,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    }, res => {
      let out = '';
      res.on('data', (d: Buffer) => out += d);
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(out) }); } catch { resolve({ status: res.statusCode!, body: {} }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAccessToken(): Promise<string> {
  const client = loadClientSecret() as Record<string, string>;
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Record<string, unknown>;
  const expiry = typeof tokens.expiry_date === 'number' ? tokens.expiry_date : 0;
  const expired = !expiry || Date.now() >= expiry - 60000;
  if (expired && typeof tokens.refresh_token === 'string') {
    const r = await post('https://oauth2.googleapis.com/token', {
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token as string,
      grant_type: 'refresh_token',
    });
    if (typeof r.access_token === 'string') {
      tokens.access_token = r.access_token;
      tokens.expiry_date = Date.now() + ((r.expires_in as number) || 3600) * 1000;
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    }
  }
  return tokens.access_token as string;
}

function formatMT(dateTimeStr: string): string {
  return new Date(dateTimeStr).toLocaleString('en-US', {
    timeZone: CALENDAR_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export interface CalendarEvent {
  id: string;
  title: string;
  startIso: string;
  startMT: string;
  endMT: string | null;
  location: string | null;
  videoLink: string | null;
  attendees: string[];
  minutesUntil: number | null;
}

export async function GET() {
  try {
    const token = await getAccessToken();
    const now = new Date();
    const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const qs = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '5',
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    const { status, body } = await calGet(token, `/calendar/v3/calendars/primary/events?${qs}`);
    if (status !== 200) {
      return Response.json({ error: 'Calendar API error', status }, { status: 502 });
    }
    const raw = (body as { items?: Record<string, unknown>[] }).items ?? [];
    // Filter out all-day events and past events; take first 2 real upcoming
    const events: CalendarEvent[] = raw
      .filter(ev => {
        const start = ev.start as Record<string, string> | undefined;
        return start?.dateTime; // skip all-day (only have `date`)
      })
      .slice(0, 2)
      .map(ev => {
        const start = ev.start as Record<string, string>;
        const end = ev.end as Record<string, string> | undefined;
        const attendeeList = (ev.attendees as Array<{ email: string; displayName?: string }> | undefined) ?? [];
        const minsUntil = Math.round((new Date(start.dateTime).getTime() - Date.now()) / 60000);
        return {
          id: ev.id as string,
          title: (ev.summary as string) || '(no title)',
          startIso: start.dateTime,
          startMT: formatMT(start.dateTime),
          endMT: end?.dateTime ? new Date(end.dateTime).toLocaleString('en-US', { timeZone: CALENDAR_TZ, hour: 'numeric', minute: '2-digit', hour12: true }) : null,
          location: (ev.location as string) || null,
          videoLink: (ev.hangoutLink as string) || null,
          attendees: attendeeList.map(a => a.displayName || a.email).slice(0, 5),
          minutesUntil: minsUntil,
        };
      });
    return Response.json({ events, fetchedAt: now.toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/meetings/upcoming]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
