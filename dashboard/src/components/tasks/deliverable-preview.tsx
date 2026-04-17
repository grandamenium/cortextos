'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { Button } from '@/components/ui/button';
import { IconX, IconFolderOpen, IconZoomIn, IconZoomOut, IconCode, IconBrowser } from '@tabler/icons-react';
import type { TaskOutput } from '@/lib/types';

interface DeliverablePreviewProps {
  output: TaskOutput;
  onClose: () => void;
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;
const MD_EXTS = /\.md$/i;
const HTML_EXTS = /\.html?$/i;
const CODE_EXTS = /\.(ts|tsx|js|jsx|json|css|sh|txt|csv|log|yaml|yml|toml|py)$/i;

// File reference patterns for auto-linking inside rendered markdown.
// Matches relative paths, Windows drive-letter paths, and Unix absolute paths.
// The /api/media route's allowed-roots + realpath check is the authoritative
// security enforcement; this regex is a first-pass filter.
const FILE_REF_EXTS = 'md|html|png|jpg|jpeg|gif|webp|json|csv|txt|ts|tsx|js|jsx|css|ogg|mp4|mp3|pdf|wav|opus';
const FILE_REF_RE = new RegExp(`^[\\w\\-./]+\\.(${FILE_REF_EXTS})$`, 'i');
const ABSOLUTE_DRIVE_RE = /^[a-z]:[\\/]/i;
const ABSOLUTE_UNIX_RE = /^\//;
const EXTERNAL_SCHEME_RE = /^(https?|mailto|tel|ftp|ws|wss|data|blob):/i;

/**
 * Classify a candidate file reference string as 'skip', 'relative', or
 * 'absolute'. Used by the markdown walker to decide which code spans and
 * anchor tags to make clickable for the overlay viewer.
 */
function classifyFileRef(raw: string): 'skip' | 'relative' | 'absolute' {
  const ref = raw.trim();
  if (!ref) return 'skip';
  if (ref.includes('..')) return 'skip';
  if (EXTERNAL_SCHEME_RE.test(ref)) return 'skip';
  if (ABSOLUTE_DRIVE_RE.test(ref) || ABSOLUTE_UNIX_RE.test(ref)) return 'absolute';
  if (FILE_REF_RE.test(ref)) return 'relative';
  return 'skip';
}

function getMediaUrl(value: string, render?: boolean): string {
  const segments = value.split('/').map(s => encodeURIComponent(s)).join('/');
  const base = `/api/media/${segments}`;
  return render ? `${base}?render=true` : base;
}

function PreviewLoading() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Loading preview...
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full text-destructive text-sm">
      {message}
    </div>
  );
}

