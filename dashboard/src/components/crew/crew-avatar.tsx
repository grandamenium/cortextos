'use client';

import { useEffect, useState } from 'react';
import { CrewCritter, type CrewMood } from './crew-critter';

interface CrewAvatarProps {
  name: string;
  /** Cache-busting avatar version from /api/crew; null = no uploaded art. */
  version: number | null;
  mood: CrewMood;
  /** Diameter in px. */
  size: number;
  /** Show the mood ring around the avatar (roster + chat header). */
  ring?: boolean;
  className?: string;
}

/**
 * The agent's face: uploaded art when it exists, generated critter
 * otherwise. If the image 404s or fails to load we fall back to the
 * critter rather than showing a broken image.
 */
export function CrewAvatar({ name, version, mood, size, ring = false, className }: CrewAvatarProps) {
  const [broken, setBroken] = useState(false);

  // A fresh upload (new version) deserves a fresh load attempt.
  useEffect(() => {
    setBroken(false);
  }, [version]);

  const showImage = version !== null && !broken;

  const ringClass = !ring
    ? ''
    : mood === 'typing'
      ? 'ring-2 ring-emerald-400/80 crew-ring-typing'
      : mood === 'active'
        ? 'ring-2 ring-emerald-400/40'
        : 'ring-2 ring-border';

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-full bg-muted/40 ${ringClass} ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/avatars/${name}?v=${version}`}
          alt={`${name} avatar`}
          width={size}
          height={size}
          className={`h-full w-full object-cover ${mood === 'resting' ? 'opacity-70 saturate-50' : ''}`}
          onError={() => setBroken(true)}
        />
      ) : (
        <CrewCritter name={name} mood={mood} className="h-full w-full" />
      )}
    </div>
  );
}
