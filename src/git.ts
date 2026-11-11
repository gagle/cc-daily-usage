import { readFileSync, statSync } from "node:fs";
import path from "node:path";

function readTrimmed(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** The git dir for `dir`'s repo: walks up to the first `.git`. A `.git` FILE (linked worktree, submodule)
 * holds `gitdir: <path>`. */
function findGitDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".git");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"))?.[1];
      if (pointer) return path.resolve(dir, pointer.trim());
    } catch {
      // No .git here — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Current branch read straight from `.git/HEAD` — no `git` process (that spawn was the single slowest step
 * of every statusline render). Detached HEAD → short sha, like `git rev-parse --abbrev-ref HEAD` would give
 * "HEAD"; a sha is more useful. "" outside a repo or on any read failure.
 */
export function readGitBranch(cwd: string): string {
  const gitDir = findGitDir(cwd || ".");
  if (gitDir === null) return "";
  const head = readTrimmed(path.join(gitDir, "HEAD"));
  if (!head) return "";
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (ref) return ref;
  return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : "";
}
