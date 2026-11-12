/** Terminal notices printed instead of booting a UI. Plain ANSI, no dependency — so the message shows
 * at Node's own startup speed. */

export interface NoticeStyle {
  readonly color: boolean;
}

export function noticeStyle(
  stream: { readonly isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): NoticeStyle {
  return { color: stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb" };
}

/** Visible width of a line: ANSI codes stripped, emoji/wide symbols counted as 2 columns. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const char of plain) {
    // A for…of character always has a code point; the fallback only satisfies the type.
    /* v8 ignore next */
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200d) continue; // zero-width joiner
    if (code === 0xfe0f) {
      width += 1; // emoji presentation selector: the preceding symbol renders 2 columns wide
      continue;
    }
    width += code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf) ? 2 : 1;
  }
  return width;
}

function paint(style: NoticeStyle, code: string, text: string): string {
  return style.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** A rounded box around `lines`, title in the top border. */
export function box(style: NoticeStyle, title: string, lines: ReadonlyArray<string>): string {
  const inner = Math.max(visibleWidth(title) + 2, ...lines.map(visibleWidth)) + 2;
  const border = (text: string): string => paint(style, "38;2;100;180;255", text);
  const top =
    border("╭─ ") +
    paint(style, "1", title) +
    border(` ${"─".repeat(inner - visibleWidth(title) - 3)}╮`);
  const body = lines.map(
    (line) => `${border("│")} ${line}${" ".repeat(inner - 1 - visibleWidth(line))}${border("│")}`,
  );
  const bottom = border(`╰${"─".repeat(inner)}╯`);
  return [top, ...body, bottom].join("\n");
}

const PLAN_NAMES: Readonly<Record<string, string>> = {
  claude_pro: "Claude Pro",
  claude_max: "Claude Max",
  claude_team: "Claude Team",
  claude_enterprise: "Claude Enterprise",
};

export function planName(planType: string | null | undefined): string {
  if (!planType) return "no Claude login";
  return PLAN_NAMES[planType] ?? planType;
}

/** Why `calendar` does not open on this account. `unknown`: the plan was never detected yet.
 * Glyphs are wide emoji (U+1F000+) only: a symbol + U+FE0F such as `ℹ️` is 1 column in some terminals and 2
 * in others, so no width count can keep the right border straight. */
export function calendarUnavailableNotice(
  style: NoticeStyle,
  planType: string | null | undefined,
  reason: "subscription" | "unknown",
): string {
  const dim = (text: string): string => paint(style, "2", text);
  const accent = (text: string): string => paint(style, "38;2;220;200;0", text);
  const lines =
    reason === "subscription"
      ? [
          `👤 Your plan: ${accent(planName(planType))}`,
          "",
          "📅 The calendar plans a monthly $ budget over your work days.",
          "   It is for Claude Team / Enterprise accounts with a spend cap.",
          "",
          "Your plan has seat limits instead. The statusline shows them:",
          `   ⏱  5-hour and 7-day usage   ${dim("(fresh at session start)")}`,
          `   🎫 usage credits             ${dim("(when they are on)")}`,
          `   🔥 prompt-cache cost of your next message`,
          "",
          `Set it up with: ${accent("cc-spend statusline")}`,
        ]
      : [
          `🔍 Plan not detected yet ${dim(`(${planName(planType)})`)}`,
          "",
          "📅 The calendar is for Claude Team / Enterprise dollar budgets.",
          "   Start one Claude Code session with the statusline installed",
          "   so cc-spend can detect your plan, then run this again.",
          "",
          `Install the statusline: ${accent("cc-spend statusline")}`,
        ];
  return box(style, "cc-spend calendar", lines);
}
