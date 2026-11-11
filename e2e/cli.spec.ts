import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "cc-daily-usage.js",
);

describe("cc-daily-usage CLI (built)", () => {
  it("prints the usage block for --help", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--help"]);
    expect(stdout).toContain("cc-daily-usage <operation>");
    expect(stdout).toContain("calendar");
    expect(stdout).toContain("init");
    expect(stdout).toContain("statusline");
  });

  it("exits non-zero with a clear message for an unknown operation", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "bogus-op"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown argument: bogus-op"),
    });
  });

  it("exits non-zero with a clear message for an unknown flag", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "init", "--nope"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown argument: --nope"),
    });
  });

  describe("first run in an empty HOME", () => {
    // The detached usage refresher may still be writing into HOME when a test ends: cleanup retries.
    function sandbox(organizationType: string): string {
      const home = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-e2e-"));
      writeFileSync(
        path.join(home, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "e2e@example.com", organizationType } }),
      );
      return home;
    }

    function run(home: string, args: Array<string>, input = ""): { stdout: string; ms: number } {
      const started = performance.now();
      const result = spawnSync("node", [BIN_PATH, ...args], {
        input,
        encoding: "utf8",
        // No network from the e2e run: the refresher has no token to use.
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_OAUTH_TOKEN: "" },
      });
      expect(result.status).toBe(0);
      return { stdout: result.stdout, ms: performance.now() - started };
    }

    it("statusline renders on the first call, writes no 1970 history, stays fast", () => {
      const home = sandbox("claude_enterprise");
      const payload = JSON.stringify({
        session_id: "e2e",
        model: { display_name: "Opus" },
        cost: { total_cost_usd: 1 },
      });
      run(home, ["--statusline-line"], payload); // warm the OS file cache
      const { stdout, ms } = run(home, ["--statusline-line"], payload);
      expect(stdout).toContain("🤖 Opus");
      expect(stdout).toContain("run: cc-daily-usage init");
      // Generous bound for shared CI runners; locally it is well under 150ms.
      expect(ms).toBeLessThan(1500);
      const usage = JSON.parse(
        readFileSync(
          path.join(home, ".config", "cc-daily-usage", "accounts", "e2e_example_com", "usage.json"),
          "utf8",
        ),
      ) as { days: Record<string, number> };
      expect(Object.keys(usage.days)).toHaveLength(0);
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it("garbage on stdin still prints a line", () => {
      const home = sandbox("claude_pro");
      expect(run(home, ["--statusline-line"], "{not json").stdout).toContain("⏱");
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it("calendar on Pro prints the notice; on enterprise without a TTY prints one frame", () => {
      const pro = sandbox("claude_pro");
      expect(run(pro, ["calendar"]).stdout).toContain("Claude Pro");
      const enterprise = sandbox("claude_enterprise");
      const frame = run(enterprise, ["calendar"]).stdout;
      expect(frame).toContain("This month:");
      expect(frame).toContain("q quit");
      rmSync(pro, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(enterprise, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  });
});
