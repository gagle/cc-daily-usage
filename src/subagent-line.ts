import { normalizeModelId } from "./pricing.js";

/** The `subagentStatusLine` task fields this reads (Claude Code v2.1.293+; every one may be absent). */
interface SubagentTask {
  readonly id?: string;
  readonly name?: string;
  readonly agentType?: string;
  readonly label?: string;
  readonly description?: string;
  readonly model?: string;
  readonly effort?: string | number;
  readonly tokenCount?: number;
  readonly contextWindowSize?: number;
}

interface SubagentPayload {
  readonly columns?: number;
  readonly tasks?: ReadonlyArray<SubagentTask>;
}

/** Same trigger as coach rule R1: a subagent on a premium model is usually the costliest avoidable spend. */
const PREMIUM_MODEL = /opus|fable|mythos/;

/** `claude-sonnet-5-5` → `Sonnet 5.5`; anything else is shown as given. */
export function shortModel(modelId: string): string {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(normalizeModelId(modelId));
  if (!match) return modelId;
  const [, family = "", version = ""] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replace("-", ".")}`;
}

/**
 * One agent-panel row: `Explore · find endpoints · 🤖 Sonnet 5.5 high · 41k (4%)`, cut to `columns`. A
 * premium model is drawn orange. Null without a task id (Claude Code keeps its own row).
 */
export function subagentRow(task: SubagentTask, columns: number): string | null {
  if (typeof task.id !== "string") return null;
  const model = typeof task.model === "string" ? task.model : null;
  const modelText = model
    ? `🤖 ${shortModel(model)}${task.effort === undefined ? "" : ` ${String(task.effort)}`}`
    : null;
  const tokens = typeof task.tokenCount === "number" ? task.tokenCount : null;
  const size = task.contextWindowSize;
  const tokenText =
    tokens === null
      ? null
      : `${String(Math.round(tokens / 1000))}k${
          typeof size === "number" && size > 0
            ? ` (${String(Math.round((tokens / size) * 100))}%)`
            : ""
        }`;
  const segments = [
    task.name ?? task.agentType,
    task.label ?? task.description,
    modelText,
    tokenText,
  ].filter((segment): segment is string => typeof segment === "string" && segment !== "");
  const plain = segments.join(" · ");
  if (plain.length > columns) return `${plain.slice(0, Math.max(0, columns - 1))}…`;
  if (modelText === null || model === null || !PREMIUM_MODEL.test(normalizeModelId(model))) {
    return plain;
  }
  return plain.replace(modelText, `\x1b[38;2;244;164;96m${modelText}\x1b[0m`);
}

/** The JSON lines Claude Code reads back: one `{ id, content }` per row we draw. */
export function subagentLines(raw: string): ReadonlyArray<string> {
  let payload: SubagentPayload;
  try {
    payload = JSON.parse(raw) as SubagentPayload;
  } catch {
    return [];
  }
  const columns = typeof payload.columns === "number" ? payload.columns : 80;
  const lines: Array<string> = [];
  const tasks: ReadonlyArray<SubagentTask> = Array.isArray(payload.tasks) ? payload.tasks : [];
  for (const task of tasks) {
    const content = subagentRow(task, columns);
    if (content !== null) lines.push(JSON.stringify({ id: task.id, content }));
  }
  return lines;
}

/** Hidden `--subagent-statusline`: the `subagentStatusLine` command. Never throws; a bad payload prints
 * nothing, so Claude Code keeps its default rows. Reads stdin itself: importing the statusline module would
 * cost every tick its startup. */
export async function runSubagentStatusline(raw?: string): Promise<number> {
  let text = raw;
  if (text === undefined) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString("utf8");
  }
  const lines = subagentLines(text);
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
