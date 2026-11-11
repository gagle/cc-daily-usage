---
name: add-account-field
description: Use when adding or changing a persisted field on Config, UsageState, ApiCache or their nested types (src/interfaces/config.interface.ts) — covers defaults, upgradeUsage for old files, docs/data-model.md, and accountKey() scoping.
---

# Add a persisted field

Files and fields: `docs/data-model.md`. Scoping: `docs/architecture.md`
("Multi-account model").

## Steps

1. Add the field to `src/interfaces/config.interface.ts`.
2. Defaults: `DEFAULT_CONFIG` for `Config`; `freshUsage` and `upgradeUsage`
   (`src/calc.ts`) for `UsageState` — existing files predate the field and must
   load without `undefined` reaching a consumer. Bump `USAGE_SCHEMA_VERSION`
   only when old data needs a conversion.
3. `api-cache.json` is written only by the refresher (`src/refresh.ts`); never
   write it from a render.
4. Writes go through `saveConfig`/`saveUsage`/`saveApiCache` (atomic). Never
   read/write outside `accountKey()`'s directory.
5. Update `docs/data-model.md` and the specs (100% coverage).
6. Full sequence in `docs/testing-and-verification.md`.
