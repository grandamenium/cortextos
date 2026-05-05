'use client';

/**
 * TestFireButton — trigger a cron immediately from the dashboard.
 *
 * Features:
 *  - Confirmation dialog before firing
 *  - Inline pending state ("Firing...")
 *  - Toast on success (green) / cooldown (yellow) / failure (red)
 *  - Auto-refresh of the execution history 6s after success
 *  - Disabled when manualFireDisabled is true (with tooltip)
 *  - Client-side 30s cooldown guard (server also enforces it)
 *
 * Subtask 4.5
 */

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { IconPlayerPlay, IconRefresh } from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TestFireButtonProps {
  agent: string;
  cronName: string;
  /** When true the button is grayed out with a tooltip explaining why. */
  manualFireDisabled?: boolean;
  /** Called after a successful fire so the parent can refresh history. */
  onFired?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CLIENT_COOLDOWN_MS = 30_000;

export default function TestFireButton({
  agent,
  cronName,
  manualFireDisabled = false,
  onFired,
}: TestFireButtonProps) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [firing, setFiring] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived: is the client-side cooldown still active?
  const isOnCooldown = cooldownUntil !== null && Date.now() < cooldownUntil;
  const isDisabled = manualFireDisabled || isOnCooldown;

  const handleOpenDialog = useCallback(() => {
    if (isDisabled) return;
    setDialogOpen(true);
  }, [isDisabled]);

  const handleCancel = useCallback(() => {
    if (firing) return;
    setDialogOpen(false);
  }, [firing]);

  const handleConfirm = useCallback(async () => {
    if (firing) return;
    setFiring(true);

    try {
      const res = await fetch(
        `/api/workflows/crons/${encodeURIComponent(agent)}/${encodeURIComponent(cronName)}/fire`,
        { method: 'POST' },
      );

      const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' })) as {
        ok: boolean;
        firedAt?: number;
        error?: string;
      };

      if (res.ok && data.ok) {
        const firedTime = data.firedAt
          ? new Date(data.firedAt).toLocaleTimeString()
          : new Date().toLocaleTimeString();
        toast({
          message: `Fired at ${firedTime}. Check execution history below in 5-10s.`,
          variant: 'success',
        });

        // Set client-side cooldown
        setCooldownUntil(Date.now() + CLIENT_COOLDOWN_MS);

        // Schedule history refresh after 6s
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          onFired?.();
        }, 6000);

        setDialogOpen(false);
      } else if (res.status === 409) {
        // Cooldown from server
        toast({
          message: data.error ?? 'Cooldown active. Try again shortly.',
          variant: 'warning',
        });
        setDialogOpen(false);
      } else if (res.status === 403) {
        toast({
          message: data.error ?? 'Manual fire is disabled for this cron.',
          variant: 'error',
        });
        setDialogOpen(false);
      } else {
        toast({
          message: data.error ?? 'Failed to fire cron.',
          variant: 'error',
        });
      }
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : 'Network error.',
        variant: 'error',
      });
    } finally {
      setFiring(false);
    }
  }, [agent, cronName, firing, onFired, toast]);

  // Button content
  const buttonContent = firing ? (
    <>
      <IconRefresh size={14} className="mr-1.5 animate-spin" />
      Firing...
    </>
  ) : (
    <>
      <IconPlayerPlay size={14} className="mr-1.5" />
      Test Fire
    </>
  );

  // Disabled reason for tooltip
  const disabledReason = manualFireDisabled
    ? 'Manual fire disabled for this cron.'
    : isOnCooldown
    ? 'Cooldown active. Wait 30s between manual fires.'
    : undefined;

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          {/* base-ui Tooltip.Trigger wraps children directly — no asChild needed */}
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isDisabled || firing}
                  onClick={handleOpenDialog}
                  data-testid="test-fire-button"
                  aria-label={
                    manualFireDisabled
                      ? 'Manual fire disabled for this cron'
                      : 'Test fire this cron immediately'
                  }
                >
                  {buttonContent}
                </Button>
              </span>
            }
          />
          {disabledReason && (
            <TooltipContent>
              <p>{disabledReason}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      {/* Confirmation dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={open => {
          if (!open && !firing) setDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IconPlayerPlay size={18} className="text-primary" />
              Fire cron now?
            </DialogTitle>
            <DialogDescription>
              This will inject the cron&apos;s prompt into agent{' '}
              <span className="font-semibold text-foreground">{agent}</span> immediately,
              as if the scheduled time had arrived.{' '}
              <span className="font-semibold text-foreground">{cronName}</span> will appear
              in the execution history once it runs.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel} disabled={firing}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={firing}
              className="min-w-[80px]"
              data-testid="test-fire-confirm-button"
            >
              {firing ? (
                <>
                  <IconRefresh size={14} className="mr-1.5 animate-spin" />
                  Firing...
                </>
              ) : (
                <>
                  <IconPlayerPlay size={14} className="mr-1.5" />
                  Fire
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
