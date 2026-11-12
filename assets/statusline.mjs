#!/usr/bin/env node
// Claude Code status line — reads session JSON from stdin, prints one ANSI line.
// cc-spend:managed v__CC_SPEND_VERSION__
// cc-spend:capture v1
//
// Installed by `cc-spend statusline`. A thin shim: it imports cc-spend in-process (one Node
// start per render, no shell, no second process), and src/statusline-render.ts draws the line. Re-running
// the installer is idempotent. Don't hand-edit this file; the next managed re-install overwrites it.
const ENTRY = "__CC_SPEND_ENTRY__";

let rendered = false;
try {
  const { runStatuslineLine } = await import(ENTRY);
  await runStatuslineLine();
  rendered = true;
} catch {
  // cc-spend moved or was uninstalled — fall through to a minimal line instead of a blank one.
}

if (!rendered) {
  let payload = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    payload = {};
  }
  const model = payload?.model?.display_name ?? "";
  const cost = Number(payload?.cost?.total_cost_usd ?? 0).toFixed(2);
  process.stdout.write(`🤖 ${model} | $${cost} | ⚠ cc-spend not found — reinstall it`);
}
