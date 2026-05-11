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

export const CTASlide: React.FC<Props> = ({
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

  const cardScale = spring({ frame, fps, config: { damping: 18, stiffness: 70 } });
  const textIn = interpolate(frame, [8, 28], [0, 1], { extrapolateRight: "clamp" });
  const bgGlow = interpolate(frame, [0, 40], [0, 1], { extrapolateRight: "clamp" });

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
      {/* Background radial glow */}
      <div
        style={{
          position: "absolute",
          bottom: -200,
          left: "50%",
          transform: "translateX(-50%)",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${brand.primaryGlow} 0%, transparent 65%)`,
          opacity: bgGlow,
        }}
      />

      {/* Top bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 5,
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
        }}
      />

      {/* Logo (centered at top) */}
      {showLogo && (
        <div
          style={{
            position: "absolute",
            top: 48,
            left: "50%",
            transform: "translateX(-50%)",
            opacity: interpolate(frame, [5, 20], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          <img
            src={require("../../public/glv-logo.png")}
            alt="GLV Marketing"
            style={{ height: 44, objectFit: "contain" }}
          />
        </div>
      )}

      {/* CTA Card */}
      <div
        style={{
          width: "100%",
          maxWidth: isSquare ? 820 : 880,
          textAlign: "center",
          transform: `scale(${cardScale})`,
          zIndex: 1,
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
              padding: "8px 22px",
              fontSize: 13,
              fontFamily: brand.fonts.heading,
              fontWeight: brand.weights.semibold,
              color: accent,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 32,
              opacity: textIn,
            }}
          >
            {slide.tag}
          </div>
        )}

        {/* Main headline */}
        <div
          style={{
            fontSize: isSquare ? 58 : 66,
            fontFamily: brand.fonts.heading,
            fontWeight: brand.weights.extrabold,
            color: brand.foreground,
            lineHeight: 1.1,
            marginBottom: 24,
            opacity: textIn,
          }}
        >
          {slide.headline}
        </div>

        {/* Body */}
        {slide.body && (
          <div
            style={{
              fontSize: isSquare ? 24 : 26,
              color: brand.mutedFg,
              lineHeight: 1.6,
              marginBottom: 48,
              opacity: interpolate(frame, [15, 35], [0, 1], { extrapolateRight: "clamp" }),
            }}
          >
            {slide.body}
          </div>
        )}

        {/* CTA button */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            background: accent,
            color: "#fff",
            borderRadius: 12,
            padding: isSquare ? "22px 44px" : "24px 52px",
            fontSize: isSquare ? 22 : 24,
            fontFamily: brand.fonts.heading,
            fontWeight: brand.weights.bold,
            opacity: interpolate(frame, [20, 40], [0, 1], { extrapolateRight: "clamp" }),
            boxShadow: `0 0 40px ${brand.primaryGlow}`,
          }}
        >
          Book a Free Consultation
          <span style={{ fontSize: 20 }}>→</span>
        </div>

        {/* URL */}
        <div
          style={{
            marginTop: 28,
            fontSize: 18,
            color: brand.mutedFg,
            fontFamily: brand.fonts.body,
            opacity: interpolate(frame, [30, 50], [0, 0.8], { extrapolateRight: "clamp" }),
            letterSpacing: "0.04em",
          }}
        >
          glvmarketing.ca
        </div>
      </div>
    </div>
  );
};
