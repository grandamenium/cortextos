// GLV Marketing brand tokens — extracted from CSS variables HSL → hex
export const brand = {
  // Core palette
  background: "#0D0D0D",     // hsl(0 0% 5%)
  foreground: "#F2F2F2",     // hsl(0 0% 95%)
  card:       "#141414",     // hsl(0 0% 8%)
  primary:    "#B81E1E",     // hsl(0 72% 42%) — GLV red
  secondary:  "#242424",     // hsl(0 0% 14%)
  muted:      "#1F1F1F",     // hsl(0 0% 12%)
  mutedFg:    "#8C8C8C",     // hsl(0 0% 55%)
  border:     "#292929",     // hsl(0 0% 16%)
  // Derived
  primaryDim: "#8B1616",     // darker red for gradients
  primaryGlow:"rgba(184,30,30,0.25)",

  // Typography
  fonts: {
    heading: "'Outfit', sans-serif",
    body:    "'Inter', sans-serif",
  },

  // Font weights
  weights: {
    regular: 400,
    medium:  500,
    semibold:600,
    bold:    700,
    extrabold:800,
  },

  // Dimensions
  canvas: {
    vertical: { width: 1080, height: 1350 },  // IG/LI portrait
    square:   { width: 1080, height: 1080 },  // IG/Threads/FB square
  },

  // Animation
  fps: 30,
  slideDuration: 150,  // frames per slide (5 seconds)
};
