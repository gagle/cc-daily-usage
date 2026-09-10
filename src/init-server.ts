import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfig } from "./config.js";
import {
  BodyTooLargeError,
  constantTimeEquals,
  isAllowedHost,
  openSystemExternal,
  readRequestBody,
  sendJson,
} from "./http-utils.js";
import type { Config } from "./interfaces/config.interface.js";
import { isInitPayload } from "./interfaces/init.interface.js";

const AUTH_HEADER = "x-cc-daily-usage-init-auth";
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_GAP_MS = 25 * 1000;

export interface InitServerOptions {
  readonly openBrowser?: (url: string) => void;
  readonly idleTimeoutMs?: number;
  readonly heartbeatGapMs?: number;
  readonly initialConfig?: Config;
  readonly usageMonthlySpent?: number;
  readonly accountKey?: string;
}

export type InitOutcome = "done" | "heartbeat-gap" | "idle-timeout";

export interface InitResult {
  readonly config: Config;
  readonly outcome: InitOutcome;
}

function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "assets");
}

/** Extracted so the request.url-missing fallback (never true over a real socket) is directly unit-testable. */
export function resolveUrl(request: Pick<IncomingMessage, "url">, port: number): URL {
  return new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
}

/**
 * Node's http parser only ever produces an array header value for a small allowlist (e.g. `set-cookie`) —
 * never for an arbitrary custom header like ours — but the type is `string | Array<string> | undefined`
 * regardless, so this is exercised directly rather than chasing an unreachable-over-HTTP branch.
 */
export function firstHeaderValue(value: string | Array<string> | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function renderPage(config: Config, monthlySpent: number, token: string): string {
  const template = readFileSync(path.join(assetsDir(), "init-calendar.html"), "utf8");
  const state = JSON.stringify({
    monthlyCap: config.monthlyCap,
    laboralDays: config.laboralDays,
    monthlySpent,
  });
  return template
    .replace("__CC_DAILY_USAGE_STATE__", state.replace(/</g, "\\u003c"))
    .replace("__CC_DAILY_USAGE_TOKEN__", JSON.stringify(token));
}

/**
 * Runs the `init` calendar-picker's local HTTP server (§7 of the plan). Autosaves every payload the page
 * POSTs to /save; ends on an explicit /done, a heartbeat gap (the page went quiet — tab closed), or the
 * absolute idle timeout (browser never opened at all). Resolves with the final on-disk config either way.
 */
export async function runInit(options: InitServerOptions = {}): Promise<InitResult> {
  const openBrowser = options.openBrowser ?? openSystemExternal;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const heartbeatGapMs = options.heartbeatGapMs ?? DEFAULT_HEARTBEAT_GAP_MS;
  const token = randomBytes(32).toString("base64url");
  const accountKey = options.accountKey ?? "default";
  let currentConfig = options.initialConfig ?? loadConfig(accountKey);
  const monthlySpent = options.usageMonthlySpent ?? 0;

  return new Promise((resolve) => {
    let idleTimer: NodeJS.Timeout;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (outcome: InitOutcome): void => {
      // Re-entrancy guard: a second /done, or a heartbeat/idle timer firing in the same tick as a request
      // already in flight, must not double-resolve the promise or double-close the server. Not reliably
      // reproducible as a deterministic black-box network test (it depends on exact connection-accept
      // timing), so it's excluded from the coverage denominator rather than chased with a flaky test.
      /* v8 ignore next */
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      server.close(() => {
        resolve({ config: currentConfig, outcome });
      });
    };

    const armIdleTimeout = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish("idle-timeout");
      }, idleTimeoutMs);
    };

    const armHeartbeatGap = (): void => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        finish("heartbeat-gap");
      }, heartbeatGapMs);
    };

    const server = http.createServer((request, response) => {
      void (async () => {
        const port = (server.address() as AddressInfo).port;
        if (!isAllowedHost(request.headers.host, port)) {
          sendJson(response, 403, { error: "Host not allowed" });
          return;
        }

        const url = resolveUrl(request, port);

        if (request.method === "GET" && url.pathname === "/") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(renderPage(currentConfig, monthlySpent, token));
          armIdleTimeout();
          armHeartbeatGap();
          return;
        }

        if (request.method !== "GET" && url.pathname === "/") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        if (
          request.method === "POST" &&
          (url.pathname === "/save" || url.pathname === "/heartbeat" || url.pathname === "/done")
        ) {
          const authValue = firstHeaderValue(request.headers[AUTH_HEADER]);
          if (!authValue || !constantTimeEquals(authValue, token)) {
            sendJson(response, 401, { error: "Unauthorized" });
            return;
          }

          if (url.pathname === "/save") {
            let body: string;
            try {
              body = await readRequestBody(request);
            } catch (error) {
              // The 413 branch is covered by the oversized-body test below. The 400 branch guards a raw
              // socket/stream error (client disconnects mid-body) — not reliably reproducible without a
              // flaky, timing-dependent raw-socket test, so it's excluded from the coverage denominator.
              /* v8 ignore next */
              sendJson(response, error instanceof BodyTooLargeError ? 413 : 400, {
                error: "Bad request",
              });
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              sendJson(response, 400, { error: "Invalid JSON" });
              return;
            }
            if (!isInitPayload(parsed)) {
              sendJson(response, 400, { error: "Invalid payload shape" });
              return;
            }
            currentConfig = { monthlyCap: parsed.monthlyCap, laboralDays: parsed.laboralDays };
            saveConfig(accountKey, currentConfig);
            sendJson(response, 200, { ok: true });
            armIdleTimeout();
            armHeartbeatGap();
            return;
          }

          if (url.pathname === "/heartbeat") {
            sendJson(response, 200, { ok: true });
            armIdleTimeout();
            armHeartbeatGap();
            return;
          }

          // /done
          sendJson(response, 200, { ok: true });
          finish("done");
          return;
        }

        sendJson(response, 404, { error: "Not found" });
      })();
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      armIdleTimeout();
      openBrowser(`http://127.0.0.1:${String(port)}/?token=${token}`);
    });
  });
}
