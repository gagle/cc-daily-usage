export const OPERATIONS = ["init", "statusline", "calendar", "settings", "uninstall"] as const;
export type Operation = (typeof OPERATIONS)[number];

export function isOperation(value: string): value is Operation {
  return (OPERATIONS as ReadonlyArray<string>).includes(value);
}
