'use client';

import type { Highlighter, BundledLanguage } from 'shiki';

const SUPPORTED_LANGS: BundledLanguage[] = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'scss',
  'html',
  'markdown',
  'mdx',
  'bash',
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'yaml',
  'toml',
  'sql',
  'xml',
  'docker',
];

let highlighterPromise: Promise<Highlighter> | null = null;

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: SUPPORTED_LANGS,
      }),
    );
  }
  return highlighterPromise;
}

export function isSupportedLang(lang: string): lang is BundledLanguage {
  return (SUPPORTED_LANGS as string[]).includes(lang);
}

export async function highlightLine(
  line: string,
  lang: string,
  theme: 'github-dark' | 'github-light',
): Promise<string> {
  if (!isSupportedLang(lang) || !line) return escapeHtml(line);
  const h = await getHighlighter();
  try {
    const html = h.codeToHtml(line, { lang, theme });
    const inner = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (!inner) return escapeHtml(line);
    return inner[1].replace(/<\/?span class="line"[^>]*>/g, '');
  } catch {
    return escapeHtml(line);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
