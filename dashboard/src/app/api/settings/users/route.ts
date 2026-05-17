import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import bcrypt from 'bcryptjs';

export const dynamic = 'force-dynamic';

interface DbUser {
  id: number;
  username: string;
  created_at: string;
}

export async function GET(_request: NextRequest) {
  try {
    const rows = await sql<DbUser[]>`SELECT id, username, created_at FROM users ORDER BY id`;
    return Response.json({ users: rows.map(r => ({ id: r.id, username: r.username, created_at: r.created_at })) });
  } catch (err) {
    console.error('[api/settings/users] GET error:', err);
    return Response.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    const trimmed = (username ?? '').trim();
    if (!trimmed || trimmed.length < 3) return Response.json({ error: 'Username must be at least 3 characters' }, { status: 400 });
    if (!password || password.length < 12) return Response.json({ error: 'Password must be at least 12 characters' }, { status: 400 });

    const [existing] = await sql<{ id: number }[]>`SELECT id FROM users WHERE username = ${trimmed}`;
    if (existing) return Response.json({ error: 'Username already exists' }, { status: 409 });

    const hash = await bcrypt.hash(password, 12);
    await sql`INSERT INTO users (username, password_hash) VALUES (${trimmed}, ${hash})`;
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/settings/users] POST error:', err);
    return Response.json({ error: 'Failed to add user' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    const [countRow] = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM users`;
    if (Number(countRow?.count ?? 0) <= 1) return Response.json({ error: 'Cannot delete the last user' }, { status: 400 });
    const result = await sql`DELETE FROM users WHERE id = ${id}`;
    if (result.count === 0) return Response.json({ error: 'User not found' }, { status: 404 });
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/settings/users] DELETE error:', err);
    return Response.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
