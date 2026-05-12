// Tiny registry module so Phase 2 + Phase 3 CLI files can register their
// command-builders without triggering a circular import with token-audit.ts.

import type { Command } from 'commander';

let phase2Registrar: ((ta: Command) => void) | null = null;
let phase3Registrar: ((ta: Command) => void) | null = null;

export function setPhase2Registrar(fn: (ta: Command) => void): void { phase2Registrar = fn; }
export function setPhase3Registrar(fn: (ta: Command) => void): void { phase3Registrar = fn; }
export function getPhase2Registrar(): ((ta: Command) => void) | null { return phase2Registrar; }
export function getPhase3Registrar(): ((ta: Command) => void) | null { return phase3Registrar; }
