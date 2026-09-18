#!/usr/bin/env node
// Claude Code status line — reads session JSON from stdin, prints one ANSI line.
// cc-daily-usage:managed v__CC_DAILY_USAGE_VERSION__
// cc-daily-usage:capture v1
//
// Installed by `cc-daily-usage statusline`. Re-running that command is idempotent — it detects the marker
// above and silently no-ops/upgrades instead of prompting or backing up again. Don't hand-edit this file;
// your changes will be silently overwritten on the next managed re-install.
import { spawnSync } from "node:child_process";
import path from "node:path";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
const payload = raw.trim() === "" ? {} : JSON.parse(raw);

const cwd = payload.workspace?.current_dir ?? "";
const repo = payload.workspace?.repo?.name || path.basename(payload.workspace?.project_dir ?? "");
const model = payload.model?.display_name ?? "";
const effort = payload.effort?.level ?? "";
const rl5hRaw = payload.rate_limits?.five_hour?.used_percentage;
const rl7dRaw = payload.rate_limits?.seven_day?.used_percentage;
const rl5hResetsAtRaw = payload.rate_limits?.five_hour?.resets_at;
const rl7dResetsAtRaw = payload.rate_limits?.seven_day?.resets_at;
const pctraw = payload.context_window?.used_percentage ?? 0;
const cost = payload.cost?.total_cost_usd ?? 0;
const added = payload.cost?.total_lines_added;
const removed = payload.cost?.total_lines_removed;
const totalDurationMs = payload.cost?.total_duration_ms;

// cc-daily-usage: fetched up front (not where its segments render further down) so the cached_rl5h/cached_rl7d
// fallback below is available before the native ⏱ block runs. A failed/missing `cc-daily-usage` on PATH, or
// before config.json exists, silently degrades to no fallback/segments — same as the old `2>/dev/null || echo ""`.
// Single string, not [cmd, args] — shell:true with a separate args array is unescaped (Node's DEP0190).
// Safe here regardless: the command is a fixed literal, nothing user-controlled goes into it.
let statusline = null;
try {
  const result = spawnSync("cc-daily-usage --statusline", {
    input: raw,
    encoding: "utf8",
    shell: true,
  });
  if (result.status === 0 && result.stdout.trim() !== "") {
    statusline = JSON.parse(result.stdout);
  }
} catch {
  statusline = null;
}

