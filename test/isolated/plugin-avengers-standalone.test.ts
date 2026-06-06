import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
let config: Record<string, unknown> = {};
let fetchCalls: string[] = [];
let fetchPayload: unknown = [];
let fetchError: Error | null = null;

mock.module("maw-js/sdk", () => ({
  loadConfig: () => config,
}));

const { default: avengersHandler, command } = await import(
  "../../src/vendor/mpr-plugins/avengers/index.ts"
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  config = {};
  fetchCalls = [];
  fetchPayload = [];
  fetchError = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (fetchError) throw fetchError;
    return { json: async () => fetchPayload } as Response;
  }) as typeof fetch;
});

describe("avengers plugin standalone boundary (#2247)", () => {
  test("imports runtime behavior from the SDK boundary", () => {
    const indexSource = readFileSync(join(root, "src/vendor/mpr-plugins/avengers/index.ts"), "utf8");
    const implSource = readFileSync(join(root, "src/vendor/mpr-plugins/avengers/impl.ts"), "utf8");
    const combined = `${indexSource}\n${implSource}`;

    expect(command).toMatchObject({
      name: "avengers",
      description: "Manage the Avengers multi-agent team.",
    });
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(combined).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);
  });

  test("help renders without loading the implementation", async () => {
    const output: string[] = [];
    const result = await avengersHandler({
      source: "cli",
      args: ["--help"],
      writer: (...parts: unknown[]) => output.push(parts.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true });
    expect(output.join("\n")).toContain("usage: maw avengers");
    expect(output.join("\n")).toContain("maw avengers status");
    expect(fetchCalls).toEqual([]);
  });

  test("reports missing avengers config through the handler boundary", async () => {
    const result = await avengersHandler({ source: "cli", args: ["status"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Avengers not configured");
    expect(fetchCalls).toEqual([]);
  });

  test("status uses configured base URL and prints account limits", async () => {
    config = { avengers: "http://avengers.local" };
    fetchPayload = [{ name: "alpha", remaining: 75, limit: 100 }];

    const result = await avengersHandler({ source: "cli", args: ["status"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["http://avengers.local/all"]);
    expect(result.output).toContain("Avengers Status");
    expect(result.output).toContain("alpha");
    expect(result.output).toContain("75/100 (75%)");
  });

  test("fetch failures stay user-visible without failing the command", async () => {
    config = { avengers: "http://avengers.local" };
    fetchError = new Error("connection refused");

    const result = await avengersHandler({ source: "cli", args: ["status"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["http://avengers.local/all"]);
    expect(result.output).toContain("avengers unreachable at http://avengers.local");
    expect(result.output).toContain("connection refused");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
