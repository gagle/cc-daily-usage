import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  BodyTooLargeError,
  constantTimeEquals,
  isAllowedHost,
  normalizeExternalTarget,
  readRequestBody,
  sendHtml,
  sendJson,
} from "./http-utils.js";

describe("constantTimeEquals", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEquals("token123", "token123")).toBe(true);
  });

  it("returns false for different-length strings", () => {
    expect(constantTimeEquals("short", "longerstring")).toBe(false);
  });

  it("returns false for same-length different strings", () => {
    expect(constantTimeEquals("aaaaaaaa", "bbbbbbbb")).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("allows a loopback host with the matching port", () => {
    expect(isAllowedHost("127.0.0.1:4321", 4321)).toBe(true);
  });

  it("allows a loopback host with no port segment", () => {
    expect(isAllowedHost("localhost", 4321)).toBe(true);
  });

  it("rejects a mismatched port", () => {
    expect(isAllowedHost("127.0.0.1:1111", 4321)).toBe(false);
  });

  it("rejects a non-loopback host", () => {
    expect(isAllowedHost("evil.example.com", 4321)).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedHost(undefined, 4321)).toBe(false);
  });
});

function fakeRequest(): EventEmitter {
  return new EventEmitter();
}

describe("readRequestBody", () => {
  it("resolves the concatenated body on end", async () => {
    const request = fakeRequest();
    const promise = readRequestBody(request as never);
    request.emit("data", Buffer.from('{"a":'));
    request.emit("data", Buffer.from("1}"));
    request.emit("end");
    await expect(promise).resolves.toBe('{"a":1}');
  });

  it("rejects when the body exceeds the size cap, without buffering the overflow chunk", async () => {
    const request = fakeRequest();
    const promise = readRequestBody(request as never);
    request.emit("data", Buffer.alloc(300 * 1024));
    await expect(promise).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("ignores further data/end events once already rejected for size", async () => {
    const request = fakeRequest();
    const promise = readRequestBody(request as never);
    request.emit("data", Buffer.alloc(300 * 1024));
    request.emit("data", Buffer.alloc(10));
    request.emit("end");
    await expect(promise).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("propagates a stream error", async () => {
    const request = fakeRequest();
    const promise = readRequestBody(request as never);
    request.emit("error", new Error("boom"));
    await expect(promise).rejects.toThrow("boom");
  });
});

function fakeResponse(): { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return { writeHead: vi.fn(), end: vi.fn() };
}

describe("sendJson", () => {
  it("writes hardened headers and the JSON body", () => {
    const response = fakeResponse();
    sendJson(response as never, 200, { ok: true });
    expect(response.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "cache-control": "no-store", "x-content-type-options": "nosniff" }),
    );
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });
});

describe("sendHtml", () => {
  it("writes hardened headers and the HTML body", () => {
    const response = fakeResponse();
    sendHtml(response as never, 200, "<html></html>");
    expect(response.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "content-type": "text/html; charset=utf-8" }),
    );
    expect(response.end).toHaveBeenCalledWith("<html></html>");
  });
});

describe("normalizeExternalTarget", () => {
  it("accepts an http(s) URL", () => {
    expect(normalizeExternalTarget("http://127.0.0.1:1234/?token=x")).toBe(
      "http://127.0.0.1:1234/?token=x",
    );
  });

  it("rejects a non-http(s) URL", () => {
    expect(() => normalizeExternalTarget("file:///etc/passwd")).toThrow(/Refusing to open/);
  });
});

describe("openSystemExternal", () => {
  it("spawns the macOS opener, detached and unref'd", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn().mockReturnValue(child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.resetModules();
    const { openSystemExternal: fn } = await import("./http-utils.js");
    fn("http://127.0.0.1:1234/");
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["http://127.0.0.1:1234/"],
      expect.objectContaining({ detached: true }),
    );
    expect(child.unref).toHaveBeenCalled();
    vi.doUnmock("node:child_process");
  });

  it("spawns the Windows opener", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn().mockReturnValue(child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.resetModules();
    const { openSystemExternal: fn } = await import("./http-utils.js");
    fn("http://127.0.0.1:1234/");
    expect(spawnMock).toHaveBeenCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "http://127.0.0.1:1234/"],
      expect.anything(),
    );
    vi.doUnmock("node:child_process");
  });

  it("spawns the Linux opener", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn().mockReturnValue(child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.resetModules();
    const { openSystemExternal: fn } = await import("./http-utils.js");
    fn("http://127.0.0.1:1234/");
    expect(spawnMock).toHaveBeenCalledWith(
      "xdg-open",
      ["http://127.0.0.1:1234/"],
      expect.anything(),
    );
    vi.doUnmock("node:child_process");
    vi.unstubAllGlobals();
  });
});