// git resolves as a real executable (not an npm-shim .cmd) on every platform — no shell needed.
let branch = "";
try {
  const result = spawnSync(
    "git",
    ["-C", cwd || ".", "--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  );
  if (result.status === 0) branch = result.stdout.trim();
} catch {
  branch = "";
}

const pct = Math.trunc(Number(pctraw)) || 0;
const filled = Math.min(Math.floor(pct / 5), 20);

let emoji;
let er;
let eg;
let eb;
if (pct < 20) {
  emoji = "🟢";
  er = 0;
  eg = 200;
  eb = 80;
} else if (pct < 70) {
  emoji = "⚡";
  er = 220;
  eg = 200;
  eb = 0;
} else if (pct < 90) {
  emoji = "🔥";
  er = 230;
  eg = 120;
  eb = 0;
} else {
  emoji = "🚨";
  er = 220;
  eg = 40;
  eb = 20;
}

// Color cells by position on the full 20-cell bar (not within filled span),
// so low percentages stay green instead of ending on a red tip.
let bar = "";
for (let i = 1; i <= 20; i++) {
  if (i <= filled) {
    const frac = Math.floor((i * 100) / 20);
    let r;
    let g;
    let b;
    if (frac <= 50) {
      const t = frac * 2;
      r = Math.floor((220 * t) / 100);
      g = 200;
      b = Math.floor(80 - (80 * t) / 100);
    } else {
      const t = (frac - 50) * 2;
      r = 220;
      g = Math.floor(200 - (160 * t) / 100);
      b = Math.floor((20 * t) / 100);
    }
    bar += `\x1b[38;2;${r};${g};${b}m█`;
  } else {
    bar += "\x1b[38;2;60;60;60m█";
  }
}
bar += "\x1b[0m";

const sep = "\x1b[2;38;2;120;120;120m|\x1b[0m";
let line = `\x1b[1;38;2;220;200;0m${repo}\x1b[0m ${sep}`;

if (branch) {
  line += ` \x1b[1;38;2;0;200;200m(🌿 ${branch})\x1b[0m ${sep}`;
}

line += ` ${bar} ${emoji} \x1b[38;2;${er};${eg};${eb}m${pct}%\x1b[0m ${sep} \x1b[38;2;220;200;0m$${Number(cost).toFixed(2)}\x1b[0m`;

// Session wall-clock elapsed — distinct from the ⏱ rate-limit-window segment further down, which is
// Claude's subscription usage window, not this session's own duration. `total_duration_ms` is absent
// only before the very first hook payload (no session yet), so a plain undefined check is enough.
if (totalDurationMs !== undefined) {
  const totalSec = Math.floor(totalDurationMs / 1000);
  const durH = Math.floor(totalSec / 3600);
  const durM = Math.floor((totalSec % 3600) / 60);
  const durS = totalSec % 60;
  const durFmt = durH > 0 ? `${durH}h ${durM}m` : `${durM}m ${durS}s`;
  line += ` ${sep} \x1b[38;2;150;150;150m⏲ ${durFmt}\x1b[0m`;
}

if (added !== undefined || removed !== undefined) {
  line += ` ${sep} \x1b[38;2;0;200;80m+${added ?? 0}\x1b[0m\x1b[38;2;220;40;20m-${removed ?? 0}\x1b[0m`;
}

line += ` ${sep} \x1b[38;2;200;0;200m🤖 ${model}\x1b[0m`;

if (effort) {
  line += ` ${sep} \x1b[38;2;150;150;250m💪 ${effort}\x1b[0m`;
}

// Seat windows (⏱) are Pro/Max-only in this statusline. Enterprise uses the $ self-budget instead.
if (statusline?.hasSpendCap === false) {
  const rl5h = rl5hRaw ?? statusline?.rateLimitsCache?.fiveHourPct;
  const rl7d = rl7dRaw ?? statusline?.rateLimitsCache?.sevenDayPct;
  const hasLiveRateLimits =
    (rl5h !== undefined && rl5h !== null) || (rl7d !== undefined && rl7d !== null);

  if (hasLiveRateLimits) {
    let rlParts = "";
    if (rl5h !== undefined && rl5h !== null) {
      rlParts = `${Math.round(rl5h)}%/5h`;
    }
    if (rl7d !== undefined && rl7d !== null) {
      if (rlParts) rlParts += " ";
      rlParts += `${Math.round(rl7d)}%/7d`;
    }
    line += ` ${sep} \x1b[38;2;100;180;255m⏱ ${rlParts}\x1b[0m`;
  } else {
    // First login / cleared cache / before Claude attaches rate_limits.
    line += ` ${sep} \x1b[38;2;100;180;255m⏱ —/5h —/7d\x1b[0m`;
  }

  function formatResetTime(epochSeconds) {
    const resetDate = new Date(epochSeconds * 1000);
    const time = resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (resetDate.toDateString() === new Date().toDateString()) return time;
    return `${resetDate.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }

  const rl5hResetsAt = rl5hResetsAtRaw ?? statusline?.rateLimitsCache?.fiveHourResetsAt;
  const rl7dResetsAt = rl7dResetsAtRaw ?? statusline?.rateLimitsCache?.sevenDayResetsAt;

  if (rl5h !== undefined && rl5h !== null && rl5h >= 100 && rl5hResetsAt) {
    line += ` ${sep} \x1b[38;2;220;40;20m⚠ 5h resets ${formatResetTime(rl5hResetsAt)}\x1b[0m`;
  }
  if (rl7d !== undefined && rl7d !== null && rl7d >= 100 && rl7dResetsAt) {
    line += ` ${sep} \x1b[38;2;220;40;20m⚠ 7d resets ${formatResetTime(rl7dResetsAt)}\x1b[0m`;
  }
}

// cc-daily-usage: daily/monthly spend segments (§18 auto-capture + §9.2 segment order). Fields already
// extracted up top (see the ⏱ fallback above) — this just renders them, guarded on the same `statusline`.
if (statusline) {
  // colorForPct's 5-bucket thresholds (src/calc.ts), ported directly — highest threshold first, first match wins.
  function ccColor(frac) {
    if (frac >= 1) return "248;105;107";
    if (frac >= 0.75) return "244;164;96";
    if (frac >= 0.5) return "255;235;132";
    if (frac >= 0.25) return "161;215;106";
    return "99;190;123";
  }

  if (statusline.needsInit) {
    // First render ever for a dollar-cap account: laboral days/monthlyCap never configured, so the
    // today/month segments below would be meaningless defaults — a short nudge instead.
    line += ` ${sep} \x1b[38;2;220;200;0m⚠ run: cc-daily-usage init\x1b[0m`;
  } else {
    // Laboral: $today/$avg (pct). Non-laboral: $today only. day0 / real / pace live in the calendar UI.
    if (statusline.avgPerDay !== undefined && statusline.avgPerDay !== null) {
      const todayColor = ccColor(statusline.todayUsedPct);
      const todayPctDisplay = Math.round(statusline.todayUsedPct * 100);
      line += ` ${sep} \x1b[38;2;${todayColor}m$${(statusline.todayUsage ?? 0).toFixed(2)}/$${statusline.avgPerDay.toFixed(2)} (${todayPctDisplay}%)\x1b[0m`;
    } else if (statusline.todayUsage !== undefined && statusline.todayUsage !== null) {
      line += ` ${sep} \x1b[38;2;180;180;180m$${Number(statusline.todayUsage).toFixed(2)}\x1b[0m`;
    }

    // monthlyCap comes through absent once the account is known to have no dollar cap (config.hasSpendCap
    // === false, see cli.ts) — skip this fabricated $/$ segment entirely and let the ⏱ 5h/7d segment above
    // (real data straight from Claude Code's own hook payload) be the only usage indicator.
    if (statusline.monthlyCap !== undefined && statusline.monthlyCap !== null) {
      const monthColor = ccColor(statusline.monthUsedPct);
      const monthPctDisplay = Math.round(statusline.monthUsedPct * 100);
      line += ` ${sep} \x1b[38;2;${monthColor}m$${(statusline.monthlySpent ?? 0).toFixed(2)}/$${statusline.monthlyCap.toFixed(2)} (${monthPctDisplay}%)\x1b[0m`;
    }
  }

  // Usage credits (🎫): Pro/Max only. Enterprise already shows $month from the self-budget; cli.ts nulls
  // extraUsage there so this guard is belt-and-suspenders.
  if (statusline.hasSpendCap === false) {
    const extraUsed = statusline.extraUsage?.usedCredits;
    const extraLimit = statusline.extraUsage?.monthlyLimit;
    if (
      extraUsed !== undefined &&
      extraUsed !== null &&
      extraLimit !== undefined &&
      extraLimit !== null
    ) {
      const extraPct = (statusline.extraUsage?.utilizationPct ?? 0) / 100;
      const extraColor = ccColor(extraPct);
      const extraPctDisplay = Math.round(extraPct * 100);
      line += ` ${sep} \x1b[38;2;${extraColor}m🎫 $${extraUsed.toFixed(2)}/$${extraLimit.toFixed(2)} (${extraPctDisplay}%)\x1b[0m`;
    }
  }
}

process.stdout.write(line);
