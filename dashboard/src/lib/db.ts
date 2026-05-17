import postgres from 'postgres';

const globalForSql = globalThis as unknown as { __cortextos_sql: ReturnType<typeof postgres> | undefined };

export const sql = globalForSql.__cortextos_sql ?? postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

if (process.env.NODE_ENV !== 'production') {
  globalForSql.__cortextos_sql = sql;
}

export async function initializeSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT,
      org TEXT NOT NULL DEFAULT '',
      project TEXT,
      needs_approval INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      notes TEXT,
      source_file TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      source_file TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      data TEXT,
      message TEXT,
      source_file TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      status TEXT,
      current_task TEXT,
      mode TEXT,
      last_heartbeat TEXT,
      loop_interval INTEGER,
      uptime_seconds INTEGER
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS cost_entries (
      id SERIAL PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source_file TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS totp_recovery_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      source_file TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sync_meta (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      last_synced TEXT NOT NULL DEFAULT (NOW()::TEXT)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at BIGINT NOT NULL
    )
  `;

  // Indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_org ON events(org)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent)`;
}

export async function isDatabaseReady(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
