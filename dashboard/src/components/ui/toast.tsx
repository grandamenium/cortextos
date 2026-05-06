'use client';

/**
 * Minimal toast system — portal-mounted, auto-dismiss after 5s.
 *
 * Usage:
 *   import { useToast, ToastContainer } from '@/components/ui/toast';
 *
 *   // In layout or page (render once):
 *   <ToastContainer />
 *
 *   // In any client component:
 *   const { toast } = useToast();
 *   toast({ message: 'Saved!', variant: 'success' });
 *
 * Variants: 'success' | 'error' | 'warning' | 'info'
 *
 * No external dependencies beyond React.
 * Subtask 4.5
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss after this many ms. Default 5000. */
  duration?: number;
}

interface ToastContextValue {
  toast: (opts: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let _idCounter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback(
    (opts: Omit<ToastItem, 'id'>) => {
      const id = `toast-${++_idCounter}`;
      const duration = opts.duration ?? 5000;
      setToasts(prev => [...prev, { ...opts, id, duration }]);
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Individual Toast item
// ---------------------------------------------------------------------------

const variantStyles: Record<ToastVariant, string> = {
  success:
    'bg-green-50 border-green-200 text-green-900 dark:bg-green-950/60 dark:border-green-800 dark:text-green-100',
  error:
    'bg-red-50 border-red-200 text-red-900 dark:bg-red-950/60 dark:border-red-800 dark:text-red-100',
  warning:
    'bg-yellow-50 border-yellow-200 text-yellow-900 dark:bg-yellow-950/60 dark:border-yellow-800 dark:text-yellow-100',
  info:
    'bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/60 dark:border-blue-800 dark:text-blue-100',
};

function ToastItemComponent({
  toast: t,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Animate in
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Animate out just before dismiss
  const handleDismiss = useCallback(() => {
    setVisible(false);
    timerRef.current = setTimeout(() => onDismiss(t.id), 200);
  }, [onDismiss, t.id]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`toast-${t.variant}`}
      className={[
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm shadow-md',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
        variantStyles[t.variant],
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="flex-1">{t.message}</span>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity text-current"
      >
        &#x2715;
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Container — renders portal-mounted overlay
// ---------------------------------------------------------------------------

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none"
    >
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItemComponent toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
