export interface InitPayload {
  readonly monthlyCap: number;
  readonly laboralDays: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<number>>>>>;
}

export function isInitPayload(value: unknown): value is InitPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.monthlyCap !== "number") return false;
  if (typeof candidate.laboralDays !== "object" || candidate.laboralDays === null) return false;
  return Object.values(candidate.laboralDays as Record<string, unknown>).every((yearBlock) => {
    if (typeof yearBlock !== "object" || yearBlock === null) return false;
    return Object.values(yearBlock as Record<string, unknown>).every(
      (days) => Array.isArray(days) && days.every((day) => typeof day === "number"),
    );
  });
}
