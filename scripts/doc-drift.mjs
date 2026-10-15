#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// The doc ↔ source map lives here and nowhere else. Each doc lists the source globs it documents; when one
// of those changes in a diff, `drift` names the doc to re-read. ADRs are append-only records — never edited
// to match today's code — so they are exempt.
const DOC_MAP = {
  "CLAUDE.md": ["package.json", ".claude/settings.json", ".github/workflows/**", "scripts/**"],
  "README.md": [
    "package.json",
    "bin/**",
    "src/cli.ts",
    "src/doctor.ts",
    "src/notice.ts",
    "src/statusline-render.ts",
    "src/statusline-install.ts",
  ],
  "docs/README.md": ["src/**", "assets/**"],
  "docs/architecture.md": [
    "src/cli.ts",
    "src/statusline.ts",
    "src/refresh.ts",
    "src/account.ts",
    "src/config.ts",
    "src/statusline-install.ts",
    "src/statusline-shared.ts",
    "src/statusline-capture-install.ts",
    "assets/statusline.mjs",
    "bin/**",
  ],
  "docs/calculations.md": ["src/calc.ts", "src/clock.ts"],
  "docs/coach.md": ["src/rules.ts", "src/insights.ts", "src/statusline-render.ts"],
  "docs/transcript-index.md": [
    "src/transcript-index.ts",
    "src/transcript-parse.ts",
    "src/report.ts",
    "src/refresh.ts",
  ],
  "docs/history-and-feed.md": [
    "src/limits-history.ts",
    "src/sessions-map.ts",
    "src/feed.ts",
    "src/refresh.ts",
  ],
  "docs/time-model.md": ["src/clock.ts", "src/calc.ts"],
  "docs/prompt-cache.md": [
    "src/cache-forecast.ts",
    "src/pricing.ts",
    "src/statusline-render.ts",
    "src/model-switch.ts",
  ],
  "docs/data-model.md": [
    "src/interfaces/**",
    "src/config.ts",
    "src/migrate.ts",
    "src/statusline-install.ts",
    "src/statusline-layout.ts",
  ],
  "docs/use-cases.md": [
    "src/cli.ts",
    "src/calendar-tui.ts",
    "src/settings-tui.ts",
    "src/statusline-layout.ts",
    "src/notice.ts",
    "src/statusline-render.ts",
  ],
  "docs/performance.md": [
    "src/statusline.ts",
    "src/refresh.ts",
    "src/git.ts",
    "src/calendar-tui.ts",
    "assets/statusline.mjs",
    "e2e/**",
  ],
  "docs/testing-and-verification.md": [
    "vitest.config.ts",
    "vitest.e2e.config.ts",
    ".github/workflows/**",
    "e2e/**",
  ],
  ".claude/skills/add-account-field/SKILL.md": [
    "src/interfaces/config.interface.ts",
    "src/config.ts",
  ],
  ".claude/skills/add-calc-formula/SKILL.md": ["src/calc.ts", "src/clock.ts"],
  ".claude/skills/debug-statusline-hook/SKILL.md": [
    "src/statusline.ts",
    "src/statusline-render.ts",
    "src/refresh.ts",
    "assets/statusline.mjs",
  ],
  ".claude/skills/update-statusline-template/SKILL.md": [
    "assets/statusline.mjs",
    "src/statusline-install.ts",
    "src/statusline-render.ts",
  ],
  ".claude/skills/verify-before-done/SKILL.md": [
    "package.json",
    "vitest.config.ts",
    ".github/workflows/**",
  ],
};

const EXEMPT_DOCS = ["adrs/**", ".claude/references/index.md", "CHANGELOG.md"];

const EXTERNAL_DOCS = ["docs/claude-code-upstream/**"];

const SOURCE_AREAS = ["src", "assets", "bin", "scripts", "e2e", ".github"];

const IGNORED_DIRS = new Set([
  ".code-review-graph",
  ".codegraph",
  ".git",
  ".idea",
  ".pnpm-store",
  ".tokensave",
  "coverage",
  "dist",
  "node_modules",
]);

