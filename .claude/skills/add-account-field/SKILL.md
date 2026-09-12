---
name: add-account-field
description: Use when adding or changing a field on Config, UsageState, or any of their nested interfaces (src/interfaces/config.interface.ts) — covers defaults, docs/data-model.md, and accountKey() scoping.
---

# Add a field to Config/UsageState

Every account's `Config`/`UsageState` lives at
`~/.config/cc-daily-usage/accounts/<accountKey>/{config,usage}.json` — see
`docs/data-model.md` for the full current shape and `docs/architecture.md`'s
"Multi-account model" for `accountKey()`.

## Steps

1. Add the field to the interface in `src/interfaces/config.interface.ts`.
2. Add a matching default to `DEFAULT_CONFIG`/`DEFAULT_USAGE` — every
   existing on-disk file predates the new field and must load with a sane
   default, not `undefined` crashing a consumer.
3. Update `docs/data-model.md`'s field listing for the interface you
   changed.
4. Confirm the change doesn't assume a single account: never read/write
   outside `accountKey()`'s resolved directory, and never assume
   `"default"` is the only key in use.
5. Update the relevant spec(s) — 100% coverage is enforced.
6. Run the full verification sequence from
   `docs/testing-and-verification.md` before calling it done.
