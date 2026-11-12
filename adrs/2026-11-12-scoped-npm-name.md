# 2026-11-12 - Publish as @gllamas/cc-spend

## Status

Accepted. Changes the npm name of `adrs/2026-11-12-rename-to-cc-spend.md`.

## Context

npm refused `cc-spend`: it compares names without punctuation, and `ccspend` exists.

## Decision

The npm package is `@gllamas/cc-spend` (the publisher's scope; `publishConfig.access` is `public`). The command,
the bin file, the config directory and the repository name stay `cc-spend`.

## Options considered

| Option              | Why not / why                                               |
| ------------------- | ----------------------------------------------------------- |
| `@gllamas/cc-spend` | chosen: a scope is never compared with unscoped names       |
| `claude-costline`   | free, but a second full rename of command, config dir, repo |
| `cc-spendline`      | free, but a second full rename of command, config dir, repo |

## Consequences

- Install with `npm install -g @gllamas/cc-spend`; the command is still `cc-spend`.
