/** One step `vN → vN+1` of a file format: pure, keeps fields it does not know. */
export type Migration = (value: Record<string, unknown>) => Record<string, unknown>;

export type MigrateResult =
  | { readonly kind: "current"; readonly value: Record<string, unknown> }
  | { readonly kind: "migrated"; readonly value: Record<string, unknown>; readonly from: number }
  | { readonly kind: "future"; readonly version: number };

/** A missing or non-integer `schemaVersion` is version 0, the format before files were versioned. */
export function schemaVersionOf(value: Record<string, unknown>): number {
  const version = value.schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/**
 * Runs `migrations[from..]` in order; the current version is `migrations.length`. A file of a higher
 * version is `future`: written by a newer cc-daily-usage, so the caller must not rewrite it. Running it on
 * its own output is a no-op (`current`).
 */
export function migrateRecord(
  value: Record<string, unknown>,
  migrations: ReadonlyArray<Migration>,
): MigrateResult {
  const from = schemaVersionOf(value);
  if (from > migrations.length) return { kind: "future", version: from };
  if (from === migrations.length) return { kind: "current", value };
  let next = value;
  for (const step of migrations.slice(from)) next = step(next);
  return { kind: "migrated", value: { ...next, schemaVersion: migrations.length }, from };
}
