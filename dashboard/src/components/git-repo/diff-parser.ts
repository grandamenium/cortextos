export type DiffLineType = 'add' | 'del' | 'context' | 'header' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNum: number | null;
  newNum: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!patch) return hunks;

  const lines = patch.split('\n');
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldCursor = parseInt(m[1], 10);
        newCursor = parseInt(m[2], 10);
        current = {
          header: line,
          oldStart: oldCursor,
          newStart: newCursor,
          lines: [],
        };
        hunks.push(current);
      }
      continue;
    }
    if (!current) continue;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('Binary files')
    ) {
      continue;
    }

    if (line.startsWith('+')) {
      current.lines.push({
        type: 'add',
        content: line.slice(1),
        oldNum: null,
        newNum: newCursor,
      });
      newCursor++;
    } else if (line.startsWith('-')) {
      current.lines.push({
        type: 'del',
        content: line.slice(1),
        oldNum: oldCursor,
        newNum: null,
      });
      oldCursor++;
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({
        type: 'context',
        content: line.slice(1),
        oldNum: oldCursor,
        newNum: newCursor,
      });
      oldCursor++;
      newCursor++;
    } else if (line.startsWith('\\')) {
      current.lines.push({ type: 'meta', content: line, oldNum: null, newNum: null });
    }
  }

  return hunks;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  mdx: 'mdx',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
};

export function languageFromPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  if (base === 'Dockerfile') return 'docker';
  if (base.endsWith('.gitignore') || base === '.env') return 'text';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_TO_LANG[ext] ?? 'text';
}
