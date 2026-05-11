import React from "react";
import { useCurrentFrame, useVideoConfig, Sequence } from "remotion";
import { brand } from "./brand";
import { CarouselProps } from "./types";
import { HookSlide } from "./slides/HookSlide";
import { ContentSlide } from "./slides/ContentSlide";
import { CTASlide } from "./slides/CTASlide";

export const Carousel: React.FC<CarouselProps> = ({
  slides,
  showLogo = true,
  showCounter = true,
  variant = "vertical",
}) => {
  const { durationInFrames, fps } = useVideoConfig();
  const slideDuration = brand.slideDuration;
  const total = slides.length;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: brand.background,
        fontFamily: brand.fonts.body,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Load Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>

      {slides.map((slide, i) => {
        const from = i * slideDuration;
        const SlideComponent =
          slide.type === "hook" ? HookSlide :
          slide.type === "cta"  ? CTASlide  :
          ContentSlide;

        return (
          <Sequence key={i} from={from} durationInFrames={slideDuration}>
            <div style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}>
              <SlideComponent
                slide={slide}
                showLogo={showLogo}
                totalSlides={total}
                slideIndex={i}
                variant={variant}
              />
            </div>
          </Sequence>
        );
      })}
    </div>
  );
};
