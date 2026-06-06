import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
let config: Record<string, unknown> = { node: "m5" };
let sessions: unknown[] = [];
let resolveResult: unknown = null;
let resolvedPane = "%42";
let curlResult: { ok: boolean; status?: number; data?: Record<string, unknown> } = { ok: true, data: { ok: true, target: "remote:%1" } };
const curlCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
const literalSends: Array<{ target: string; text: string }> = [];
const keySends: Array<{ target: string; key: string }> = [];

class MockTmux {
  async sendKeysLiteral(target: string, text: string) {
    literalSends.push({ target, text });
  }
  async sendKeys(target: string, key: string) {
    keySends.push({ target, key });
  }
}

const sdkMock = {
  loadConfig: () => config,
  listSessions: async () => sessions,
  resolveTarget: () => resolveResult,
  resolveOraclePane: async () => resolvedPane,
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    curlCalls.push({ url, opts });
    return curlResult;
  },
  Tmux: MockTmux,
};

mock.module("maw-js/sdk", () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => sdkMock);

const { default: runHandler, command } = await import("../../src/vendor/mpr-plugins/run/index.ts");
const { parseRunArgs } = await import("../../src/vendor/mpr-plugins/run/impl.ts");

beforeEach(() => {
  config = { node: "m5" };
  sessions = [{ name: "shells", windows: [] }];
  resolveResult = { type: "local", target: "shells:1.0" };
  resolvedPane = "%42";
  curlResult = { ok: true, data: { ok: true, target: "remote:%1" } };
  curlCalls.length = 0;
  literalSends.length = 0;
  keySends.length = 0;
});

describe("run plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const indexSource = readFileSync(join(root, "src/vendor/mpr-plugins/run/index.ts"), "utf8");
    const implSource = readFileSync(join(root, "src/vendor/mpr-plugins/run/impl.ts"), "utf8");
    const combined = `${indexSource}\n${implSource}`;

    expect(command).toMatchObject({ name: "run" });
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(combined).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);

    const sdkSource = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(sdkSource).toContain("resolveOraclePane");
  });

  test("parseRunArgs preserves command flags after the target", () => {
    expect(parseRunArgs(["pane", "ls", "-la"])).toEqual({ target: "pane", text: "ls -la" });
    expect(parseRunArgs(["pane"])).toEqual({ target: "pane", text: "" });
    expect(() => parseRunArgs(["--bad"])).toThrow('usage: maw run <target> "<cmd>"');
  });

  test("local targets resolve to a pane and send literal text plus Enter", async () => {
    const result = await runHandler({ source: "cli", args: ["shells", "echo", "hi"] } as any);

    expect(result.ok).toBe(true);
    expect(literalSends).toEqual([{ target: "%42", text: "echo hi" }]);
    expect(keySends).toEqual([{ target: "%42", key: "Enter" }]);
    expect(curlCalls).toEqual([]);
    expect(result.output).toContain("ran");
    expect(result.output).toContain("%42: echo hi");
  });

  test("empty local command still submits Enter only", async () => {
    const result = await runHandler({ source: "api", args: { target: "shells", text: "" } } as any);

    expect(result.ok).toBe(true);
    expect(literalSends).toEqual([]);
    expect(keySends).toEqual([{ target: "%42", key: "Enter" }]);
  });

  test("peer targets route through signed pane-keys API", async () => {
    resolveResult = { type: "peer", node: "m6", peerUrl: "http://m6.local", target: "shells" };

    const result = await runHandler({ source: "cli", args: ["m6:shells", "uptime"] } as any);

    expect(result.ok).toBe(true);
    expect(curlCalls).toEqual([{
      url: "http://m6.local/api/pane-keys",
      opts: { method: "POST", body: JSON.stringify({ target: "shells", text: "uptime", enter: true }), from: "auto" },
    }]);
    expect(literalSends).toEqual([]);
    expect(keySends).toEqual([]);
    expect(result.output).toContain("m6 → remote:%1: uptime");
  });

  test("resolution and peer failures return user-facing handler errors", async () => {
    resolveResult = { type: "error", detail: "ambiguous target", hint: "use session:window" };
    const ambiguous = await runHandler({ source: "cli", args: ["shell", "pwd"] } as any);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toContain("ambiguous target — use session:window");

    resolveResult = { type: "peer", node: "m6", peerUrl: "http://m6.local", target: "shells" };
    curlResult = { ok: true, status: 200, data: { ok: false, error: "pane missing" } };
    const peerFailed = await runHandler({ source: "cli", args: ["m6:shells", "pwd"] } as any);
    expect(peerFailed.ok).toBe(false);
    expect(peerFailed.error).toContain("peer run failed (m6 http://m6.local): pane missing");
  });
});
