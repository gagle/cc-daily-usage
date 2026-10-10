# 2026-10-10 - Render the statusline in-process, in tested TypeScript

## Status

Accepted

## Context

`assets/statusline.mjs` held ~250 lines of rendering with no tests, and every
render spawned a shell → the package-manager shim → a second Node process
(`cc-daily-usage --statusline`), then `git`. Measured ~181–232 ms per render.

## Decision

- Rendering moves to `src/statusline-render.ts` (pure, 100% covered); the
  pipeline to `src/statusline.ts`.
- The installed file becomes a shim that `import()`s the package's
  `dist/statusline.js` by an absolute `file://` URL stamped at install time,
  and prints a minimal line if the package is gone.
- The content hash covers the stamped URL, so moving the package re-installs.
- Branch from `.git/HEAD` (`src/git.ts`), no `git` spawn.
- `--statusline` (JSON) stays for old shims and the capture-only line.

## Consequences

~89 ms per render (Node startup ~45 ms). A package path change needs
`cc-daily-usage statusline` once (the fallback line tells the user).

## Verification

`src/statusline-render.spec.ts`, `src/statusline.spec.ts`,
`src/statusline-install.spec.ts`, `docs/performance.md`, manual plan A4/A5.
