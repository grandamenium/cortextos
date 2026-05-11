#!/usr/bin/env node
/**
 * Render one still per slide for both portrait and square variants.
 * Usage: node scripts/render-all-stills.js [output-dir]
 *
 * Output structure:
 *   <output-dir>/
 *     vertical/  slide-01.png … slide-05.png
 *     square/    slide-01.png … slide-05.png
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SLIDES = 5;
const FPS = 30;
const SLIDE_FRAMES = 150; // 5s per slide

const outputDir = process.argv[2]
  ?? path.resolve(__dirname, "../../../deliverables/socials/renders/test-001");

const variants = [
  { id: "GLVCarousel",       dir: "vertical" },
  { id: "GLVCarouselSquare", dir: "square"   },
];

for (const { id, dir } of variants) {
  const outPath = path.join(outputDir, dir);
  fs.mkdirSync(outPath, { recursive: true });

  for (let i = 0; i < SLIDES; i++) {
    const frame = i * SLIDE_FRAMES + 30; // 1 second into each slide
    const outFile = path.join(outPath, `slide-${String(i + 1).padStart(2, "0")}.png`);

    console.log(`Rendering ${id} slide ${i + 1} (frame ${frame}) → ${outFile}`);
    execSync(
      `npx remotion still ${id} --frame=${frame} --gl=swiftshader --output="${outFile}"`,
      { cwd: path.resolve(__dirname, ".."), stdio: "inherit" }
    );
  }
}

console.log("\nAll stills rendered to:", outputDir);
