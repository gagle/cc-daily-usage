# 2026-10-10 - Fresh Pro/Max usage at session start without spending tokens

## Status

Accepted

## Context

A new Pro session showed the previous session's ⏱ numbers until the first
message. Cause (claude-code source, `src/services/claudeAiLimits.ts` and
`src/components/StatusLine.tsx`): Claude Code fills `rate_limits` from the
`anthropic-ratelimit-unified-*` headers of a model response, so the field is
absent until one exists. `/clear` sends no request, so it cannot help.

`GET /api/oauth/usage` (what `/usage` calls, `src/services/api/usage.ts` in the
claude-code source) is read-only, makes no model request and returns
`five_hour`/`seven_day` utilization plus `extra_usage`. We already called it,
but only read `extra_usage`, and inline on the render path (5 s timeout).

## Decision

- Parse the windows from `/api/oauth/usage` (`fetchUsage`).
- Move the call to a detached `--refresh` process with a per-account lock and a
  60 s TTL; renders read `api-cache.json` and never wait on the network.
- Show the hook's own `rate_limits` when present; otherwise the newer of the
  last hook snapshot (`seenAt`) and the API reading. Windows whose reset time
  passed are dropped.
- The installer sets `statusLine.refreshInterval: 30` so an idle session
  re-renders and picks up the refresh. No tokens are spent.

## Consequences

The first render of a session may still show the cache; the refreshed numbers
appear on the next render (≤ 30 s idle, or the next event). At most one HTTP
call per account per minute.

## Verification

`src/refresh.spec.ts`, `src/statusline.spec.ts` (`resolveRateLimits`), manual
plan E1–E4.
