import { afterEach, afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "./helpers/mock-config";

let mockToken: string | undefined = "test-token-16chars!";
let mockNode: string | undefined = "test";
let mockConfigThrows = false;

const origTransport = process.env.MAW_CURL_FETCH_TRANSPORT;
const origFetch = globalThis.fetch;
const origSpawn = Bun.spawn;
const origWarn = console.warn;
const origError = console.error;

mock.module(import.meta.resolve("../src/config.ts"), () => mockConfigModule(() => {
  if (mockConfigThrows) throw new Error("simulated config load failure");
  return { federationToken: mockToken, node: mockNode, oracle: "mawjs" };
}));

const { curlFetch } = await import("../src/core/transport/curl-fetch.ts?curl-fetch-unit");

function useFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

beforeEach(() => {
  mockToken = "test-token-16chars!";
  mockNode = "test";
  mockConfigThrows = false;
  process.env.MAW_CURL_FETCH_TRANSPORT = "native";
  globalThis.fetch = origFetch;
  (Bun as any).spawn = origSpawn;
  console.warn = origWarn;
  console.error = origError;
});

/** Keep this suite hermetic: no test performs a real network call. */
afterEach(() => {
  globalThis.fetch = origFetch;
  (Bun as any).spawn = origSpawn;
  console.warn = origWarn;
  console.error = origError;
});

afterAll(() => {
  if (origTransport === undefined) delete process.env.MAW_CURL_FETCH_TRANSPORT;
  else process.env.MAW_CURL_FETCH_TRANSPORT = origTransport;
  mock.restore();
});

describe("curlFetch native transport", () => {
  test("can force native fetch and parse JSON", async () => {
    useFetch(async () => new Response(JSON.stringify({ transport: "native" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await curlFetch("http://example.invalid/native", { timeout: 1000 });
    expect(res).toEqual({ ok: true, status: 200, data: { transport: "native" } });
  });

  test("warns and clears abort timeout when native fetch fails", async () => {
    const logs: string[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cleared = false;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    useFetch(async () => { throw new Error("connect timeout\nstack"); });
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      timeoutId = realSetTimeout(handler, ms, ...args as []);
      return timeoutId;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      if (id === timeoutId) cleared = true;
      return realClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const res = await curlFetch("http://192.0.2.1:9999/api/test", { method: "POST", timeout: 1000 });
      expect(res).toEqual({ ok: false, status: 0, data: null });
      expect(logs.join("\n")).toMatch(/nativeFetch failed.*POST.*192\.0\.2\.1.*connect timeout/);
      expect(cleared).toBe(true);
    } finally {
      if (timeoutId && !cleared) realClearTimeout(timeoutId);
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("fails closed when signing throws and does not call fetch", async () => {
    let fetchCalls = 0;
    const logs: string[] = [];
    mockConfigThrows = true;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    useFetch(async () => { fetchCalls++; return new Response("{}"); });

    const res = await curlFetch("http://example.invalid/api/send", { method: "POST", body: "{}", timeout: 1000 });
    expect(res).toEqual({ ok: false, status: 0, data: null });
    expect(fetchCalls).toBe(0);
    expect(logs.some((line) => /signing/i.test(line))).toBe(true);
  });

  test("adds federation auth headers without touching the network", async () => {
    let headers: Headers | undefined;
    useFetch(async (_url, init) => {
      headers = new Headers(init?.headers as HeadersInit);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await curlFetch("http://peer.invalid/api/send", { method: "POST", body: "{}", timeout: 1000 });
    expect(res.ok).toBe(true);
    expect(headers?.get("X-Maw-Timestamp")).toBeTruthy();
    expect(headers?.get("X-Maw-Signature")).toBeTruthy();
    expect(headers?.get("X-Maw-Auth-Version")).toBeNull();
  });
});

describe("curlFetch body size cap", () => {
  test("rejects streamed bodies exceeding maxBytes", async () => {
    useFetch(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    }), { status: 200 }));

    const res = await curlFetch("http://example.invalid/huge", { maxBytes: 10, timeout: 1000 });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 10 bytes/);
  });

  test("rejects declared bodies exceeding maxBytes before buffering", async () => {
    useFetch(async () => new Response("{}", {
      status: 200,
      headers: new Headers({ "content-length": String(11 * 1024 * 1024) }),
    }));

    const res = await curlFetch("http://example.invalid/default", { timeout: 1000 });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 10485760 bytes/);
  });
});

describe("curlFetch curl subprocess transport", () => {
  beforeEach(() => {
    mockToken = undefined;
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";
  });

  test("parses stdout and passes method, body, timeout, and limits", async () => {
    const calls: unknown[][] = [];
    (Bun as any).spawn = (args: string[]) => {
      calls.push(args);
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    const res = await curlFetch("http://example.invalid/api", {
      method: "POST",
      body: JSON.stringify({ hello: "curl" }),
      timeout: 2500,
      maxBytes: 2048,
    });

    expect(res).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(calls[0]).toContain("--max-time");
    expect(calls[0]).toContain("3");
    expect(calls[0]).toContain("--max-filesize");
    expect(calls[0]).toContain("2048");
    expect(calls[0]).toContain(JSON.stringify({ hello: "curl" }));
  });

  test("kills curl when streamed stdout exceeds maxBytes", async () => {
    let killed = false;
    (Bun as any).spawn = () => ({
      stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)); c.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill: () => { killed = true; },
    });

    const res = await curlFetch("http://example.invalid/huge", { maxBytes: 10, timeout: 1000 });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 10 bytes/);
    expect(killed).toBe(true);
  });
});
