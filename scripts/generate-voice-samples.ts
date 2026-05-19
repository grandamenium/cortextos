#!/usr/bin/env -S npx tsx
/**
 * generate-voice-samples.ts
 *
 * Generate ~30-second OGG/Opus samples for every candidate OpenAI TTS
 * voice. Drops files to /tmp/voice-samples/<voice>.ogg (or wherever
 * --out-dir points). Used to give Zach (or any org's owner) something to
 * ear-pick before assigning voices to agents.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/generate-voice-samples.ts
 *   npx tsx scripts/generate-voice-samples.ts --out-dir /tmp/my-samples
 *   npx tsx scripts/generate-voice-samples.ts --voices cedar,alloy,fable
 *   npx tsx scripts/generate-voice-samples.ts --model tts-1-hd
 *   npx tsx scripts/generate-voice-samples.ts --text "Custom sample text"
 *
 * If OPENAI_API_KEY is not in env, the script tries 1Password as a
 * fallback (item "OpenAI", field "credential", vault "Automation"). This
 * matches the cortextos secrets pattern - same flow used by other
 * scripts that need a credential without a pre-export.
 *
 * Cost: ~$0.001 per voice at tts-1 (default), ~$0.002 at tts-1-hd.
 * 12 voices = ~$0.01-$0.02. Cheap enough to run on every voice rotation.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { synthesizeVoice, OPENAI_TTS_VOICES } from '../src/telegram/tts.js';

interface CliArgs {
  outDir: string;
  voices: readonly string[];
  model: string;
  text: string;
}

const DEFAULT_SAMPLE_TEXT =
  'Good morning. Heads up - the Talsky Tonal email queue cleared overnight ' +
  'and three drafts are ready for your review. Nothing urgent, but worth ' +
  'a glance before the 9am block. Also flagged: GHL workflow A-12 missed ' +
  'two leads last week. Mercury is on it.';

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    outDir: '/tmp/voice-samples',
    voices: OPENAI_TTS_VOICES,
    model: 'tts-1',
    text: DEFAULT_SAMPLE_TEXT,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--voices') {
      args.voices = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--text') args.text = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: generate-voice-samples.ts [opts]
  --out-dir <path>       Output dir (default /tmp/voice-samples)
  --voices a,b,c         Comma-list of voices (default: all known)
  --model tts-1|tts-1-hd Default tts-1
  --text "..."           Sample text. Default is a 60-word agent briefing.
  --help                 Print this help`);
      process.exit(0);
    }
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }

  return args;
}

function resolveApiKey(): string {
  // 1. env var (fastest path - operator pre-exported)
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();

  // 2. 1Password fallback (matches the pattern used elsewhere in cortextos
  //    when a script needs a credential without requiring pre-export).
  try {
    const out = execSync(
      'op item get "OpenAI" --vault Automation --fields credential --reveal',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out) return out;
  } catch {
    // 1Password unavailable or item lookup failed
  }

  return '';
}

async function main() {
  const args = parseArgs();
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      'No OPENAI_API_KEY found. Either:\n' +
      '  1. export OPENAI_API_KEY=... and re-run, OR\n' +
      '  2. ensure 1Password CLI (op) is signed in + item "OpenAI" exists in the Automation vault\n' +
      'Exiting without generating samples.',
    );
    process.exit(1);
  }

  mkdirSync(args.outDir, { recursive: true });
  console.log(`Generating ${args.voices.length} samples → ${args.outDir}/`);
  console.log(`Model: ${args.model}`);
  console.log(`Text:  ${args.text.slice(0, 80)}${args.text.length > 80 ? '...' : ''}`);
  console.log();

  const results: { voice: string; ok: boolean; bytes: number; err?: string }[] = [];
  for (const voice of args.voices) {
    process.stdout.write(`  ${voice.padEnd(10)} ... `);
    try {
      const buf = await synthesizeVoice(args.text, voice, { apiKey, model: args.model });
      const outPath = join(args.outDir, `${voice}.ogg`);
      writeFileSync(outPath, buf);
      results.push({ voice, ok: true, bytes: buf.length });
      console.log(`ok (${buf.length} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ voice, ok: false, bytes: 0, err: msg });
      console.log(`FAILED: ${msg}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  console.log();
  console.log(`Done. ${okCount} succeeded, ${failCount} failed.`);
  console.log(`Samples in ${args.outDir}/ - play each and pick the voice that matches the agent.`);

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
