'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { IconChevronDown, IconChevronRight, IconCircleDot } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { DiffFile, FileStatus } from './types';
import { parsePatch, languageFromPath } from './diff-parser';
import { highlightLine } from './highlighter';

interface FileDiffProps {
  file: DiffFile;
  defaultExpanded?: boolean;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  other: 'changed',
};

const STATUS_CLASSES: Record<FileStatus, string> = {
  added: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  modified: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  deleted: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30',
  renamed: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
  copied: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
  other: 'bg-muted text-muted-foreground border-border',
};

export function FileDiff({ file, defaultExpanded = true }: FileDiffProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { resolvedTheme } = useTheme();
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  const hunks = expanded ? parsePatch(file.patch) : [];
  const lang = languageFromPath(file.path);

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 border-b bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? (
          <IconChevronDown size={14} className="text-muted-foreground shrink-0" />
        ) : (
          <IconChevronRight size={14} className="text-muted-foreground shrink-0" />
        )}
        <span className="font-mono text-[12.5px] truncate flex-1">
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              <span className="text-muted-foreground">{file.oldPath}</span>
              <span className="mx-1 text-muted-foreground/60">→</span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
            STATUS_CLASSES[file.status],
          )}
        >
          {STATUS_LABEL[file.status]}
        </span>
        <span className="text-[11px] tabular-nums text-emerald-600/90 dark:text-emerald-400/90">
          +{file.additions}
        </span>
        <span className="text-[11px] tabular-nums text-red-600/90 dark:text-red-400/90">
          −{file.deletions}
        </span>
      </button>

      {expanded && (
        <div>
          {file.binary ? (
            <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2">
              <IconCircleDot size={12} />
              Binary file — no diff preview
            </div>
          ) : hunks.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              No textual diff (file may be too large or empty).
            </div>
          ) : (
            <div className="font-mono text-[12.5px] leading-[1.45]">
              {hunks.map((hunk, hi) => (
                <div key={hi}>
                  <div className="px-3 py-1 bg-muted/40 text-[11px] text-muted-foreground border-y">
                    {hunk.header}
                  </div>
                  {hunk.lines.map((line, li) => (
                    <DiffLineRow
                      key={`${hi}-${li}`}
                      type={line.type}
                      content={line.content}
                      oldNum={line.oldNum}
                      newNum={line.newNum}
                      lang={lang}
                      theme={theme}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface DiffLineRowProps {
  type: 'add' | 'del' | 'context' | 'header' | 'meta';
  content: string;
  oldNum: number | null;
  newNum: number | null;
  lang: string;
  theme: 'github-dark' | 'github-light';
}

function DiffLineRow({ type, content, oldNum, newNum, lang, theme }: DiffLineRowProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (type === 'meta') {
      setHighlighted(null);
      return;
    }
    highlightLine(content, lang, theme).then((html) => {
      if (!cancelled) setHighlighted(html);
    });
    return () => {
      cancelled = true;
    };
  }, [content, lang, theme, type]);

  const bg =
    type === 'add'
      ? 'bg-emerald-500/[0.08]'
      : type === 'del'
        ? 'bg-red-500/[0.08]'
        : '';
  const marker = type === 'add' ? '+' : type === 'del' ? '−' : ' ';
  const markerColor =
    type === 'add'
      ? 'text-emerald-600 dark:text-emerald-400'
      : type === 'del'
        ? 'text-red-600 dark:text-red-400'
        : 'text-muted-foreground/40';

  return (
    <div className={cn('flex', bg)}>
      <span className="select-none w-10 shrink-0 text-right pr-1 text-[10.5px] tabular-nums text-muted-foreground/60 border-r border-border/40">
        {oldNum ?? ''}
      </span>
      <span className="select-none w-10 shrink-0 text-right pr-1 text-[10.5px] tabular-nums text-muted-foreground/60 border-r border-border/40">
        {newNum ?? ''}
      </span>
      <span className={cn('select-none w-5 shrink-0 text-center', markerColor)}>{marker}</span>
      <pre className="flex-1 whitespace-pre overflow-x-auto px-2 py-0">
        {highlighted !== null ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{content}</code>
        )}
      </pre>
    </div>
  );
}
