/**
 * Reef design tokens. Dark is the default palette; `light` (themes.stylex.ts)
 * overrides the color scale. Only `defineVars` values live in *.stylex.ts
 * files, per the StyleX compiler contract.
 *
 * The theme class is applied to `<html>` (see App.tsx) so portaled UI —
 * dialogs, toasts — inherits the same variables as the app root.
 */

import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  bg: "#0b0d12",
  bgRaised: "#10131a",
  surface: "#151a23",
  surfaceHover: "#1b2130",
  surfaceActive: "#212a3b",
  border: "#222a3a",
  borderStrong: "#2f3a50",
  text: "#e9ecf2",
  textMuted: "#99a3b7",
  textFaint: "#5f697b",
  accent: "#5b8cff",
  accentHover: "#78a0ff",
  accentSoft: "rgba(91, 140, 255, 0.15)",
  accentText: "#ffffff",
  /** Focus ring — accent at ~35% so it reads on both surfaces. */
  ring: "rgba(91, 140, 255, 0.4)",
  ok: "#3fb970",
  okSoft: "rgba(63, 185, 112, 0.14)",
  warn: "#f5a524",
  warnSoft: "rgba(245, 165, 36, 0.16)",
  danger: "#ef5f6b",
  dangerSoft: "rgba(239, 95, 107, 0.14)",
  overlay: "rgba(4, 6, 10, 0.6)",
  shadow: "0 16px 48px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)",
  shadowSm: "0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.25)",
  /** Auth-screen backdrop glows. */
  glowA: "rgba(91, 140, 255, 0.22)",
  glowB: "rgba(45, 212, 191, 0.14)",
});

export const space = stylex.defineVars({
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "36px",
});

export const radii = stylex.defineVars({
  xs: "4px",
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "20px",
  full: "999px",
});

export const type = stylex.defineVars({
  family:
    "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  xs: "11px",
  sm: "12.5px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  xxl: "28px",
});