const CITATION_PATTERN = /`([^`\n]+)`/g;
const LINE_SUFFIX_PATTERN = /^(.+?):(\d+)$/;
const PLACEHOLDER_PATTERN = /[*<>{}\s…|]/;
const EXTENSION_PATTERN = /\.[a-z0-9]+$/i;

function git(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    return out.split("\n").filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "drift mode needs the git binary on PATH to diff against a base ref — check mode does not",
      );
    }

    throw error;
  }
}

function globToRegex(glob) {
  let out = "";
  let i = 0;

  while (i < glob.length) {
    const char = glob[i];

    if (char === "*" && glob[i + 1] === "*") {
      const slashed = glob[i + 2] === "/";
      out += slashed ? "(?:.*/)?" : ".*";
      i += slashed ? 3 : 2;
      continue;
    }

    if (char === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }

    out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

function compile(globs) {
  return globs.map(globToRegex);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

const compiledMap = new Map(Object.entries(DOC_MAP).map(([doc, globs]) => [doc, compile(globs)]));
const compiledExempt = compile(EXEMPT_DOCS);
const compiledExternal = compile(EXTERNAL_DOCS);
const compiledAreas = compile(SOURCE_AREAS);

function collectFiles(dir, prefix, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      files.push(`${prefix}${entry.name}`);
      continue;
    }

    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    collectFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, files);
  }

  return files;
}

function repoFiles() {
  return collectFiles(".", "", []).sort();
}

function toFileSet(files) {
  return new Set(files);
}

function toDirSet(files) {
  const dirs = new Set();

  for (const file of files) {
    const segments = file.split("/");
    segments.pop();

    while (segments.length > 0) {
      dirs.add(segments.join("/"));
      segments.pop();
    }
  }

  return dirs;
}

function isSkippableCitation(citation, topLevel) {
  if (PLACEHOLDER_PATTERN.test(citation)) {
    return true;
  }

  if (
    citation.startsWith("./") ||
    citation.startsWith("/") ||
    citation.startsWith("~") ||
    citation.startsWith("http")
  ) {
    return true;
  }

  if (IGNORED_DIRS.has(citation.split("/")[0])) {
    return true;
  }

  if (!EXTENSION_PATTERN.test(citation)) {
    return true;
  }

  if (!citation.includes("/")) {
    return !citation.endsWith(".md");
  }

  return !topLevel.has(citation.split("/")[0]);
}

function resolvesToRepoFile(citation, files, dirs, basenames) {
  if (!citation.includes("/")) {
    return basenames.has(citation);
  }

  const candidates = [citation];

  if (citation.endsWith(".js")) {
    candidates.push(citation.replace(/\.js$/, ".ts"));
  }

  return candidates.some((candidate) => files.has(candidate) || dirs.has(candidate));
}

function topLevelEntries(files) {
  return new Set(files.map((file) => file.split("/")[0]));
}

function basenameEntries(files) {
  return new Set(files.map((file) => file.split("/").pop()));
}

function checkCitations(docs, files, dirs, topLevel, basenames) {
  const missing = [];
  const lineNumbered = [];

  for (const doc of docs) {
    if (matchesAny(doc, compiledExempt) || matchesAny(doc, compiledExternal)) {
      continue;
    }

    const content = readFileSync(doc, "utf8");

    for (const [, raw] of content.matchAll(CITATION_PATTERN)) {
      const citation = raw.replace(/^@\//, "");
      const lineMatch = LINE_SUFFIX_PATTERN.exec(citation);
      const bare = lineMatch ? lineMatch[1] : citation;

      if (isSkippableCitation(bare, topLevel)) {
        continue;
      }

      if (!resolvesToRepoFile(bare, files, dirs, basenames)) {
        missing.push({ doc, citation: raw });
        continue;
      }

      if (lineMatch) {
        lineNumbered.push({ doc, citation: raw });
      }
    }
  }

  return { missing, lineNumbered };
}

function checkCoverage(docs, files) {
  const problems = [];
  const mapped = new Set(Object.keys(DOC_MAP));

  for (const doc of docs) {
    if (mapped.has(doc) || matchesAny(doc, compiledExempt) || matchesAny(doc, compiledExternal)) {
      continue;
    }

    problems.push(
      `unmapped doc: ${doc} — add it to DOC_MAP or EXEMPT_DOCS in scripts/doc-drift.mjs`,
    );
  }

  for (const doc of mapped) {
    if (!files.has(doc)) {
      problems.push(`DOC_MAP references a doc that does not exist: ${doc}`);
    }
  }

  const areas = new Set();

  for (const file of files) {
    const segments = file.split("/");

    for (let depth = 1; depth <= Math.min(2, segments.length - 1); depth += 1) {
      const area = segments.slice(0, depth).join("/");

      if (matchesAny(area, compiledAreas)) {
        areas.add(area);
      }
    }
  }

  for (const area of areas) {
    const covered = [...compiledMap.values()].some((patterns) =>
      [...files].some((file) => file.startsWith(`${area}/`) && matchesAny(file, patterns)),
    );

    if (!covered) {
      problems.push(
        `source area documented by nothing: ${area}/ — add it to a doc's globs in scripts/doc-drift.mjs`,
      );
    }
  }

  return problems;
}

