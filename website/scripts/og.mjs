/**
 * Generates `public/og.png` — the 1200×630 social card.
 *
 * Brand: void #050505, warm white #F3F1EA, signal moss #879B45, sand #DED9CE.
 * Type is rendered by librsvg through sharp, so it uses a Helvetica-class
 * system face (the brand's documented web fallback) rather than Manrope,
 * which ships as woff2 only.
 *
 *   node scripts/og.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "og.png");

const VOID = "#050505";
const WARM = "#F3F1EA";
const MOSS = "#879B45";
const SAND = "#DED9CE";
const SANS = "Nimbus Sans, Helvetica, DejaVu Sans, sans-serif";

/** The one-path ripple loop from the brand guide. */
const MARK =
  "M90.8 61.2 C74.2 82.5 60 88 41.8 85.7 C16.5 82.5 3.9 63.6 5.5 42.2 C7.1 19.3 23.6 5.1 45.7 6.7 C67.9 7.5 80.5 25.7 95.5 41.4 C111.3 57.2 128.7 71.4 148.4 80.1 C170.5 89.6 188.7 84.1 199.7 69.1 C212.4 51.7 207.6 28 191.8 17 C174.5 4.3 150 5.1 131 17.8 C126.3 20.9 122.3 24.1 119.2 27.2";
const MARK_INNER = "M135 37.5 C148.4 28 169.7 26.4 182.4 39.9";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${VOID}"/>

  <!-- contour echoes: the quietest possible texture -->
  <g fill="none" stroke="${WARM}" stroke-width="1.5" transform="translate(0 68)">
    <path d="M-60 470 C 260 390, 560 540, 900 460 S 1260 410, 1360 445" stroke-opacity="0.07"/>
    <path d="M-60 520 C 280 445, 580 595, 920 510 S 1270 465, 1370 495" stroke-opacity="0.05"/>
    <path d="M-60 570 C 300 500, 600 645, 940 560 S 1280 520, 1380 545" stroke-opacity="0.035"/>
  </g>
  <path d="M780 540 C 872 516, 968 528, 1044 514" fill="none" stroke="${MOSS}" stroke-opacity="0.55" stroke-width="2.5" stroke-linecap="round"/>

  <g transform="translate(80 74) scale(0.62)" fill="none">
    <path d="${MARK}" stroke="${WARM}" stroke-width="7.9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${MARK_INNER}" stroke="${MOSS}" stroke-width="7.9" stroke-linecap="round"/>
  </g>

  <text x="80" y="248" font-family="${SANS}" font-size="86" font-weight="bold" fill="${WARM}" letter-spacing="-2">Ripple</text>

  <text x="80" y="330" font-family="${SANS}" font-size="42" fill="${SAND}">The typed, realtime database</text>
  <text x="80" y="384" font-family="${SANS}" font-size="42" fill="${SAND}">for apps you ship on Cloudflare</text>

  <g font-family="${SANS}" font-size="24" fill="#9A968B">
    <text x="80" y="470">Typed schema</text>
    <text x="292" y="470">Live queries</text>
    <text x="486" y="470">Per-user permissions</text>
  </g>
  <g fill="${MOSS}">
    <circle cx="268" cy="462" r="4"/>
    <circle cx="462" cy="462" r="4"/>
  </g>

  <text x="80" y="556" font-family="${SANS}" font-size="26" font-weight="bold" fill="${MOSS}">ripplegraph.ai</text>
</svg>`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, await sharp(Buffer.from(svg)).png().toBuffer());
console.log(`wrote ${out}`);
