## Behavior

- Show doubt when doubt real. Code minimal. No fake abstraction for maybe-future. Touch only what task need.
- Define win before start. Check with lint, type-check, tests. Bar high, staff-engineer high.
- Plan mode for 3+ step or big architecture. NEVER spawn subagent, any circumstance. ALWAYS run task, audit, review, command direct in main Claude session.
- User correct you → update skill / nested rule / reference. Not scratch lesson file.
- Track progress. Elegant fix beat hack. CI/log bug fix alone: simple, permanent — **except `.env`** (ask first; see safety below).

# cc-daily-usage

Claude Code spend/usage tracker: CLI + statusline + terminal calendar. Zero runtime dependencies.

## Load on demand

See `.claude/references/index.md` for pointers into `docs/` — load only the file relevant to the current task.

## Docs and ADRs

- `docs/` describes the code as it is now, for an LLM to read instead of `src/`. `adrs/` records decisions and is append-only (a changed decision is a new ADR); the manual test plan is `adrs/2026-10-10-manual-test-plan.md`.
- The doc ↔ source map lives in `scripts/doc-drift.mjs` (`DOC_MAP`) and nowhere else. `pnpm docs:check` is a CI gate: backticked repo paths must resolve, no `:line` citations, every doc mapped or exempt, every source area documented.
- `pnpm docs:drift` lists docs whose sources changed in the diff; the Stop hook runs it once per session. Correct what is now false in the same change; if behaviour did not change, say so and stop.
- Never cite a line number; never state a number the code owns (test counts, file counts).
- A user-facing change adds or updates its row in the manual test plan.

## Performance rules

- The statusline render path never touches the network and spawns nothing but the detached refresher. Branch comes from `.git/HEAD`.
- No UI framework in the calendar; operations lazy-import their modules. Measure with `scripts/bench.sh` against `docs/performance.md`.

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

This project has a code-review-graph knowledge graph. Use it for
**structural follow-up** (callers, dependents, impact, review context,
coverage) — not as the first tool for open-ended "how/where" discovery.
When zvec-grep is available, natural-language workspace discovery goes to
`mcp__zvec_grep__zvec_grep_search` first; exact lookup stays on Grep/`rg`.
Reach for code-review-graph after that, or when the user asks for review,
impact, or graph relationships.

### When to use graph tools

- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture overview**: `get_architecture_overview_tool` + `list_communities_tool` after zg discovery when you need community/flow structure
- **Named-symbol graph lookup**: `semantic_search_nodes_tool` or `query_graph_tool` when you already know the symbol

Fall back to Grep/Glob/Read when neither zg nor the graph covers what you need.

### Key Tools

| Tool                             | Use when                                               |
| -------------------------------- | ------------------------------------------------------ |
| `detect_changes_tool`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context_tool`        | Need source snippets for review — token-efficient      |
| `get_impact_radius_tool`         | Understanding blast radius of a change                 |
| `get_affected_flows_tool`        | Finding which execution paths are impacted             |
| `query_graph_tool`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview_tool` | Understanding high-level codebase structure            |
| `refactor_tool`                  | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