function resolveBase(requested) {
  if (requested) {
    return requested;
  }

  for (const ref of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });

      return ref;
    } catch {
      continue;
    }
  }

  return "HEAD~1";
}

function changedFiles(base) {
  const committed = git(["diff", "--name-only", `${base}...HEAD`]);
  const working = git(["diff", "--name-only", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);

  return new Set([...committed, ...working, ...untracked]);
}

function checkDrift(base) {
  const changed = changedFiles(base);

  if (changed.size === 0) {
    return [];
  }

  const drift = [];

  for (const [doc, patterns] of compiledMap) {
    if (changed.has(doc)) {
      continue;
    }

    const triggers = [...changed].filter((file) => matchesAny(file, patterns));

    if (triggers.length > 0) {
      drift.push({ doc, triggers });
    }
  }

  return drift;
}

function docsOnDisk(files) {
  return files.filter((file) => file.endsWith(".md"));
}

function reportCitations(result) {
  if (result.missing.length > 0) {
    console.error(
      `\n✖ ${result.missing.length} doc citation(s) point at paths that do not exist:\n`,
    );

    for (const { doc, citation } of result.missing) {
      console.error(`  ${doc}  →  \`${citation}\``);
    }
  }

  if (result.lineNumbered.length > 0) {
    console.error(
      `\n✖ ${result.lineNumbered.length} doc citation(s) carry a line number (they rot on the next edit):\n`,
    );

    for (const { doc, citation } of result.lineNumbered) {
      console.error(`  ${doc}  →  \`${citation}\``);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.find((arg) => !arg.startsWith("-")) ?? "check";
  const baseArg = args.find((arg) => arg.startsWith("--base="));
  const quiet = args.includes("--quiet");
  const strict = args.includes("--strict");

  if (mode === "drift") {
    const drift = checkDrift(resolveBase(baseArg?.slice("--base=".length)));

    if (drift.length === 0) {
      if (!quiet) {
        console.log("✔ no documentation drift against the current diff");
      }

      return 0;
    }

    console.log(
      `📄 ${drift.length} doc(s) may be stale — source they document changed in this diff:\n`,
    );

    for (const { doc, triggers } of drift) {
      console.log(`  ${doc}`);
      console.log(
        `      ← ${triggers.slice(0, 6).join(", ")}${triggers.length > 6 ? `, +${triggers.length - 6} more` : ""}`,
      );
    }

    console.log("\nRead each doc against the changed source and correct what is now false.");
    console.log(
      "Nothing to fix if the change does not alter documented behaviour — say so and move on.",
    );

    return strict ? 1 : 0;
  }

  const files = repoFiles();
  const fileSet = toFileSet(files);
  const dirSet = toDirSet(files);
  const docs = docsOnDisk(files);

  const citations = checkCitations(
    docs,
    fileSet,
    dirSet,
    topLevelEntries(files),
    basenameEntries(files),
  );
  const coverage = checkCoverage(docs, fileSet);
  const failed = citations.missing.length + citations.lineNumbered.length + coverage.length;

  reportCitations(citations);

  if (coverage.length > 0) {
    console.error(`\n✖ ${coverage.length} documentation coverage problem(s):\n`);

    for (const problem of coverage) {
      console.error(`  ${problem}`);
    }
  }

  if (failed === 0) {
    console.log(
      `✔ ${docs.length} docs: every path citation resolves, no line numbers, coverage complete`,
    );

    return 0;
  }

  console.error("");

  return 1;
}

process.exit(main());
