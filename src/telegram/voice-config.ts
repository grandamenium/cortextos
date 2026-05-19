/**
 * Per-agent voice resolution for the voice-reply pipeline.
 *
 * Component 2 of voice-conversation-spec.md. Each agent can declare which
 * OpenAI TTS voice it speaks in via three layers, queried in order
 * (first match wins):
 *
 *   1. Agent config.json `voice` field. Highest precedence.
 *      Example: { "agent_name": "atlas", "voice": "cedar", ... }
 *
 *   2. Org voices.json mapping. Org-level default per agent name.
 *      File: orgs/<org>/voices.json
 *      Shape: { "atlas": "cedar", "sage": "alloy", "_read_aloud": "fable" }
 *
 *   3. Built-in fallback (none - returns null). Callers decide whether
 *      to skip voice synthesis or use a hardcoded default at that point.
 *
 * Values should be one of the OpenAI TTS voices (see OPENAI_TTS_VOICES
 * in tts.ts). The resolver returns the name string as-is; the TTS client
 * handles the case-normalization. Unknown names are still passed through
 * so callers can opt into new voices OpenAI adds before this code knows
 * about them.
 *
 * Both files are read fresh on every call - voice config is small and
 * operators can swap a voice without restarting the daemon.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ResolveAgentVoiceInput {
  /** Lowercase agent name, e.g. "atlas", "sage". Required. */
  agentName: string;
  /** Absolute path to the agent's directory. Optional. */
  agentDir?: string;
  /** Absolute path to the org's directory. Optional. */
  orgDir?: string;
}

/**
 * Resolve the voice name for an agent. Returns null when no layer
 * declares one - callers can then either skip voice synthesis or apply
 * their own default.
 */
export function resolveAgentVoice(input: ResolveAgentVoiceInput): string | null {
  const { agentName, agentDir, orgDir } = input;

  if (!agentName || !agentName.trim()) return null;

  // Layer 1: agent config.json
  if (agentDir) {
    const cfgPath = join(agentDir, 'config.json');
    if (existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        if (typeof cfg?.voice === 'string' && cfg.voice.trim()) {
          return cfg.voice.trim();
        }
      } catch {
        // malformed config.json - fall through to next layer rather than throw
      }
    }
  }

  // Layer 2: org voices.json
  if (orgDir) {
    const voicesPath = join(orgDir, 'voices.json');
    if (existsSync(voicesPath)) {
      try {
        const map = JSON.parse(readFileSync(voicesPath, 'utf-8'));
        const value = map?.[agentName.toLowerCase()];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      } catch {
        // malformed voices.json - fall through
      }
    }
  }

  return null;
}

/**
 * Resolve the "read-aloud" voice (Component 3 of the spec - the iOS
 * Read-Aloud Shortcut). Lives in the org voices.json under the reserved
 * key `_read_aloud` so it does not collide with an agent named the same
 * thing. Returns null when not configured.
 */
export function resolveReadAloudVoice(orgDir: string | undefined): string | null {
  if (!orgDir) return null;
  const voicesPath = join(orgDir, 'voices.json');
  if (!existsSync(voicesPath)) return null;
  try {
    const map = JSON.parse(readFileSync(voicesPath, 'utf-8'));
    const value = map?._read_aloud;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  } catch {
    // malformed voices.json
  }
  return null;
}

/**
 * Per-agent TTS model resolution (tts-1 vs tts-1-hd vs gpt-4o-mini-tts).
 *
 * Looks for a `voice_model` field on the agent config.json. Falls back
 * to "tts-1" so cost stays low by default. Operators set
 * "gpt-4o-mini-tts" when the agent's voice (e.g. cedar, marin) requires
 * the newer model, or "tts-1-hd" when the agent's voice needs sharper
 * prosody on the legacy model.
 *
 * Not present in org voices.json - this is per-agent only.
 */
export function resolveAgentVoiceModel(agentDir: string | undefined): string {
  const DEFAULT = 'tts-1';
  if (!agentDir) return DEFAULT;
  const cfgPath = join(agentDir, 'config.json');
  if (!existsSync(cfgPath)) return DEFAULT;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (typeof cfg?.voice_model === 'string' && cfg.voice_model.trim()) {
      return cfg.voice_model.trim();
    }
  } catch {
    // malformed - fall through to default
  }
  return DEFAULT;
}

/**
 * Per-agent voice speed resolution (0.25-4.0, default 1.0).
 *
 * Looks for a `voice_speed` field on the agent config.json. Operators
 * tune this per-agent for prosody preference - e.g. an orchestrator
 * delivering briefings can run slightly faster (1.1) than a measured
 * analyst voice (1.0 or 0.95).
 *
 * Returns the default 1.0 for missing / malformed / out-of-range values.
 * The synthesizeVoice call enforces the OpenAI-accepted range; this
 * function is defensive but lenient (does not throw, returns default).
 *
 * Not present in org voices.json - this is per-agent only.
 */
export function resolveAgentVoiceSpeed(agentDir: string | undefined): number {
  const DEFAULT = 1.0;
  if (!agentDir) return DEFAULT;
  const cfgPath = join(agentDir, 'config.json');
  if (!existsSync(cfgPath)) return DEFAULT;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (typeof cfg?.voice_speed === 'number' && cfg.voice_speed >= 0.25 && cfg.voice_speed <= 4.0) {
      return cfg.voice_speed;
    }
  } catch {
    // malformed - fall through to default
  }
  return DEFAULT;
}
