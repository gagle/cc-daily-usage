# 2026-10-15 - File versions, backups and a downgrade guard

## Status

Accepted

## Context

Only `usage.json` had a `schemaVersion`. With the mod reading CLI files and the
CLI installing a plugin, an older CLI could run after a newer one (for example
after an nvm switch) and rewrite a file in a format it does not know.

## Decision

- Every CLI file carries its own `schemaVersion`; missing = 0. File versions
  are independent of the npm and plugin versions.
- `migrateRecord` in `src/migrate.ts` runs ordered pure steps `vN → vN+1`,
  keeps unknown fields, and is a no-op on its own output.
- A migration that rewrites a file on load makes a backup first; 3 are kept.
- A file of a newer version is never written back (`writeVersionedFile`). The
  render shows `⚠ update cc-daily-usage`; commands print an npm hint.
- Corrupt JSON keeps the existing behaviour: a `.corrupt-<ms>` copy, then a
  re-seed. The copy keeps the data, so no change is needed.

## Options considered

| Option                                                       | Why not / why                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Refuse to run with any newer file                            | Takes the statusline down; a marker is enough                                         |
| Keep a corrupt file in place and use defaults in memory      | Every later save would then overwrite it anyway; the quarantine copy already keeps it |
| Migrate `api-cache.json` and `statusline.json` on the render | Adds writes to the render; the refresher and `settings` write the version             |

## Consequences

- First run after upgrade writes one `config.json.bak-*` per account.
- A newer config makes the older CLI read-only for that file until updated.

## Verification

`src/migrate.spec.ts`, `src/config.spec.ts`, manual plan section M.
