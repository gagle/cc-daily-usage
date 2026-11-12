---
name: update-statusline-template
description: Use when changing how the statusline looks or the installed shim (assets/statusline.mjs) — rendering lives in src/statusline-render.ts; covers the shim's content hash, the stamped entry URL, and refreshing the machine install.
---

# Change the statusline

Rendering is TypeScript: `src/statusline-render.ts` (pure, 100% covered).
`assets/statusline.mjs` is only the shim that imports the package in-process
(ADR `adrs/2026-10-10-statusline-render-in-cli.md`).

## Steps

1. Segment change → edit `src/statusline-render.ts` and
   `src/statusline-render.spec.ts`; update `docs/use-cases.md`'s segment list.
2. New data for a segment → add it to `StatuslineState`
   (`src/interfaces/statusline.interface.ts`) and fill it in
   `buildStatuslineState` (`src/statusline.ts`). Keep the render path free of
   network calls and process spawns (`docs/performance.md`).
3. Colors: `ccColor()` must keep `colorForPct`'s buckets (`src/calc.ts`).
4. Shim change (`assets/statusline.mjs`) → the `managed v<hash>` marker is
   computed from the template plus the stamped entry URL; never hand-bump it.
   Keep the fallback line working when the import fails.
5. Never hand-edit `~/.claude/statusline.mjs`.
6. After the build, refresh the machine install:
   `pnpm build && cc-spend statusline`.
