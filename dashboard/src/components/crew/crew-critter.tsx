'use client';

// Generated fallback character for agents without uploaded art.
//
// Every agent gets a deterministic little robot — body shape, colour, and
// blink timing all derive from a hash of the name, so the same agent always
// looks the same on every device with zero stored state. Uploading real art
// via /api/avatars/[agent] replaces the critter entirely (see CrewAvatar).

export type CrewMood = 'typing' | 'active' | 'resting';

interface CrewCritterProps {
  name: string;
  mood: CrewMood;
  className?: string;
}

/** djb2 — tiny, stable, good enough spread for cosmetic choices. */
function hashName(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

// Four body silhouettes, all soft and huggable. viewBox is 0 0 120 120.
const BODIES = [
  // Round bean
  'M60 14 C88 14 104 34 104 62 C104 92 86 108 60 108 C34 108 16 92 16 62 C16 34 32 14 60 14 Z',
  // Tall marshmallow
  'M60 12 C82 12 96 26 96 52 L96 76 C96 98 82 110 60 110 C38 110 24 98 24 76 L24 52 C24 26 38 12 60 12 Z',
  // Wide pebble
  'M60 22 C94 22 110 42 110 66 C110 92 92 106 60 106 C28 106 10 92 10 66 C10 42 26 22 60 22 Z',
  // Egg
  'M60 12 C84 12 100 38 100 66 C100 92 84 108 60 108 C36 108 20 92 20 66 C20 38 36 12 60 12 Z',
] as const;

export function CrewCritter({ name, mood, className }: CrewCritterProps) {
  const h = hashName(name);
  const hue = h % 360;
  const body = BODIES[(h >> 3) % BODIES.length];
  const blinkDelay = ((h >> 6) % 40) / 10; // 0–3.9s so the fleet never blinks in sync
  const antennaTilt = ((h >> 9) % 21) - 10; // -10..10deg

  const bodyFill = `hsl(${hue} 68% 77%)`;
  const bodyEdge = `hsl(${hue} 42% 46%)`;
  const faceFill = `hsl(${hue} 32% 22%)`;
  const eyeFill = mood === 'resting' ? `hsl(${hue} 45% 55%)` : `hsl(${hue} 90% 88%)`;
  const blushFill = `hsl(${(hue + 340) % 360} 75% 74%)`;

  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-label={`${name} character`}
    >
      {/* Antenna */}
      <g transform={`rotate(${antennaTilt} 60 26)`}>
        <line x1="60" y1="26" x2="60" y2="8" stroke={bodyEdge} strokeWidth="3.5" strokeLinecap="round" />
        <circle
          cx="60"
          cy="7"
          r="5"
          fill={mood === 'typing' ? '#34d399' : bodyFill}
          stroke={bodyEdge}
          strokeWidth="2.5"
          className={mood === 'typing' ? 'crew-antenna-pulse' : undefined}
        />
      </g>

      {/* Side ears */}
      <circle cx="13" cy="64" r="8" fill={bodyFill} stroke={bodyEdge} strokeWidth="3" />
      <circle cx="107" cy="64" r="8" fill={bodyFill} stroke={bodyEdge} strokeWidth="3" />

      {/* Body */}
      <path d={body} fill={bodyFill} stroke={bodyEdge} strokeWidth="3.5" />

      {/* Face screen */}
      <rect
        x="30"
        y="40"
        width="60"
        height="42"
        rx="19"
        fill={faceFill}
        opacity={mood === 'resting' ? 0.75 : 1}
      />

      {/* Eyes */}
      {mood === 'resting' ? (
        <g stroke={eyeFill} strokeWidth="3.5" strokeLinecap="round" fill="none">
          <path d="M42 60 q5 5 10 0" />
          <path d="M68 60 q5 5 10 0" />
        </g>
      ) : (
        <g
          className="crew-blink"
          style={{ animationDelay: `${blinkDelay}s`, transformOrigin: '60px 60px' }}
        >
          <rect x="42" y="52" width="10" height="16" rx="5" fill={eyeFill} />
          <rect x="68" y="52" width="10" height="16" rx="5" fill={eyeFill} />
        </g>
      )}

      {/* Mouth */}
      {mood === 'typing' ? (
        <ellipse cx="60" cy="74" rx="4.5" ry="5.5" fill={eyeFill} />
      ) : mood === 'active' ? (
        <path d="M53 73 q7 6 14 0" stroke={eyeFill} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      ) : null}

      {/* Blush */}
      <circle cx="26" cy="76" r="5" fill={blushFill} opacity="0.75" />
      <circle cx="94" cy="76" r="5" fill={blushFill} opacity="0.75" />

      {/* Sleep zzz */}
      {mood === 'resting' && (
        <g className="crew-zz" fill={bodyEdge} fontFamily="var(--font-sora), sans-serif" fontWeight="700">
          <text x="88" y="30" fontSize="14">z</text>
          <text x="98" y="20" fontSize="10">z</text>
        </g>
      )}
    </svg>
  );
}
