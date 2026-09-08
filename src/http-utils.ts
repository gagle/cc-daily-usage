import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 256 * 1024;

/** Constant-time comparison — a plain `===` would leak timing info about how many leading bytes matched. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Defends against DNS rebinding: a request's Host header must name the loopback address, at the bound port. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const [host, portStr] = hostHeader.split(":");
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  return portStr === undefined || Number(portStr) === port;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the size cap");
  }
}

/** Manually buffered body read, capped at 256KB — rejects and destroys the connection on overflow. */
export async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Array<Buffer> = [];
  let total = 0;
  let overflowed = false;
  return new Promise((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      if (overflowed) return; // already rejected; stop accumulating, let the caller respond and move on
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflowed = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: Error) => {
      reject(error);
    });
  });
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

export function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

/** Well-formed http:/https: URL check — defensive even though callers build the URL themselves. */
export function normalizeExternalTarget(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to open non-http(s) URL: ${url}`);
  }
  return parsed.toString();
}

/** Cross-platform "open the browser", detached + unref'd, matching claude-code-router's execDetached shape. */
export function openSystemExternal(url: string): void {
  const target = normalizeExternalTarget(url);
  const [command, args] =
    process.platform === "darwin"
      ? ["/usr/bin/open", [target]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
