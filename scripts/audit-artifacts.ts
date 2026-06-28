import { existsSync, readdirSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { homedir } from 'os';

import { logEvent } from '../src/bus/event';
import { sendMessage } from '../src/bus/message';
import { resolveEnv } from '../src/utils/env';
import { resolvePaths } from '../src/utils/paths';

const ARTIFACT_EXTENSIONS = new Set(['.md', '.pdf', '.html']);
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_TMP_ROOT = '/tmp';

export interface ReadonlyStat {
  isDirectory(): boolean;
  isFile(): boolean;
  mtimeMs: number;
}

export interface ReadonlyFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  statSync(path: string): ReadonlyStat;
}

export interface ScanRoot {
  path: string;
  recursive: boolean;
}

export interface CandidateArtifact {
  path: string;
  basename: string;
  mtimeMs: number;
  sourceRoot: string;
}

export interface AuditPaths {
  frameworkRoot: string;
  knowledgeSyncRoot: string;
  tmpRoot: string;
}

export interface AuditResult {
  candidates: CandidateArtifact[];
  vaultBasenames: Set<string>;
  unsavedArtifacts: CandidateArtifact[];
}

const nodeFs: ReadonlyFs = {
  existsSync,
  readdirSync: (path: string) => readdirSync(path),
  statSync,
};

function hasArtifactExtension(path: string): boolean {
  return ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase());
}

function normalizeBasename(path: string): string {
  return basename(path).toLowerCase();
}

function safeExists(fs: ReadonlyFs, path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function safeStat(fs: ReadonlyFs, path: string): ReadonlyStat | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

function walkFiles(
  fs: ReadonlyFs,
  root: string,
  recursive: boolean,
  visit: (filePath: string, stat: ReadonlyStat) => void,
): void {
  if (!safeExists(fs, root)) return;

  const rootStat = safeStat(fs, root);
  if (!rootStat?.isDirectory()) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(root, entry);
    const entryStat = safeStat(fs, fullPath);
    if (!entryStat) continue;

    if (entryStat.isDirectory()) {
      if (recursive) walkFiles(fs, fullPath, true, visit);
      continue;
    }

    if (entryStat.isFile()) visit(fullPath, entryStat);
  }
}

export function buildScanRoots(paths: AuditPaths, fs: ReadonlyFs = nodeFs): ScanRoot[] {
  const roots: ScanRoot[] = [{ path: paths.tmpRoot, recursive: false }];

  const orgsDir = join(paths.frameworkRoot, 'orgs');
  if (safeExists(fs, orgsDir)) {
    let orgs: string[] = [];
    try {
      orgs = fs.readdirSync(orgsDir);
    } catch {
      orgs = [];
    }

    for (const orgName of orgs) {
      const agentsDir = join(orgsDir, orgName, 'agents');
      if (!safeExists(fs, agentsDir)) continue;

      let agents: string[] = [];
      try {
        agents = fs.readdirSync(agentsDir);
      } catch {
        agents = [];
      }

      for (const agentName of agents) {
        roots.push({ path: join(agentsDir, agentName, 'state'), recursive: true });
        roots.push({ path: join(agentsDir, agentName, 'drafts'), recursive: true });
      }
    }
  }

  const areasDir = join(paths.knowledgeSyncRoot, 'raw', 'areas');
  if (safeExists(fs, areasDir)) {
    let areas: string[] = [];
    try {
      areas = fs.readdirSync(areasDir);
    } catch {
      areas = [];
    }

    for (const areaName of areas) {
      roots.push({ path: join(areasDir, areaName, 'drafts'), recursive: true });
      roots.push({ path: join(areasDir, areaName, 'proposals'), recursive: true });
    }
  }

  return roots;
}

export function collectVaultBasenames(
  rawRoot: string,
  fs: ReadonlyFs = nodeFs,
): Set<string> {
  const basenames = new Set<string>();

  walkFiles(fs, rawRoot, true, (filePath) => {
    if (!hasArtifactExtension(filePath)) return;
    basenames.add(normalizeBasename(filePath));
  });

  return basenames;
}

export function collectRecentCandidates(
  scanRoots: ScanRoot[],
  sinceMs: number,
  fs: ReadonlyFs = nodeFs,
): CandidateArtifact[] {
  const candidates: CandidateArtifact[] = [];

  for (const root of scanRoots) {
    walkFiles(fs, root.path, root.recursive, (filePath, fileStat) => {
      if (!hasArtifactExtension(filePath)) return;
      if (fileStat.mtimeMs < sinceMs) return;

      candidates.push({
        path: filePath,
        basename: basename(filePath),
        mtimeMs: fileStat.mtimeMs,
        sourceRoot: root.path,
      });
    });
  }

  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return candidates;
}

