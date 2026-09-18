---
name: update-statusline-template
description: Use when editing assets/statusline.mjs (the statusline rendering template) — covers the content-hash marker bump, why the installed copy must never be hand-edited, and keeping ccColor() in sync with calc.ts.
---

# Update the statusline template

`assets/statusline.mjs` is the _template_. The installed copy at
`~/.claude/statusline.mjs` is a stamped, content-hashed version of it —
see `docs/data-model.md`'s "Statusline managed-file markers" table.

## Steps

1. Never hand-edit `~/.claude/statusline.mjs` directly — it's silently
   overwritten on the next managed install. Edit `assets/statusline.mjs`.
2. `statusline-install.ts` computes the `// cc-daily-usage:managed v<hash>`
   marker from the template's content — you don't hand-bump a version
   number, the hash updates automatically when the template content
   changes. Just confirm `statusline-install.spec.ts` still passes with the
   new content.
3. If you touched segment rendering order or a guard condition, update
   `docs/use-cases.md`'s "segment rendering" numbered list to match.
4. If you touched `ccColor()`, cross-check it against `calc.ts`'s
   `colorForPct` — the two must stay identical (`docs/calculations.md`
   flags this explicitly).
5. Run `pnpm vitest run src/statusline-install.spec.ts src/statusline-capture-install.spec.ts`,
   then the full verification sequence before calling it done.
6. After every build that follows a template (or hook-path) change, refresh
   the machine copy:
   ```
   pnpm build && cc-daily-usage statusline
   ```
   Never leave `~/.claude/statusline.mjs` on an old hash when `assets/` or
   `dist/` changed in this session.
