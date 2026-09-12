# Testing & verification

## Coverage policy

100% coverage is enforced — `vitest.config.ts` sets
`coverage.thresholds = { statements: 100, branches: 100, functions: 100, lines: 100 }`.
A change without a matching spec update fails `pnpm test`.

Untestable branches use the standard v8 ignore convention inline at the use site
(`/* v8 ignore next */` or `/* v8 ignore start */` … `/* v8 ignore stop */`) — look
at the existing use sites in `src/*.ts` rather than inventing a new pattern.

## Verification commands

Run before calling any change done, scoped to what changed where practical:

```
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm run test:e2e && pnpm build
```

For a single affected spec while iterating:

```
pnpm vitest run src/<file>.spec.ts
```

`test:e2e` (built-binary smoke tests, `e2e/cli.spec.ts`) and `build` only need
re-running when `bin/`, `dist/` output, or the CLI's built entrypoint behavior
changed — not for a docs-only or single-unit-test change.

## Exemplar test

`src/calc.spec.ts` is the exemplar to model new tests on — it exercises every
branch of `calc.ts`'s pure functions (see `docs/calculations.md`) with plain
input/output assertions, no mocking needed since `calc.ts` has no I/O.

## CI

`.github/workflows/ci.yml` mirrors the verification commands above — this is
the real merge gate, not an approximation:

| Job                       | Runs                                                                        | When          |
| ------------------------- | --------------------------------------------------------------------------- | ------------- |
| `lint`                    | `pnpm run lint` → `pnpm run typecheck` → `pnpm run format:check`            | every push/PR |
| `build`                   | `pnpm run build`                                                            | every push/PR |
| `test`                    | `pnpm run test` → `pnpm run test:e2e`, uploads `coverage/` artifact         | every push/PR |
| `coverage` (needs `test`) | posts the coverage report as a PR comment (`vitest-coverage-report-action`) | PR only       |

`lint`, `build`, `test` run in parallel, not sequentially — all three must
pass for a merge. The commands above (single combined line) are the same
checks, just run locally in one shot instead of three parallel jobs.
