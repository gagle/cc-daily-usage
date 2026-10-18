/** Terminal meters shared by the statusline, `live` and `report`: bars, a stacked bar and a sparkline.
 * Pure strings; `color: false` gives plain glyphs (NO_COLOR, pipes, tests). */

const RESET = "\x1b[0m";
const EMPTY_RGB = "60;60;60";
const SPARKS = "▁▂▃▄▅▆▇█";

export function paint(rgb: string, text: string, color: boolean): string {
  return color ? `\x1b[38;2;${rgb}m${text}${RESET}` : text;
}

/** Green → yellow → red at `percent` (0-100, integer) along a bar; the statusline context bar's ramp. */
export function gradientRgb(percent: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (percent <= 50) {
    const t = percent * 2;
    r = Math.floor((220 * t) / 100);
    g = 200;
    b = Math.floor(80 - (80 * t) / 100);
  } else {
    const t = (percent - 50) * 2;
    r = 220;
    g = Math.floor(200 - (160 * t) / 100);
    b = Math.floor((20 * t) / 100);
  }
  return `${String(r)};${String(g)};${String(b)}`;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** `cells` wide; filled cells take the gradient by position, so a low value stays green. */
export function bar(fraction: number, cells: number, color: boolean): string {
  const filled = Math.round(clamp01(fraction) * cells);
  let out = "";
  for (let i = 1; i <= cells; i++) {
    out +=
      i <= filled
        ? paint(gradientRgb(Math.floor((i * 100) / cells)), "█", color)
        : paint(EMPTY_RGB, "░", color);
  }
  return out;
}

/** `cells` wide in one color (a share of a whole: a component, a model, an agent). */
export function solidBar(fraction: number, cells: number, rgb: string, color: boolean): string {
  const filled = Math.round(clamp01(fraction) * cells);
  return (
    paint(rgb, "█".repeat(filled), color) + paint(EMPTY_RGB, "░".repeat(cells - filled), color)
  );
}

export interface Segment {
  readonly value: number;
  readonly rgb: string;
  readonly glyph: string; // used when color is off, so the parts stay apart
}

/** One bar split into segments by value; every non-zero segment gets at least one cell while cells last. */
export function stacked(segments: ReadonlyArray<Segment>, cells: number, color: boolean): string {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  if (total <= 0) return paint(EMPTY_RGB, "░".repeat(cells), color);
  const exact = segments.map((segment) => (Math.max(0, segment.value) / total) * cells);
  const widths = exact.map((share) => (share > 0 ? Math.max(1, Math.round(share)) : 0));
  // Rounding and the one-cell floor can over- or under-fill: give or take one cell at a time where the
  // width is furthest from the exact share.
  let gap = cells - widths.reduce((a, b) => a + b, 0);
  while (gap !== 0) {
    const step = Math.sign(gap);
    // Taking a cell keeps each part's one-cell floor until no part has more than one.
    const floor = step < 0 && widths.some((width) => width > 1) ? 1 : 0;
    let pick = -1;
    for (let i = 0; i < widths.length; i++) {
      if (step < 0 && (widths[i] as number) <= floor) continue;
      const need = step * ((exact[i] as number) - (widths[i] as number));
      const best = pick === -1 ? null : step * ((exact[pick] as number) - (widths[pick] as number));
      if (best === null || need > best) pick = i;
    }
    widths[pick] = (widths[pick] as number) + step;
    gap -= step;
  }
  return segments
    .map((segment, i) =>
      paint(segment.rgb, (color ? "█" : segment.glyph).repeat(widths[i] as number), color),
    )
    .join("");
}

/** One glyph per value, scaled to the largest; zero stays the lowest glyph. */
export function sparkline(values: ReadonlyArray<number>): string {
  const max = Math.max(0, ...values);
  return values
    .map((value) =>
      max <= 0 ? SPARKS[0] : SPARKS[Math.round((Math.max(0, value) / max) * (SPARKS.length - 1))],
    )
    .join("");
}
