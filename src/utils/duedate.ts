/**
 * Due-date parsing for tasks.
 *
 * Exists because `create-task` had no way to record WHEN something was due:
 * every one of 478 open tasks carried `due_date: null`, so "there is an urgent
 * task for today" had nowhere to land and nothing could compute what was due.
 *
 * All relative words ("today", "tomorrow") resolve in JENNIFER'S timezone, not
 * UTC. A bash/cron clock is UTC and is six hours ahead of Mountain — resolving
 * "today" against it silently rolls the date over after 18:00 MT.
 */

export const OWNER_TZ = 'America/Denver';

/** Offset in minutes between `tz` wall-clock and UTC at the given instant. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl gives hour "24" for midnight in some ICU versions; normalise.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

/** Calendar date (YYYY-MM-DD) in `tz` for the given instant. */
function localDateString(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * Convert a YYYY-MM-DD wall date into the UTC instant of 23:59:00 local.
 * Due "today" means end of today where she is, not 00:00 UTC.
 */
function endOfLocalDay(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 0);
  const offset = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - offset * 60000);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a human due date into an ISO 8601 instant, or null if unparseable.
 *
 * Accepts: today, tonight, tomorrow, eod, "in 3 days", "3d", a weekday name
 * (next occurrence, never today), YYYY-MM-DD, MM/DD, MM/DD/YYYY.
 */
export function parseDueDate(input?: string, now: Date = new Date(), tz: string = OWNER_TZ): string | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const todayYmd = localDateString(now, tz);
  const shiftDays = (n: number): string => {
    const [y, m, d] = todayYmd.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d + n));
    return base.toISOString().slice(0, 10);
  };

  if (raw === 'today' || raw === 'tonight' || raw === 'eod' || raw === 'now') {
    return endOfLocalDay(todayYmd, tz).toISOString();
  }
  if (raw === 'tomorrow' || raw === 'tmrw') {
    return endOfLocalDay(shiftDays(1), tz).toISOString();
  }

  // "in 3 days" / "3 days" / "3d"
  const rel = raw.match(/^(?:in\s+)?(\d+)\s*(?:d|day|days)$/);
  if (rel) return endOfLocalDay(shiftDays(Number(rel[1])), tz).toISOString();

  // "in 2 weeks" / "2w"
  const relW = raw.match(/^(?:in\s+)?(\d+)\s*(?:w|week|weeks)$/);
  if (relW) return endOfLocalDay(shiftDays(Number(relW[1]) * 7), tz).toISOString();

  // Weekday name → next occurrence, never today (today would be ambiguous).
  const wdIndex = WEEKDAYS.indexOf(raw.replace(/^next\s+/, ''));
  if (wdIndex >= 0) {
    const todayIdx = new Date(`${todayYmd}T12:00:00Z`).getUTCDay();
    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    return endOfLocalDay(shiftDays(delta), tz).toISOString();
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return endOfLocalDay(raw, tz).toISOString();

  // MM/DD or MM/DD/YYYY
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const mm = String(Number(slash[1])).padStart(2, '0');
    const dd = String(Number(slash[2])).padStart(2, '0');
    let yyyy = slash[3] ?? todayYmd.slice(0, 4);
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    return endOfLocalDay(`${yyyy}-${mm}-${dd}`, tz).toISOString();
  }

  return null;
}

/** True when `iso` falls on today's calendar date in `tz`. */
export function isDueToday(iso: string | null, now: Date = new Date(), tz: string = OWNER_TZ): boolean {
  if (!iso) return false;
  return localDateString(new Date(iso), tz) === localDateString(now, tz);
}

/** True when `iso` is strictly in the past. */
export function isOverdue(iso: string | null, now: Date = new Date()): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < now.getTime();
}

/** Short human label for a due date, in owner-local terms. */
export function describeDue(iso: string | null, now: Date = new Date(), tz: string = OWNER_TZ): string {
  if (!iso) return 'no due date';
  const day = localDateString(new Date(iso), tz);
  const today = localDateString(now, tz);
  if (day === today) return isOverdue(iso, now) ? 'DUE TODAY (past due time)' : 'DUE TODAY';
  if (isOverdue(iso, now)) return `OVERDUE (was due ${day})`;
  return `due ${day}`;
}
