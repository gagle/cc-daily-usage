# 2026-10-10 - Terminal-only UI: no Ink, no browser picker, plan-gated calendar

## Status

Accepted

## Context

- `calendar` imported Ink + React: ~330 ms before the first frame.
- `init` opened a browser picker (`assets/init-calendar.html`) backed by a
  loopback HTTP server — a second UI and an attack surface for one form.
- On Pro/Max the calendar booted into an empty view.

## Decision

- The calendar is a dependency-free ANSI renderer: pure render + pure key
  reducer + a thin raw-mode loop (`src/calendar-tui.ts`). The package has no
  runtime dependencies.
- The browser picker, its loopback server and HTTP hardening are removed;
  `init` is terminal-only (statusline, Mon–Fri offer, then the calendar).
- `calendar` checks the plan first and prints a boxed notice
  (`src/notice.ts`) for Pro/Max/unknown without loading the UI.
- Past days are dimmed and their laboral mark is locked; `u` may still correct
  past amounts. Today is highlighted.

## Consequences

First frame ~80–90 ms. Fewer moving parts to secure and publish.

## Verification

`src/calendar-tui.spec.ts`, `src/notice.spec.ts`, `src/cli.spec.ts`,
`e2e/cli.spec.ts`, manual plan sections C and D.
