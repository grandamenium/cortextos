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

export const HookSlide: React.FC<Props> = ({
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

  const fadeIn = spring({ frame, fps, config: { damping: 20, stiffness: 80 } });
  const slideUp = interpolate(frame, [0, 20], [40, 0], { extrapolateRight: "clamp" });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

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
        alignItems: "center",
        justifyContent: "center",
        padding: isSquare ? 80 : 90,
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: isSquare ? 700 : 900,
          height: isSquare ? 700 : 900,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${brand.primaryGlow} 0%, transparent 70%)`,
          opacity: fadeIn * 0.8,
        }}
      />

      {/* Top accent bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 6,
          background: `linear-gradient(90deg, ${brand.primaryDim}, ${accent}, ${brand.primaryDim})`,
        }}
      />

      {/* Logo */}
      {showLogo && (
        <div
          style={{
            position: "absolute",
            top: 48,
            left: 56,
            opacity: interpolate(frame, [5, 20], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          <img
            src={require("../../public/glv-logo.png")}
            alt="GLV Marketing"
            style={{ height: 40, objectFit: "contain" }}
          />
        </div>
      )}

      {/* Slide counter */}
      <div
        style={{
          position: "absolute",
          top: 56,
          right: 56,
          fontSize: 16,
          fontFamily: brand.fonts.body,
          color: brand.mutedFg,
          opacity: interpolate(frame, [5, 20], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        {slideIndex + 1} / {totalSlides}
      </div>

      {/* Main content */}
      <div
        style={{
          textAlign: "center",
          opacity,
          transform: `translateY(${slideUp}px)`,
          zIndex: 1,
          maxWidth: isSquare ? 800 : 860,
        }}
      >
        {/* Tag */}
        {slide.tag && (
          <div
            style={{
              display: "inline-block",
              background: `${accent}22`,
              border: `1px solid ${accent}66`,
              borderRadius: 100,
              padding: "8px 20px",
              fontSize: 14,
              fontFamily: brand.fonts.heading,
              fontWeight: brand.weights.semibold,
              color: accent,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 32,
            }}
          >
            {slide.tag}
          </div>
        )}

        {/* Headline */}
        <div
          style={{
            fontSize: isSquare ? 64 : 72,
            fontFamily: brand.fonts.heading,
            fontWeight: brand.weights.extrabold,
            color: brand.foreground,
            lineHeight: 1.1,
            marginBottom: slide.body ? 28 : 0,
          }}
        >
          {slide.headline}
        </div>

        {/* Body */}
        {slide.body && (
          <div
            style={{
              fontSize: isSquare ? 24 : 26,
              fontFamily: brand.fonts.body,
              fontWeight: brand.weights.regular,
              color: brand.mutedFg,
              lineHeight: 1.6,
              marginTop: 8,
            }}
          >
            {slide.body}
          </div>
        )}
      </div>

      {/* Bottom swipe hint */}
      <div
        style={{
          position: "absolute",
          bottom: 48,
          left: "50%",
          transform: `translateX(-50%)`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          opacity: interpolate(frame, [20, 40], [0, 0.6], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: brand.mutedFg, fontFamily: brand.fonts.body }}>
          Swipe to learn more
        </div>
        <div style={{ fontSize: 18, color: brand.mutedFg }}>→</div>
      </div>
    </div>
  );
};
