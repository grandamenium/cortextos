import React from "react";
import { Composition } from "remotion";
import { Carousel } from "./Carousel";
import { brand } from "./brand";
import { CarouselProps, SlideData } from "./types";

// ── Sample carousel: "5 reasons your business is invisible online" ──────────
const sampleSlides: SlideData[] = [
  {
    type: "hook",
    tag: "GLV Marketing",
    headline: "5 Reasons Your Business Is Invisible Online",
    body: "Fix these and watch your leads grow.",
  },
  {
    type: "content",
    tag: "Reason #1",
    headline: "No Google Business Profile",
    body: "46% of all Google searches have local intent. If you haven't claimed your GBP listing, you're invisible to half your potential customers before they even reach your website.",
  },
  {
    type: "content",
    tag: "Reason #2",
    headline: "Your Website Loads Too Slowly",
    body: "53% of mobile users abandon a page that takes more than 3 seconds to load. Every extra second costs you customers — and Google rankings.",
  },
  {
    type: "content",
    tag: "Reason #3",
    headline: "You're Not Showing Up in AI Search",
    body: "ChatGPT, Gemini, and Perplexity are replacing Google for local business searches. Without Generative Engine Optimization (GEO), your business doesn't exist to these tools.",
  },
  {
    type: "cta",
    tag: "Free Consultation",
    headline: "Let's Fix It Together",
    body: "Book a free 30-minute audit. We'll show you exactly what's holding your business back.",
  },
];

const defaultProps: CarouselProps = {
  slides: sampleSlides,
  showLogo: true,
  showCounter: true,
  variant: "vertical",
};

const squareProps: CarouselProps = {
  ...defaultProps,
  variant: "square",
};

const totalFrames = sampleSlides.length * brand.slideDuration;

export const RemotionRoot: React.FC = () => (
  <>
    {/* 1080×1350 portrait — IG/LI */}
    <Composition
      id="GLVCarousel"
      component={Carousel}
      durationInFrames={totalFrames}
      fps={brand.fps}
      width={brand.canvas.vertical.width}
      height={brand.canvas.vertical.height}
      defaultProps={defaultProps}
    />

    {/* 1080×1080 square — IG Feed / Threads / FB */}
    <Composition
      id="GLVCarouselSquare"
      component={Carousel}
      durationInFrames={totalFrames}
      fps={brand.fps}
      width={brand.canvas.square.width}
      height={brand.canvas.square.height}
      defaultProps={squareProps}
    />
  </>
);