export function findUnsavedArtifacts(
  candidates: CandidateArtifact[],
  vaultBasenames: Set<string>,
): CandidateArtifact[] {
  return candidates.filter(candidate => !vaultBasenames.has(normalizeBasename(candidate.basename)));
}

export function runArtifactAudit(
  paths: AuditPaths,
  nowMs = Date.now(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  fs: ReadonlyFs = nodeFs,
): AuditResult {
  const sinceMs = nowMs - lookbackHours * 60 * 60 * 1000;
  const scanRoots = buildScanRoots(paths, fs);
  const vaultBasenames = collectVaultBasenames(join(paths.knowledgeSyncRoot, 'raw'), fs);
  const candidates = collectRecentCandidates(scanRoots, sinceMs, fs);
  const unsavedArtifacts = findUnsavedArtifacts(candidates, vaultBasenames);
  return { candidates, vaultBasenames, unsavedArtifacts };
}

export function buildAuditMessage(
  artifacts: CandidateArtifact[],
  lookbackHours: number,
): string {
  const lines = [
    `Artifact audit found ${artifacts.length} candidate unsaved artifact(s) in the last ${lookbackHours}h.`,
    'Heuristic only: basename absent from ~/code/knowledge-sync/raw/.',
    '',
  ];

  for (const artifact of artifacts) {
    lines.push(`- ${artifact.basename}`);
    lines.push(`  path: ${artifact.path}`);
  }

  return lines.join('\n');
}

interface CliOptions extends AuditPaths {
  lookbackHours: number;
}

function parseArgs(argv: string[]): CliOptions {
  const frameworkRoot =
    process.env.CTX_FRAMEWORK_ROOT ||
    process.env.CTX_PROJECT_ROOT ||
    process.cwd();
  const knowledgeSyncRoot = join(homedir(), 'code', 'knowledge-sync');

  let resolvedFrameworkRoot = frameworkRoot;
  let resolvedKnowledgeSyncRoot = knowledgeSyncRoot;
  let resolvedTmpRoot = DEFAULT_TMP_ROOT;
  let resolvedLookbackHours = DEFAULT_LOOKBACK_HOURS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--framework-root' && argv[i + 1]) {
      resolvedFrameworkRoot = argv[++i];
      continue;
    }
    if (arg === '--knowledge-sync-root' && argv[i + 1]) {
      resolvedKnowledgeSyncRoot = argv[++i];
      continue;
    }
    if (arg === '--tmp-root' && argv[i + 1]) {
      resolvedTmpRoot = argv[++i];
      continue;
    }
    if (arg === '--lookback-hours' && argv[i + 1]) {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next > 0) resolvedLookbackHours = next;
    }
  }

  return {
    frameworkRoot: resolvedFrameworkRoot,
    knowledgeSyncRoot: resolvedKnowledgeSyncRoot,
    tmpRoot: resolvedTmpRoot,
    lookbackHours: resolvedLookbackHours,
  };
}

const isMain = (() => {
  try {
    return Boolean(typeof require !== 'undefined' && require.main === module);
  } catch {
    return false;
  }
})();

if (isMain) {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const options = parseArgs(process.argv.slice(2));
  const result = runArtifactAudit(options);

  if (result.unsavedArtifacts.length === 0) {
    logEvent(
      paths,
      env.agentName,
      env.org,
      'action',
      'artifact_audit_passed',
      'info',
      { scanned: result.candidates.length, lookback_hours: options.lookbackHours },
    );
    console.log('artifact audit passed: 0 candidate unsaved artifacts');
    process.exit(0);
  }

  const message = buildAuditMessage(result.unsavedArtifacts, options.lookbackHours);
  sendMessage(paths, env.agentName, 'larry', 'normal', message);
  sendMessage(paths, env.agentName, 'frank2', 'normal', message);
  logEvent(
    paths,
    env.agentName,
    env.org,
    'action',
    'artifact_audit_reported',
    'info',
    { findings: result.unsavedArtifacts.length, lookback_hours: options.lookbackHours },
  );
  console.log(`artifact audit reported ${result.unsavedArtifacts.length} candidate unsaved artifacts`);
}
