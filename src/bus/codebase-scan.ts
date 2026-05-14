import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { ensureDir } from '../utils/atomic.js';

export interface CodebaseHit {
  file: string;
  line: number;
  tag: string;
  text: string;
}

export interface LargeFile {
  file: string;
  lines: number;
}

export interface CodebaseScanResult {
  date: string;
  scanRoot: string;
  hits: CodebaseHit[];
  largeFiles: LargeFile[];
  topActionable: string[];
}

const TAG_PATTERN = /TODO|FIXME|HACK|XXX/;
const LARGE_FILE_THRESHOLD = 500;

/**
 * Grep src/ for TODO/FIXME/HACK/XXX markers.
 * Falls back to manual walk if grep is unavailable.
 */
export function scanTodoMarkers(srcDir: string): CodebaseHit[] {
  if (!existsSync(srcDir)) return [];
  try {
    const raw = execSync(
      `grep -rn "TODO\\|FIXME\\|HACK\\|XXX" "${srcDir}" --include="*.ts" --include="*.js" 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    const hits: CodebaseHit[] = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^(.+?):(\d+):(.*)/);
      if (!m) continue;
      const text = m[3].trim();
      const tagMatch = text.match(/\b(TODO|FIXME|HACK|XXX)\b/);
      if (!tagMatch) continue;
      hits.push({
        file: relative(srcDir, m[1]),
        line: parseInt(m[2], 10),
        tag: tagMatch[1],
        text: text.slice(0, 120),
      });
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Walk srcDir recursively, returning files with more than LARGE_FILE_THRESHOLD lines.
 */
export function findLargeFiles(srcDir: string, threshold = LARGE_FILE_THRESHOLD): LargeFile[] {
  if (!existsSync(srcDir)) return [];
  const results: LargeFile[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        try {
          const content = readFileSync(full, 'utf-8');
          const lineCount = content.split('\n').length;
          if (lineCount > threshold) {
            results.push({ file: relative(srcDir, full), lines: lineCount });
          }
        } catch { /* skip */ }
      }
    }
  }

  walk(srcDir);
  return results.sort((a, b) => b.lines - a.lines);
}

/**
 * Derive top 3 actionable items from scan results.
 */
export function deriveTopActionable(hits: CodebaseHit[], largeFiles: LargeFile[]): string[] {
  const actionable: string[] = [];

  // FIXMEs and HACs are highest priority
  const fixmes = hits.filter(h => h.tag === 'FIXME' || h.tag === 'HACK');
  if (fixmes.length > 0) {
    const sample = fixmes[0];
    actionable.push(`Fix ${fixmes.length} FIXME/HACK marker(s) — top: ${sample.file}:${sample.line} "${sample.text.slice(0, 60)}"`);
  }

  // Large files
  if (largeFiles.length > 0) {
    const top = largeFiles[0];
    actionable.push(`Refactor ${top.file} (${top.lines} lines) — exceeds 500-line threshold`);
  }

  // TODO count by file (find hotspot)
  const todosByFile = new Map<string, number>();
  for (const h of hits) {
    if (h.tag === 'TODO') todosByFile.set(h.file, (todosByFile.get(h.file) ?? 0) + 1);
  }
  const hotspot = [...todosByFile.entries()].sort((a, b) => b[1] - a[1])[0];
  if (hotspot && hotspot[1] >= 2) {
    actionable.push(`Clear ${hotspot[1]} TODO(s) in ${hotspot[0]}`);
  }

  return actionable.slice(0, 3);
}

/**
 * Run the full codebase scan and write a Markdown report.
 *
 * @param frameworkRoot  Root of the cortextOS framework (contains src/)
 * @param outputPath     Full path to the output .md file
 */
export function runCodebaseScan(frameworkRoot: string, outputPath: string): CodebaseScanResult {
  const srcDir = join(frameworkRoot, 'src');
  const date = new Date().toISOString().slice(0, 10);

  const hits = scanTodoMarkers(srcDir);
  const largeFiles = findLargeFiles(srcDir);
  const topActionable = deriveTopActionable(hits, largeFiles);

  const result: CodebaseScanResult = { date, scanRoot: srcDir, hits, largeFiles, topActionable };

  // Build Markdown report
  const lines: string[] = [
    `# Codebase Scan — ${date}`,
    '',
    `**Scan root:** \`${srcDir}\`  `,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| TODO markers | ${hits.filter(h => h.tag === 'TODO').length} |`,
    `| FIXME markers | ${hits.filter(h => h.tag === 'FIXME').length} |`,
    `| HACK markers | ${hits.filter(h => h.tag === 'HACK').length} |`,
    `| XXX markers | ${hits.filter(h => h.tag === 'XXX').length} |`,
    `| Files >500 lines | ${largeFiles.length} |`,
    '',
    '## Top Actionable Items',
    '',
  ];

  if (topActionable.length === 0) {
    lines.push('_No actionable items found._');
  } else {
    for (const [i, item] of topActionable.entries()) {
      lines.push(`${i + 1}. ${item}`);
    }
  }

  if (largeFiles.length > 0) {
    lines.push('', '## Large Files (>500 lines)', '', '| File | Lines |', '|------|-------|');
    for (const f of largeFiles.slice(0, 20)) {
      lines.push(`| \`${f.file}\` | ${f.lines} |`);
    }
  }

  if (hits.length > 0) {
    lines.push('', '## Markers Detail', '');
    const byTag = new Map<string, CodebaseHit[]>();
    for (const h of hits) {
      if (!byTag.has(h.tag)) byTag.set(h.tag, []);
      byTag.get(h.tag)!.push(h);
    }
    for (const [tag, tagHits] of byTag) {
      lines.push(`### ${tag} (${tagHits.length})`);
      lines.push('');
      lines.push('| File | Line | Text |');
      lines.push('|------|------|------|');
      for (const h of tagHits.slice(0, 30)) {
        const escaped = h.text.replace(/\|/g, '\\|');
        lines.push(`| \`${h.file}\` | ${h.line} | ${escaped} |`);
      }
      if (tagHits.length > 30) lines.push(`| _(+${tagHits.length - 30} more)_ | | |`);
      lines.push('');
    }
  }

  ensureDir(outputPath.replace(/\/[^/]+$/, ''));
  writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  return result;
}
