import React from 'react';

/**
 * Lightweight markdown renderer for dashboard content.
 * Handles: headings, bold, italic, inline code, code blocks, bullets,
 * numbered lists, links, horizontal rules.
 *
 * Extracted from kb-view.tsx for reuse across settings, experiments, etc.
 */
export function renderMarkdown(text: string): React.ReactNode[] {
  // Strip HTML comments before line-splitting. Org-authored files (knowledge.md,
  // brand-voice.md) carry template stubs like `<!-- What does this org do? -->`
  // that should not render as literal text in the UI.
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const key = () => keyCounter++;

  const renderInline = (line: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[2]) parts.push(<strong key={key()}>{m[2]}</strong>);
      else if (m[3]) parts.push(<em key={key()}>{m[3]}</em>);
      else if (m[4]) parts.push(<code key={key()} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{m[4]}</code>);
      else if (m[5]) parts.push(<a key={key()} href={m[6]} className="text-primary underline" target="_blank" rel="noopener noreferrer">{m[5]}</a>);
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts.length === 1 ? parts[0] : <>{parts}</>;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre key={key()} className="bg-muted rounded-md p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre-wrap">
          {lang && <span className="text-muted-foreground text-[10px] block mb-1">{lang}</span>}
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key()} className="border-muted my-3" />);
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    if (h3) { nodes.push(<h3 key={key()} className="text-sm font-semibold mt-4 mb-1">{renderInline(h3[1])}</h3>); i++; continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { nodes.push(<h2 key={key()} className="text-base font-semibold mt-5 mb-2 pb-1 border-b">{renderInline(h2[1])}</h2>); i++; continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { nodes.push(<h1 key={key()} className="text-lg font-bold mt-4 mb-2">{renderInline(h1[1])}</h1>); i++; continue; }

    // Bullet list
    if (/^[-*] /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(<li key={key()} className="ml-4 text-sm">{renderInline(lines[i].replace(/^[-*] /, ''))}</li>);
        i++;
      }
      nodes.push(<ul key={key()} className="list-disc list-inside space-y-0.5 my-1">{items}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(<li key={key()} className="ml-4 text-sm">{renderInline(lines[i].replace(/^\d+\. /, ''))}</li>);
        i++;
      }
      nodes.push(<ol key={key()} className="list-decimal list-inside space-y-0.5 my-1">{items}</ol>);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      nodes.push(<div key={key()} className="h-2" />);
      i++;
      continue;
    }

    // Paragraph
    nodes.push(<p key={key()} className="text-sm leading-relaxed">{renderInline(line)}</p>);
    i++;
  }

  return nodes;
}