function ImagePreview({ src }: { src: string }) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-end p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setZoomed(!zoomed)}
          title={zoomed ? 'Zoom out' : 'Zoom in'}
        >
          {zoomed ? <IconZoomOut size={16} /> : <IconZoomIn size={16} />}
        </Button>
      </div>
      <div className={`flex-1 overflow-auto p-4 ${zoomed ? '' : 'flex items-center justify-center'}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Deliverable preview"
          className={zoomed ? 'w-full' : 'max-w-full max-h-full object-contain'}
        />
      </div>
    </div>
  );
}

function RenderedMdPreview({
  src,
  parentPath,
  onFileRefClick,
}: {
  src: string;
  parentPath: string;
  onFileRefClick: (resolvedPath: string, displayLabel: string) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(src)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(setHtml)
      .catch(e => setError(e.message));
  }, [src]);

  // Walk the rendered HTML for <code> spans and <a> tags that look like
  // file references. Patch each with a click handler that opens the file
  // in the overlay viewer. A MutationObserver re-runs the patch on DOM
  // changes so React re-renders keep the handlers attached.
  useEffect(() => {
    if (!containerRef.current || html === null) return;
    const container = containerRef.current;
    const parentDir = parentPath.includes('/')
      ? parentPath.slice(0, parentPath.lastIndexOf('/'))
      : '';

    const listeners: Array<() => void> = [];

    function candidatesFor(ref: string, kind: 'relative' | 'absolute'): string[] {
      if (kind === 'absolute') return [ref];
      const out: string[] = [];
      if (parentDir) out.push(`${parentDir}/${ref}`);
      out.push(ref);
      return out;
    }

    function makeOpenHandler(el: HTMLElement, ref: string, label: string, kind: 'relative' | 'absolute') {
      const candidates = candidatesFor(ref, kind);
      return async (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        for (const candidate of candidates) {
          try {
            const segments = candidate.split('/').map(s => encodeURIComponent(s)).join('/');
            const r = await fetch(`/api/media/${segments}`, { method: 'HEAD' });
            if (r.ok) {
              onFileRefClick(candidate, label);
              return;
            }
            console.warn(`[file-ref] HEAD returned ${r.status} for: ${candidate}`);
          } catch (err) {
            console.warn(`[file-ref] HEAD failed for: ${candidate}`, err);
          }
        }
        // All HEAD checks failed. The file may still exist if auth/middleware
        // blocked the HEAD request. Open the first candidate as a fallback —
        // the preview component handles its own load errors.
        console.warn(`[file-ref] All HEAD checks failed for "${ref}". Opening first candidate as fallback.`, candidates);
        el.style.color = 'var(--color-destructive, #ef4444)';
        el.style.textDecoration = 'line-through';
        el.title = `Could not verify: ${ref} — opening anyway`;
        onFileRefClick(candidates[0], label);
      };
    }

    function patchCodeSpans() {
      const codes = container.querySelectorAll('code');
      codes.forEach((codeEl) => {
        const el = codeEl as HTMLElement;
        if (el.dataset.refPatched === 'true') return;
        if (el.closest('pre')) return;
        const text = (el.textContent || '').trim();
        const kind = classifyFileRef(text);
        if (kind === 'skip') return;

        el.style.cursor = 'pointer';
        el.style.textDecoration = 'underline';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.title = `Click to open ${text}`;
        el.dataset.refPatched = 'true';

        const handleOpen = makeOpenHandler(el, text, text, kind);
        el.addEventListener('click', handleOpen);
        listeners.push(() => el.removeEventListener('click', handleOpen));
      });
    }

    function patchAnchors() {
      const anchors = container.querySelectorAll('a');
      anchors.forEach((anchorEl) => {
        const el = anchorEl as HTMLAnchorElement;
        if (el.dataset.refPatched === 'true') return;
        const href = (el.getAttribute('href') || '').trim();
        if (!href) return;
        const kind = classifyFileRef(href);
        if (kind === 'skip') return;

        const label = (el.textContent || href).trim() || href;
        el.title = `Click to open ${href}`;
        el.dataset.refPatched = 'true';
        el.removeAttribute('href');
        el.setAttribute('role', 'button');
        el.style.cursor = 'pointer';

        const handleOpen = makeOpenHandler(el, href, label, kind);
        el.addEventListener('click', handleOpen);
        listeners.push(() => el.removeEventListener('click', handleOpen));
      });
    }

    patchCodeSpans();
    patchAnchors();

    const observer = new MutationObserver(() => {
      patchCodeSpans();
      patchAnchors();
    });
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      listeners.forEach(unsub => unsub());
    };
  }, [html, parentPath, onFileRefClick]);

  // Defense in depth: the server already sanitizes markdown-derived HTML
  // with DOMPurify before returning it. We sanitize again on the client so
  // that any intermediary (proxy, future change) cannot inject script or
  // event-handler vectors into the DOM. Agent-authored markdown is NOT
  // trusted — treat it the same as third-party user content.
  const safeHtml = useMemo(() => {
    if (html === null) return null;
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'formaction'],
    });
  }, [html]);

  if (error) return <PreviewError message={error} />;
  if (safeHtml === null) return <PreviewLoading />;

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-auto p-6 md-preview"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

function HtmlPreview({ src }: { src: string }) {
  const [showSource, setShowSource] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(src)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(setHtmlContent)
      .catch(e => setError(e.message));
  }, [src]);

  if (error) return <PreviewError message={error} />;
  if (htmlContent === null) return <PreviewLoading />;

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-end p-2 gap-1 shrink-0">
        <Button
          variant={showSource ? 'outline' : 'default'}
          size="xs"
          onClick={() => setShowSource(false)}
          title="Rendered page"
        >
          <IconBrowser size={14} />
          <span className="ml-1">Preview</span>
        </Button>
        <Button
          variant={showSource ? 'default' : 'outline'}
          size="xs"
          onClick={() => setShowSource(true)}
          title="View source"
        >
          <IconCode size={14} />
          <span className="ml-1">Source</span>
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        {showSource ? (
          <pre className="text-xs font-mono p-4 overflow-auto h-full whitespace-pre-wrap text-foreground leading-relaxed bg-popover">
            {htmlContent}
          </pre>
        ) : (
          <iframe
            srcDoc={htmlContent}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts"
            title="HTML preview"
          />
        )}
      </div>
    </div>
  );
}

function CodePreview({ src }: { src: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(src)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(setContent)
      .catch(e => setError(e.message));
  }, [src]);

  if (error) return <PreviewError message={error} />;
  if (content === null) return <PreviewLoading />;

  return (
    <pre className="text-xs font-mono p-4 overflow-auto h-full whitespace-pre-wrap text-foreground leading-relaxed bg-popover">
      {content}
    </pre>
  );
}

// Markdown rendering styles — stock upstream palette, no custom colors.
// Injected as a <style> tag only when previewing markdown or code content.
const MD_STYLES = `
.md-preview { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: var(--color-popover-foreground); }
.md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4 { font-weight: 600; margin-top: 1.5em; margin-bottom: 0.5em; color: var(--color-popover-foreground); }
.md-preview h1 { font-size: 1.5em; } .md-preview h2 { font-size: 1.25em; } .md-preview h3 { font-size: 1.1em; }
.md-preview p { margin: 0.75em 0; }
.md-preview code { background: rgba(0,0,0,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
.md-preview pre { background: rgba(0,0,0,0.06); padding: 16px; border-radius: 8px; overflow-x: auto; }
.md-preview pre code { background: none; padding: 0; }
.md-preview a { color: #2563eb; }
.md-preview table { border-collapse: collapse; width: 100%; margin: 1em 0; }
.md-preview th, .md-preview td { border: 1px solid rgba(0,0,0,0.15); padding: 8px 12px; text-align: left; }
.md-preview th { background: rgba(0,0,0,0.04); font-weight: 600; }
.md-preview blockquote { border-left: 3px solid rgba(0,0,0,0.2); margin-left: 0; padding-left: 16px; opacity: 0.8; }
.md-preview hr { border: none; border-top: 1px solid rgba(0,0,0,0.15); margin: 24px 0; }
.md-preview ul, .md-preview ol { padding-left: 24px; }
.md-preview li { margin: 0.25em 0; }
.md-preview strong { font-weight: 600; }
`;

/**
 * Full-height deliverable preview panel. Renders inside the task detail
 * sheet, replacing the detail content when a deliverable is clicked.
 * Supports images (with zoom), markdown (server-rendered HTML), HTML
 * (sandboxed iframe with source toggle), and code/text files.
 */
export function DeliverablePreview({ output, onClose }: DeliverablePreviewProps) {
  const value = output.value;
  const isImage = IMAGE_EXTS.test(value);
  const isMd = MD_EXTS.test(value);
  const isHtml = HTML_EXTS.test(value);
  const isCode = CODE_EXTS.test(value);
  const fileName = value.split('/').pop() || value;
  const currentLabel = output.label || fileName;
  const needsSolidBg = isMd || isCode || isHtml;

  // Overlay: when a file reference is clicked inside rendered markdown,
  // push a nested preview on top of this one.
  const [overlay, setOverlay] = useState<TaskOutput | null>(null);

  const handleFileRefClick = useCallback((resolvedPath: string, displayLabel: string) => {
    setOverlay({ type: 'file', value: resolvedPath, label: displayLabel });
  }, []);

  const handleOpenInTab = useCallback(() => {
    window.open(getMediaUrl(value), '_blank');
  }, [value]);

  // The MD_STYLES string is a static CSS block for markdown rendering.
  // It uses only CSS custom properties from the theme (--color-popover-foreground)
  // and generic system font stacks. Injected via <style> to scope the
  // .md-preview class without requiring a global stylesheet change.
  return (
    <div className={`relative flex flex-col h-full ${needsSolidBg ? 'bg-popover' : ''}`}>
      {needsSolidBg && <style>{MD_STYLES}</style>}

      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0 bg-popover">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate" title={currentLabel}>
            {currentLabel}
          </p>
          <p className="text-[11px] text-muted-foreground truncate font-mono" title={value}>
            {fileName}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleOpenInTab}
            title="Open file in new tab"
          >
            <IconFolderOpen size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            title="Close preview"
          >
            <IconX size={14} />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isImage && <ImagePreview src={getMediaUrl(value)} />}
        {isMd && (
          <RenderedMdPreview
            src={getMediaUrl(value, true)}
            parentPath={value}
            onFileRefClick={handleFileRefClick}
          />
        )}
        {isHtml && <HtmlPreview src={getMediaUrl(value)} />}
        {isCode && <CodePreview src={getMediaUrl(value)} />}
        {!isImage && !isMd && !isHtml && !isCode && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <p className="text-sm">No preview available for this file type</p>
            <Button variant="outline" size="sm" onClick={handleOpenInTab}>
              Open File
            </Button>
          </div>
        )}
      </div>

      {/* Overlay: nested preview for file references clicked inside markdown */}
      {overlay && (
        <div className="absolute inset-0 z-10 bg-popover shadow-2xl">
          <DeliverablePreview
            output={overlay}
            onClose={() => setOverlay(null)}
          />
        </div>
      )}
    </div>
  );
}
