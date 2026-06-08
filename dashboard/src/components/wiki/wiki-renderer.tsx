'use client';

import React from 'react';

/**
 * Wikilink-aware markdown renderer for the dashboard /wiki page.
 *
 * Mirrors the shape of @/lib/render-markdown.tsx but extends inline parsing
 * to handle [[wikilink]] references and routes them through onWikilink. We
 * keep this purpose-specific so the global renderMarkdown stays simple.
 */

interface WikiRendererProps {
  text: string;
  onWikilink: (slug: string) => void;
}

export function WikiRenderer({ text, onWikilink }: WikiRendererProps) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const key = () => keyCounter++;

  const renderInline = (line: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    // Order: wikilinks before plain links so [[ doesn't get eaten by [
    const re =
      /(\[\[([^\]]+)\]\]|\*\*(.+?)\*\*|\*([^*]+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[2] !== undefined) {
        const slug = m[2].trim();
        // <a> instead of <button> — HTML allows <a> inside <p> but not <button>.
        // href="#" + preventDefault keeps the link semantic without navigating.
        parts.push(
          <a
            key={key()}
            href="#"
            role="link"
            onClick={(e) => {
              e.preventDefault();
              onWikilink(slug);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm cursor-pointer"
          >
            {slug}
          </a>,
        );
      } else if (m[3] !== undefined) {
        parts.push(<strong key={key()}>{m[3]}</strong>);
      } else if (m[4] !== undefined) {
        parts.push(<em key={key()}>{m[4]}</em>);
      } else if (m[5] !== undefined) {
        parts.push(
          <code
            key={key()}
            className="bg-muted px-1 py-0.5 rounded text-xs font-mono"
          >
            {m[5]}
          </code>,
        );
      } else if (m[6] !== undefined) {
        parts.push(
          <a
            key={key()}
            href={m[7]}
            className="text-primary underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {m[6]}
          </a>,
        );
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts.length === 1 ? parts[0] : <>{parts}</>;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre
          key={key()}
          className="bg-muted rounded-md p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre-wrap"
        >
          {lang && (
            <span className="text-muted-foreground text-[10px] block mb-1">
              {lang}
            </span>
          )}
          {codeLines.join('\n')}
        </pre>,
      );
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key()} className="border-muted my-3" />);
      i++;
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) {
      nodes.push(
        <h3 key={key()} className="text-sm font-semibold mt-4 mb-1">
          {renderInline(h3[1])}
        </h3>,
      );
      i++;
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      nodes.push(
        <h2
          key={key()}
          className="text-base font-semibold mt-5 mb-2 pb-1 border-b"
        >
          {renderInline(h2[1])}
        </h2>,
      );
      i++;
      continue;
    }
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      nodes.push(
        <h1 key={key()} className="text-lg font-bold mt-4 mb-2">
          {renderInline(h1[1])}
        </h1>,
      );
      i++;
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(
          <li key={key()} className="ml-4 text-sm">
            {renderInline(lines[i].replace(/^[-*] /, ''))}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ul key={key()} className="list-disc list-inside space-y-0.5 my-1">
          {items}
        </ul>,
      );
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(
          <li key={key()} className="ml-4 text-sm">
            {renderInline(lines[i].replace(/^\d+\. /, ''))}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ol key={key()} className="list-decimal list-inside space-y-0.5 my-1">
          {items}
        </ol>,
      );
      continue;
    }

    if (line.trim() === '') {
      nodes.push(<div key={key()} className="h-2" />);
      i++;
      continue;
    }

    nodes.push(
      <p key={key()} className="text-sm leading-relaxed">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return <>{nodes}</>;
}
