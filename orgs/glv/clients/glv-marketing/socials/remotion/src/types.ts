export type SlideType = "hook" | "content" | "cta";

export interface SlideData {
  type: SlideType;
  /** Main headline or hook text */
  headline: string;
  /** Optional subtext / body copy */
  body?: string;
  /** Optional accent colour override (hex) — defaults to brand.primary */
  accent?: string;
  /** Optional background image URL */
  bgImage?: string;
  /** Slide-level tag/label shown above headline (e.g. "TIP #1") */
  tag?: string;
}

export interface CarouselProps {
  slides: SlideData[];
  /** Show logo on every slide (default: true) */
  showLogo?: boolean;
  /** Show slide counter (default: true) */
  showCounter?: boolean;
  /** Canvas variant */
  variant?: "vertical" | "square";
}
