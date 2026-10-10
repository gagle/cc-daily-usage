# Performance

Targets: the statusline and the calendar must feel instant; first-run setup
must not stall.

## Measured (macOS, Node 24, load average ~9, median of 15–31 runs)

| Path                                       | Before                                  | After              | Node `-e 0` baseline |
| ------------------------------------------ | --------------------------------------- | ------------------ | -------------------- |
| Statusline render (installed shim)         | ~181–232 ms                             | ~89 ms             | ~45 ms               |
| `cc-daily-usage calendar` first frame      | ~370–400 ms (Ink import alone ~330 ms)  | ~80–90 ms          | ~45 ms               |
| First statusline render on a fresh install | ~37 s (walk from 1970, 20k day entries) | same as any render | —                    |

Re-measure with `scripts/bench.sh` when touching the hot path. The e2e suite
(`e2e/cli.spec.ts`) asserts a fresh-HOME render stays under a generous CI
bound and writes no history.

## What makes it fast

1. **One process per render.** The shim (`assets/statusline.mjs`) imports the
   package in-process. The old shim spawned a shell, the package-manager shim,
   then a second Node.
2. **No network on the render path.** `/api/oauth/usage` moved to a detached
   refresher (`src/refresh.ts`); the macOS Keychain read moved with it.
3. **No `git` spawn.** `src/git.ts` reads `.git/HEAD` (worktrees included).
4. **No UI framework.** The calendar is plain ANSI with a pure renderer; React
   and Ink were removed (zero runtime dependencies).
5. **Lazy imports.** `src/cli.ts` loads each operation's modules only when that
   operation runs.
6. **O(1) rollover**, and **write skipping**: `lastUpdated` and `lastSeenAt`
   only move when needed, and `saveUsage` skips a write that changes nothing.
7. **Profile cache** for `CLAUDE_CODE_OAUTH_TOKEN` users: one profile fetch per
   token instead of one per render.

Tried and dropped: Node's module compile cache made no measurable difference
for this module count.
