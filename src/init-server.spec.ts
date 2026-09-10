import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  loadConfig: vi.fn((_accountKey: string) => ({ monthlyCap: 200, laboralDays: {} })),
  saveConfig: vi.fn(),
}));

vi.mock("./http-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HttpUtilsModule>();
  return { ...actual, openSystemExternal: vi.fn() };
});

import { saveConfig } from "./config.js";
import type * as HttpUtilsModule from "./http-utils.js";
import { openSystemExternal } from "./http-utils.js";
import { firstHeaderValue, resolveUrl, runInit } from "./init-server.js";

interface StartedRun {
  readonly port: number;
  readonly token: string;
  readonly promise: Promise<{ config: unknown; outcome: string }>;
}

function start(overrides: Parameters<typeof runInit>[0] = {}): StartedRun {
  let capturedUrl = "";
  const promise = runInit({
    openBrowser: (url) => {
      capturedUrl = url;
    },
    idleTimeoutMs: 60_000,
    heartbeatGapMs: 60_000,
    initialConfig: { monthlyCap: 200, laboralDays: {} },
    ...overrides,
  });
  // openBrowser is called synchronously inside the listen callback before this function returns control,
  // but listen is async — poll a microtask tick via a tiny delay in the caller instead.
  return {
    get port() {
      const match = /:(\d+)\//.exec(capturedUrl);
      return match ? Number(match[1]) : 0;
    },
    get token() {
      const match = /token=([^&]+)/.exec(capturedUrl);
      return match ? match[1] : "";
    },
    promise,
  } as unknown as StartedRun;
}

async function waitForListening(run: StartedRun): Promise<void> {
  for (let i = 0; i < 100 && run.port === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawRequest(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, ...options }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

describe("runInit", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the browser with a token in the URL and serves the calendar page on GET /", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(run.port, { path: "/", method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Laboral days");
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects a request whose Host header is not the loopback allowlist", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(run.port, {
      path: "/",
      method: "GET",
      headers: { host: "evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects a non-GET request to /", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(run.port, { path: "/", method: "PUT" });
    expect(res.statusCode).toBe(405);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("404s an unknown route", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(run.port, { path: "/nope", method: "GET" });
    expect(res.statusCode).toBe(404);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects /save with a missing auth header", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(run.port, { path: "/save", method: "POST" }, "{}");
    expect(res.statusCode).toBe(401);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects /save with a wrong auth header", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(
      run.port,
      { path: "/save", method: "POST", headers: { "x-cc-daily-usage-init-auth": "wrong" } },
      "{}",
    );
    expect(res.statusCode).toBe(401);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects /save with malformed JSON", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(
      run.port,
      { path: "/save", method: "POST", headers: { "x-cc-daily-usage-init-auth": run.token } },
      "not json",
    );
    expect(res.statusCode).toBe(400);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects /save with an invalid payload shape", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(
      run.port,
      { path: "/save", method: "POST", headers: { "x-cc-daily-usage-init-auth": run.token } },
      JSON.stringify({ monthlyCap: "not-a-number" }),
    );
    expect(res.statusCode).toBe(400);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("rejects a /save body over the size cap", async () => {
    const run = start();
    await waitForListening(run);
    const res = await rawRequest(
      run.port,
      {
        path: "/save",
        method: "POST",
        headers: { "x-cc-daily-usage-init-auth": run.token, "content-length": String(300 * 1024) },
      },
      "a".repeat(300 * 1024),
    );
    expect(res.statusCode).toBe(413);
    await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    await run.promise;
  });

  it("accepts a valid /save, persists it, and keeps the server alive for /heartbeat", async () => {
    const run = start();
    await waitForListening(run);
    const payload = { monthlyCap: 650, laboralDays: { "2026": { "9": [1, 2, 3] } } };
    const saveRes = await rawRequest(
      run.port,
      { path: "/save", method: "POST", headers: { "x-cc-daily-usage-init-auth": run.token } },
      JSON.stringify(payload),
    );
    expect(saveRes.statusCode).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith("default", payload);

    const heartbeatRes = await rawRequest(run.port, {
      path: "/heartbeat",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    const doneRes = await rawRequest(run.port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": run.token },
    });
    expect(doneRes.statusCode).toBe(200);
    const result = await run.promise;
    expect(result.outcome).toBe("done");
    expect(result.config).toEqual(payload);
  });

  it("finishes with outcome heartbeat-gap when the page goes quiet after loading", async () => {
    const run = start({ idleTimeoutMs: 5_000, heartbeatGapMs: 30 });
    await waitForListening(run);
    await rawRequest(run.port, { path: "/", method: "GET" }); // arms the heartbeat gap timer
    const result = await run.promise;
    expect(result.outcome).toBe("heartbeat-gap");
  });

  it("finishes with outcome idle-timeout when the browser never loads the page", async () => {
    const run = start({ idleTimeoutMs: 30, heartbeatGapMs: 5_000 });
    const result = await run.promise;
    expect(result.outcome).toBe("idle-timeout");
  });

  it("falls back to every default option value when none are provided", async () => {
    const promise = runInit({});
    await vi.waitFor(() => {
      expect(openSystemExternal).toHaveBeenCalled();
    });
    const url =
      (openSystemExternal as unknown as { mock: { calls: Array<Array<string>> } }).mock
        .calls[0]?.[0] ?? "";
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    const token = /token=([^&]+)/.exec(url)?.[1] ?? "";
    // Clears the (real, 15-minute/25-second-default) timers via /done well before either could fire.
    await rawRequest(port, {
      path: "/done",
      method: "POST",
      headers: { "x-cc-daily-usage-init-auth": token },
    });
    const result = await promise;
    expect(result.outcome).toBe("done");
  });
});

describe("resolveUrl", () => {
  it("falls back to / when request.url is missing", () => {
    expect(resolveUrl({ url: undefined }, 1234).pathname).toBe("/");
  });

  it("resolves the given request.url", () => {
    expect(resolveUrl({ url: "/save?x=1" }, 1234).pathname).toBe("/save");
  });
});

describe("firstHeaderValue", () => {
  it("returns a plain string value as-is", () => {
    expect(firstHeaderValue("abc")).toBe("abc");
  });

  it("returns undefined as-is", () => {
    expect(firstHeaderValue(undefined)).toBeUndefined();
  });

  it("returns the first entry of an array value", () => {
    expect(firstHeaderValue(["first", "second"])).toBe("first");
  });
});
