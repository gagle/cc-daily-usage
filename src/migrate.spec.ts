import { describe, expect, it } from "vitest";

import { migrateRecord, schemaVersionOf } from "./migrate.js";

const steps = [
  (v: Record<string, unknown>) => ({ ...v, a: 1 }),
  (v: Record<string, unknown>) => ({ ...v, b: 2 }),
];

describe("schemaVersionOf", () => {
  it("reads an integer ≥ 0; anything else is version 0", () => {
    expect(schemaVersionOf({ schemaVersion: 3 })).toBe(3);
    expect(schemaVersionOf({})).toBe(0);
    expect(schemaVersionOf({ schemaVersion: "2" })).toBe(0);
    expect(schemaVersionOf({ schemaVersion: 1.5 })).toBe(0);
    expect(schemaVersionOf({ schemaVersion: -1 })).toBe(0);
  });
});

describe("migrateRecord", () => {
  it("runs every step from a legacy file and keeps unknown fields", () => {
    expect(migrateRecord({ keep: true }, steps)).toEqual({
      kind: "migrated",
      value: { keep: true, a: 1, b: 2, schemaVersion: 2 },
      from: 0,
    });
  });

  it("runs only the missing steps", () => {
    expect(migrateRecord({ schemaVersion: 1 }, steps)).toMatchObject({
      value: { schemaVersion: 2, b: 2 },
      from: 1,
    });
  });

  it("is a no-op on its own output", () => {
    const first = migrateRecord({}, steps);
    if (first.kind !== "migrated") throw new Error("expected a migration");
    expect(migrateRecord(first.value, steps)).toEqual({ kind: "current", value: first.value });
  });

  it("refuses a newer file", () => {
    expect(migrateRecord({ schemaVersion: 3 }, steps)).toEqual({ kind: "future", version: 3 });
  });
});
