---
name: verify-before-done
description: Use before declaring any change to cc-daily-usage done — the exact verification sequence, when to scope it to one spec file vs. the full run, and why (100% coverage gate, CI parity).
---

# Verify before calling a change done

Full source: `docs/testing-and-verification.md`. This skill is the quick
decision tree.

## Steps

1. While iterating on one file, run the scoped spec only:
   `pnpm vitest run src/<file>.spec.ts`.
2. Before calling ANY change done, run:
   ```
   pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm run test:e2e && pnpm build
   ```
3. After that build (and after any earlier build during the change), always
   refresh the machine install:
   ```
   cc-daily-usage statusline
   ```
   This stamps `assets/statusline.mjs` into `~/.claude/statusline.mjs` and
   keeps the live CLI statusline on the current code. Do it even when the
   change was only in `src/` (the installed script still spawns the built
   `cc-daily-usage --statusline` binary). Skip only for docs-only work that
   did not run a build.
4. Skip `test:e2e`/`build` only for a docs-only or single-spec change that
   doesn't touch `bin/`, `dist/` output, or CLI entrypoint behavior.
5. Coverage is 100% (statements/branches/functions/lines,
   `vitest.config.ts`) — a change without a matching spec update fails
   `pnpm test`. Don't reach for a v8-ignore comment to dodge this; only use
   the existing inline convention for genuinely untestable branches (see
   existing use sites in `src/*.ts`).
6. Steps 2's lint→test→e2e→build sequence is what `.github/workflows/ci.yml`
   runs (3 parallel jobs) — passing it locally means CI passes too, not an
   approximation. Step 3 is local-machine only (not CI).
