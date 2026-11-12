import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGitBranch } from "./git.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cc-spend-git-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readGitBranch", () => {
  it("reads the branch from .git/HEAD, walking up from a subdirectory", () => {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    expect(readGitBranch(path.join(root, "a", "b"))).toBe("feat/x");
  });

  it("detached HEAD → short sha", () => {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    expect(readGitBranch(root)).toBe("0123456");
  });

  it("follows a worktree .git file", () => {
    const real = path.join(root, "real-git");
    mkdirSync(real);
    writeFileSync(path.join(real, "HEAD"), "ref: refs/heads/wt\n");
    const worktree = path.join(root, "wt");
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../real-git\n");
    expect(readGitBranch(worktree)).toBe("wt");
  });

  it("'' outside a repo, for an empty/garbage HEAD, or a .git file without gitdir", () => {
    expect(readGitBranch(path.join(root, "nowhere"))).toBe("");
    mkdirSync(path.join(root, "garbage", ".git"), { recursive: true });
    writeFileSync(path.join(root, "garbage", ".git", "HEAD"), "nonsense");
    expect(readGitBranch(path.join(root, "garbage"))).toBe("");
    mkdirSync(path.join(root, "empty", ".git"), { recursive: true });
    expect(readGitBranch(path.join(root, "empty"))).toBe("");
    mkdirSync(path.join(root, "file"));
    writeFileSync(path.join(root, "file", ".git"), "not a pointer");
    expect(readGitBranch(path.join(root, "file"))).toBe("");
  });

  it("an empty cwd means the process cwd", () => {
    expect(typeof readGitBranch("")).toBe("string");
  });
});
