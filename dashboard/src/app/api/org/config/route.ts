import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';
  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid or missing org' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) {
    return Response.json({ error: 'context.json not found' }, { status: 404 });
  }
  try {
    const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
    return Response.json({ config: ctx, org });
  } catch {
    return Response.json({ error: 'Failed to read context.json' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';
  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid or missing org' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) {
    return Response.json({ error: 'context.json not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate editable fields
  const allowed = ['timezone', 'day_mode_start', 'day_mode_end', 'default_approval_categories', 'communication_style', 'name', 'description', 'industry', 'icp', 'value_prop', 'require_deliverables'];
  const timeRegex = /^\d{2}:\d{2}$/;

  if (body.day_mode_start && !timeRegex.test(body.day_mode_start as string)) {
    return Response.json({ error: 'day_mode_start must be HH:MM' }, { status: 400 });
  }
  if (body.day_mode_end && !timeRegex.test(body.day_mode_end as string)) {
    return Response.json({ error: 'day_mode_end must be HH:MM' }, { status: 400 });
  }
  if (body.require_deliverables !== undefined && typeof body.require_deliverables !== 'boolean') {
    return Response.json({ error: 'require_deliverables must be a boolean' }, { status: 400 });
  }
  if (body.default_approval_categories !== undefined) {
    const dac = body.default_approval_categories;
    if (!Array.isArray(dac)) {
      return Response.json({ error: 'default_approval_categories must be an array' }, { status: 400 });
    }
    if (!(dac as unknown[]).every((el) => typeof el === 'string' && el.length > 0)) {
      return Response.json(
        { error: 'default_approval_categories must be an array of non-empty strings' },
        { status: 400 },
      );
    }
  }

  try {
    const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
    for (const key of allowed) {
      if (body[key] !== undefined) ctx[key] = body[key];
    }
    writeFileSync(contextPath, JSON.stringify(ctx, null, 2) + '\n', 'utf-8');

    // Trigger sync to all running agents — fire-and-forget so response is not blocked.
    // Keep using bash script here: `bus sync-org-config` CLI subcommand does not exist yet.
    // On Windows this will silently fail (no bash) — acceptable for a non-critical sync.
    const syncScript = join(frameworkRoot, 'bus', 'sync-org-config.sh');
    if (existsSync(syncScript)) {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_ORG: org };
      if (process.env.CTX_ROOT) childEnv.CTX_ROOT = process.env.CTX_ROOT;
      if (process.env.CTX_INSTANCE_ID) childEnv.CTX_INSTANCE_ID = process.env.CTX_INSTANCE_ID;
      import('child_process').then(({ spawn }) => {
        const child = spawn('bash', [syncScript, '--org', org], { env: childEnv, stdio: 'pipe' });
        child.on('error', (err) => console.error('[api/org/config] sync-org-config.sh spawn error:', err));
        child.on('exit', (code) => { if (code !== 0) console.error(`[api/org/config] sync-org-config.sh exited ${code}`); });
      }).catch((err) => console.error('[api/org/config] child_process import failed:', err));
    }

    return Response.json({ success: true, config: ctx, org });
  } catch {
    return Response.json({ error: 'Failed to write context.json' }, { status: 500 });
  }
}
