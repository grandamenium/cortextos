'use client';

import { useEffect, useState } from 'react';
import {
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconFileText,
} from '@tabler/icons-react';

export type TreeNode =
  | {
      kind: 'dir';
      name: string;
      relPath: string;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      relPath: string;
      mtimeMs: number;
    };

interface FolderTreeProps {
  nodes: TreeNode[];
  selected: string | null;
  onSelectFile: (relPath: string) => void;
  /** sessionStorage key for persisting expanded state across reloads */
  storageKey?: string;
}

export function FolderTree({
  nodes,
  selected,
  onSelectFile,
  storageKey = 'wiki:expanded',
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set(['00-inbox']);
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return new Set(['00-inbox']);
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set(['00-inbox']);
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      /* sessionStorage unavailable — fall through silently */
    }
  }, [expanded, storageKey]);

  // When selecting a file, auto-expand its ancestor dirs so it's visible
  useEffect(() => {
    if (!selected) return;
    const parts = selected.split('/');
    if (parts.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc);
      }
      return next;
    });
  }, [selected]);

  const toggle = (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        Empty vault.
      </div>
    );
  }

  return (
    <div role="tree" aria-label="Vault file tree" className="text-sm">
      {nodes.map((node) => (
        <TreeRow
          key={node.relPath}
          node={node}
          depth={0}
          expanded={expanded}
          selected={selected}
          onToggle={toggle}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (relPath: string) => void;
  onSelectFile: (relPath: string) => void;
}) {
  // 12px per depth level — aligns with the dashboard's 4/8dp spacing rhythm
  // while staying readable inside the 280–360px sidebar pane.
  const padLeft = 8 + depth * 12;

  if (node.kind === 'dir') {
    const isOpen = expanded.has(node.relPath);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggle(node.relPath)}
          role="treeitem"
          aria-expanded={isOpen}
          aria-level={depth + 1}
          className="w-full flex items-center gap-1.5 py-1 hover:bg-accent/40 rounded transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ paddingLeft: padLeft }}
        >
          <IconChevronRight
            size={14}
            strokeWidth={2}
            className={`text-muted-foreground shrink-0 transition-transform ${
              isOpen ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          />
          {isOpen ? (
            <IconFolderOpen size={15} className="text-amber-500/80 shrink-0" aria-hidden="true" />
          ) : (
            <IconFolder size={15} className="text-amber-500/80 shrink-0" aria-hidden="true" />
          )}
          <span className="font-mono text-xs truncate">{node.name}</span>
          {node.children.length > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground pr-1.5">
              {node.children.length}
            </span>
          )}
        </button>
        {isOpen && (
          <div role="group">
            {node.children.map((child) => (
              <TreeRow
                key={child.relPath}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  const isSelected = selected === node.relPath;
  const display = node.name.replace(/\.md$/, '');

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.relPath)}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      className={`w-full flex items-center gap-1.5 py-1 rounded transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        isSelected
          ? 'bg-accent text-foreground'
          : 'hover:bg-accent/40 text-foreground/90'
      }`}
      // Indent file rows so they line up under their parent dir's contents
      // (i.e. past the chevron+folder-icon column of the dir above).
      style={{ paddingLeft: padLeft + 16 }}
    >
      <IconFileText size={14} className="text-muted-foreground/70 shrink-0" aria-hidden="true" />
      <span className="font-mono text-xs truncate">{display}</span>
    </button>
  );
}
