# 2026-11-12 - Rename to cc-spend

## Status

Accepted.

## Context

The main goal of the tool is to make Claude Code spend visible: what you spent, what the next prompt costs,
and what to change. "cc-daily-usage" names one early feature (the daily budget) and says nothing about money.
The npm name was not published yet, so the rename costs nothing for npm users.

## Decision

- Package, command, bin file and config directory: `cc-spend`, `bin/cc-spend.js`, `~/.config/cc-spend/`.
- `moveLegacyRootDir` (`src/config.ts`) moves `~/.config/cc-daily-usage/` to `~/.config/cc-spend/` once, when
  only the old one exists. `runCli` and the shim's entry points call it first.
- The shim and capture markers also match the old name, so a shim installed before the rename upgrades in
  place on the next `cc-spend statusline`, with no "replace a foreign script" prompt. The installer finds our
  hooks by their flag, so it re-points them at the new bin.
- ADRs written before this one keep the old name (append-only).

## Options considered

| Option            | Why not / why                                                 |
| ----------------- | ------------------------------------------------------------- |
| `cc-spend`        | chosen: short, names money, fits every plan                   |
| `claude-ledger`   | longer to type; "Claude" in the name helps search only        |
| `cc-budget`       | fits Team plans with a cap; weak for Pro/Max                  |
| Keep the old name | wrong focus; the rename is free only before the first publish |

## Consequences

- An install from before the rename must run `cc-spend statusline` once. Until then its hooks call
  `bin/cc-daily-usage.js`, which no longer exists.
- The GitHub repository moves to `gagle/cc-spend`. npm trusted publishing binds to the repository name, so set
  it up after that move.
