-- Voice usage logging table for engine-agnostic TTS framework (Voice POC L1).
-- Tracks all TTS calls across edge-tts, google-tts-neural2, gpt-realtime-mini,
-- and gpt-realtime-regular. Used for daily cost reports and $5/day cap enforcement.

create table if not exists voice_usage (
  id                 uuid        primary key default gen_random_uuid(),
  agent              text        not null,
  engine             text        not null,  -- edge-tts | google-tts-neural2 | gpt-realtime-mini | gpt-realtime-regular
  model              text        not null,  -- specific model/voice name within the engine
  input_chars        integer     not null default 0,
  duration_seconds   numeric,
  cost_estimate_usd  numeric     not null default 0,
  ts                 timestamptz not null default now()
);

create index if not exists voice_usage_ts_idx     on voice_usage (ts);
create index if not exists voice_usage_agent_idx  on voice_usage (agent);
create index if not exists voice_usage_engine_idx on voice_usage (engine);
