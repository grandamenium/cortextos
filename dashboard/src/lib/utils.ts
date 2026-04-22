import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Remove HTML comments (<!-- ... -->) and trim whitespace. Template files like
// IDENTITY.md ship with placeholder comments; when a field hasn't been filled
// in yet we don't want the raw comment leaking into the UI.
//
// Comments inside fenced code blocks (``` ... ```) are preserved — users may
// legitimately show commented example markup. Fences are swapped for a null
// delimited sentinel so arbitrary user text cannot collide with it.
export function stripHtmlComments(value: string): string {
  if (!value) return "";
  const OPEN = "\x00\x01FENCE";
  const CLOSE = "FENCE\x01\x00";
  const fenced: string[] = [];
  const guarded = value.replace(/```[\s\S]*?```/g, (match) => {
    const idx = fenced.length;
    fenced.push(match);
    return `${OPEN}${idx}${CLOSE}`;
  });
  // Eat whitespace adjacent to the comment so inline comments don't leave a
  // visible double space (e.g. "Hello <!-- note --> World" → "Hello World").
  const stripped = guarded.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*/g, " ");
  const restored = stripped.replace(
    /\x00\x01FENCE(\d+)FENCE\x01\x00/g,
    (_, i) => fenced[Number(i)],
  );
  return restored.trim();
}
