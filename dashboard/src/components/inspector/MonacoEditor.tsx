'use client';

import { useEffect, useRef, useState } from 'react';

type MonacoModule = {
  editor: {
    create(element: HTMLElement, options: Record<string, unknown>): {
      getValue(): string;
      setValue(value: string): void;
      dispose(): void;
      onDidChangeModelContent(cb: () => void): { dispose(): void };
    };
  };
};

export function MonacoEditor({
  value,
  language,
  onChange,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ReturnType<MonacoModule['editor']['create']> | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!hostRef.current || editorRef.current || fallback) return;
    let disposed = false;
    void (async () => {
      try {
        const importer = Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<MonacoModule>;
        const monaco = await importer('monaco-editor');
        if (disposed || !hostRef.current) return;
        const editor = monaco.editor.create(hostRef.current, {
          value,
          language,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: 'on',
          theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
        });
        editor.onDidChangeModelContent(() => onChange(editor.getValue()));
        editorRef.current = editor;
      } catch {
        setFallback(true);
      }
    })();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [fallback]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  if (fallback) {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full w-full resize-none bg-background p-4 font-mono text-sm outline-none"
        spellCheck={false}
      />
    );
  }

  return <div ref={hostRef} className="h-full w-full" />;
}
