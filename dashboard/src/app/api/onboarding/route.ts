import fs from 'fs/promises';
import path from 'path';
import { getCTXRoot, getFrameworkRoot, getOrgs } from '@/lib/config';
import { getHermesHome } from '@/lib/agent-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const onboardedPath = () => path.join(getCTXRoot(), '.onboarded');

export async function GET() {
  const onboarded = await fs.access(onboardedPath()).then(() => true).catch(() => false);
  const hermesConfig = await fs.readFile(path.join(getHermesHome(), 'config.yaml'), 'utf-8').catch(() => '');
  const providersDetected = /providers\s*:/i.test(hermesConfig);
  const orgs = getOrgs();
  return Response.json({
    onboarded,
    providersDetected,
    orgs,
    paths: {
      onboarded: onboardedPath(),
      hermesConfig: path.join(getHermesHome(), 'config.yaml'),
      orgs: path.join(getFrameworkRoot(), 'orgs'),
    },
  });
}

export async function POST() {
  await fs.mkdir(path.dirname(onboardedPath()), { recursive: true });
  await fs.writeFile(onboardedPath(), new Date().toISOString(), 'utf-8');
  return Response.json({ ok: true, onboarded: true });
}
