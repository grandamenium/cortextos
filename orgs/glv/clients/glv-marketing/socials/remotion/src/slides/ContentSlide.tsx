import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { brand } from "../brand";
import { SlideData } from "../types";

interface Props {
  slide: SlideData;
  showLogo: boolean;
  totalSlides: number;
  slideIndex: number;
  variant: "vertical" | "square";
}

export const ContentSlide: React.FC<Props> = ({
  slide,
  showLogo,
  totalSlides,
  slideIndex,
  variant,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const accent = slide.accent ?? brand.primary;
  const isSquare = variant === "square";

  const headerIn = spring({ frame, fps, config: { damping: 22, stiffness: 90 } });
  const bodyOpacity = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: "clamp" });
  const bodySlide = interpolate(frame, [10, 30], [30, 0], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: brand.background,
        fontFamily: brand.fonts.body,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: isSquare ? "80px" : "90px",
        paddingTop: isSquare ? 110 : 130,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: accent,
          opacity: 0.8,
        }}
      />

      {/* Logo */}
      {showLogo && (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: 56,
            opacity: 0.7,
          }}
        >
          <img
            src={require("../../public/glv-logo.png")}
            alt="GLV Marketing"
            style={{ height: 32, objectFit: "contain", filter: "brightness(0.8)" }}
          />
        </div>
      )}

      {/* Counter */}
      <div
        style={{
          position: "absolute",
          top: 44,
          right: 56,
          fontSize: 15,
          color: brand.mutedFg,
          fontFamily: brand.fonts.body,
        }}
      >
        {slideIndex + 1} / {totalSlides}
      </div>

      {/* Tag pill */}
      {slide.tag && (
        <div
          style={{
            alignSelf: "flex-start",
            background: `${accent}22`,
            border: `1px solid ${accent}55`,
            borderRadius: 100,
            padding: "6px 18px",
            fontSize: 13,
            fontFamily: brand.fonts.heading,
            fontWeight: brand.weights.semibold,
            color: accent,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 24,
            opacity: headerIn,
          }}
        >
          {slide.tag}
        </div>
      )}

      {/* Headline */}
      <div
        style={{
          fontSize: isSquare ? 52 : 58,
          fontFamily: brand.fonts.heading,
          fontWeight: brand.weights.bold,
          color: brand.foreground,
          lineHeight: 1.15,
          marginBottom: 32,
          opacity: headerIn,
          transform: `translateY(${interpolate(1 - headerIn, [0, 1], [0, 30])}px)`,
        }}
      >
        {slide.headline}
      </div>

      {/* Divider */}
      <div
        style={{
          width: interpolate(headerIn, [0, 1], [0, 60]),
          height: 3,
          background: accent,
          borderRadius: 2,
          marginBottom: 32,
        }}
      />

      {/* Body */}
      {slide.body && (
        <div
          style={{
            fontSize: isSquare ? 26 : 28,
            fontFamily: brand.fonts.body,
            fontWeight: brand.weights.regular,
            color: brand.mutedFg,
            lineHeight: 1.65,
            opacity: bodyOpacity,
            transform: `translateY(${bodySlide}px)`,
            flex: 1,
          }}
        >
          {slide.body}
        </div>
      )}

      {/* Bottom accent card */}
      <div
        style={{
          marginTop: "auto",
          padding: "20px 24px",
          background: brand.card,
          borderRadius: 12,
          border: `1px solid ${brand.border}`,
          opacity: interpolate(frame, [25, 45], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 13, color: brand.mutedFg, fontFamily: brand.fonts.body }}>
          glvmarketing.ca
        </div>
      </div>
    </div>
  );
};
