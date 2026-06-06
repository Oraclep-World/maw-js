import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const pluginRoot = join(root, "src/vendor/mpr-plugins/follow");

let attachCalls: Array<{ target: string; deps: Record<string, unknown> }>;
let attachResult: any;
let sessions: any[];
let fleet: any[];

mock.module("maw-js/sdk", () => ({
  loadConfig: () => ({ port: 3456 }),
  listSessions: async () => sessions,
  loadFleet: () => fleet,
  resolveAttachTarget: async (target: string, deps: Record<string, unknown>) => {
    attachCalls.push({ target, deps });
    return attachResult;
  },
}));

const followIndex = await import("../../src/vendor/mpr-plugins/follow/index.ts?plugin-follow-standalone");
const followImpl = await import("../../src/vendor/mpr-plugins/follow/impl.ts?plugin-follow-standalone");

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

beforeEach(() => {
  attachCalls = [];
  attachResult = { tier: 1, sessionName: "77-mawjs", windowName: "mawjs-oracle" };
  sessions = [{ name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] }];
  fleet = [{ name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] }];
});

describe("follow plugin standalone boundary (#2192)", () => {
  test("imports host contracts and shared helpers only through SDK boundaries", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginRoot, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("../"))).toEqual([]);
    expect(imports.filter((spec) => spec.startsWith("maw-js/") && spec !== "maw-js/sdk")).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["@maw-js/sdk/plugin", "maw-js/sdk"]));
    expect(files.join("\n")).toContain("resolveAttachTarget");
    expect(files.join("\n")).toContain("loadFleet");
  });

  test("resolves follow targets through SDK attach and fleet helpers", async () => {
    await expect(followImpl.resolveFollowTarget("mawjs", {
      listSessions: async () => sessions,
      loadFleet: () => fleet,
    })).resolves.toBe("77-mawjs:mawjs-oracle");

    await expect(followImpl.resolveFollowTarget("mawjs:1.2", {
      listSessions: async () => sessions,
      loadFleet: () => fleet,
    })).resolves.toBe("77-mawjs:1.2");

    expect(attachCalls.map((call) => call.target)).toEqual(["mawjs", "mawjs"]);
    expect(typeof attachCalls[0]!.deps.listSessions).toBe("function");
    expect(typeof attachCalls[0]!.deps.loadFleet).toBe("function");
  });

  test("plugin handler validates CLI/API input without private imports", async () => {
    const cli = await followIndex.default({ source: "cli", args: ["--help"] } as any);
    expect(cli).toEqual({ ok: false, error: followImpl.FOLLOW_USAGE });

    const api = await followIndex.default({ source: "api", args: {} } as any);
    expect(api).toEqual({ ok: false, error: "target is required" });
  });
});
