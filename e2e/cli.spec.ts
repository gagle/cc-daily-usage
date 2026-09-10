import { execFile } from "node:child_process";
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
    expect(stdout).toContain("dashboard");
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
});
