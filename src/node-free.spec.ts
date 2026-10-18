import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Modules the /cost-tracker mod bundles: they (and everything they import) must not use Node built-ins. */
const SHARED_MODULES = [
  "calc.ts",
  "clock.ts",
  "pricing.ts",
  "cache-forecast.ts",
  "limits-history.ts",
  "transcript-parse.ts",
  "sessions-map.ts",
  "feed.ts",
  "rules.ts",
  "meter.ts",
  "session-model.ts",
  "live-render.ts",
  "advisor.ts",
  "next-action.ts",
] as const;

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Value imports (not `import type`) of a source file. */
function imports(file: string): ReadonlyArray<string> {
  const source = readFileSync(path.join(SRC, file), "utf8");
  return [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map(
    (m) => m[1] as string,
  );
}

describe("shared modules stay Node-free", () => {
  it.each(SHARED_MODULES)(
    "%s imports no node: module, directly or through its imports",
    (entry) => {
      const seen = new Set<string>();
      const queue: Array<string> = [entry];
      const builtins: Array<string> = [];
      while (queue.length > 0) {
        const file = queue.shift() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const spec of imports(file)) {
          if (spec.startsWith("node:")) builtins.push(`${file} → ${spec}`);
          else if (spec.startsWith("./")) queue.push(spec.slice(2).replace(/\.js$/, ".ts"));
          else builtins.push(`${file} → ${spec} (package)`);
        }
      }
      expect(builtins).toEqual([]);
    },
  );

  it("the import scan sees a node: import", () => {
    expect(imports("config.ts")).toContain("node:fs");
  });
});
