import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/overview");

let sessions: any[];
let config: Record<string, unknown>;
let tmuxCalls: Array<{ name: string; args: unknown[] }>;

mock.module("maw-js/sdk", () => ({
  loadConfig: () => config,
  listSessions: async () => sessions,
  tmux: {
    killSession: async (...args: unknown[]) => tmuxCalls.push({ name: "killSession", args }),
    newSession: async (...args: unknown[]) => tmuxCalls.push({ name: "newSession", args }),
    set: async (...args: unknown[]) => tmuxCalls.push({ name: "set", args }),
    newWindow: async (...args: unknown[]) => tmuxCalls.push({ name: "newWindow", args }),
    selectPane: async (...args: unknown[]) => tmuxCalls.push({ name: "selectPane", args }),
    sendKeys: async (...args: unknown[]) => tmuxCalls.push({ name: "sendKeys", args }),
    splitWindow: async (...args: unknown[]) => tmuxCalls.push({ name: "splitWindow", args }),
    selectLayout: async (...args: unknown[]) => tmuxCalls.push({ name: "selectLayout", args }),
    selectWindow: async (...args: unknown[]) => tmuxCalls.push({ name: "selectWindow", args }),
  },
}));

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

function loadOverviewPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadOverviewPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

const {
  buildTargets,
  chunkTargets,
  mirrorCmd,
  paneColor,
  paneTitle,
  pickLayout,
  processMirror,
} = await import("../../src/vendor/mpr-plugins/overview/impl.ts?plugin-overview-standalone");

beforeEach(() => {
  config = { port: 3456 };
  sessions = [];
  tmuxCalls = [];
});

describe("overview plugin standalone boundary", () => {
  test("plugin sources stay off direct core/shared/lib/config imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk"]));
  });

  test("pure helpers build targets, pages, mirror commands, and layouts", () => {
    const targets = buildTargets([
      { name: "1-mawjs", windows: [{ index: 0, name: "main" }] },
      { name: "2-neo", windows: [{ index: 2, name: "chat", active: true }] },
      { name: "0-overview", windows: [{ index: 0 }] },
      { name: "loose", windows: [{ index: 0 }] },
    ] as any, ["neo"]);

    expect(targets).toEqual([{ session: "2-neo", window: 2, windowName: "chat", oracle: "neo" }]);
    expect(paneTitle(targets[0]!)).toBe("neo (2-neo:2)");
    expect(paneColor(0)).toBe("colour204");
    expect(pickLayout(2)).toBe("even-horizontal");
    expect(pickLayout(3)).toBe("tiled");
    expect(chunkTargets(Array.from({ length: 10 }, (_, i) => ({ ...targets[0]!, oracle: `o${i}` })))).toHaveLength(2);
    expect(mirrorCmd(targets[0]!)).toContain("http://localhost:3456/api/mirror?target=2-neo%3A2");
    expect(processMirror("a\n\n──────\nb", 3)).toContain("────────");
  });

  test("plugin loads from manifest and reports CLI metadata", async () => {
    const plugin = loadOverviewPlugin();
    expect(plugin.manifest.name).toBe("overview");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("overview v1.0.0");
    expect(result.output).toContain("maw overview");
  });

  test("kill mode only kills existing overview session", async () => {
    const { result, output } = await invokeCli(["--kill"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("overview killed");
    expect(tmuxCalls).toEqual([{ name: "killSession", args: ["0-overview"] }]);
  });

  test("no sessions reports a successful diagnostic error", async () => {
    const { result, output } = await invokeCli([]);

    expect(result.ok).toBe(true);
    expect(output).toContain("no oracle sessions found");
    expect(tmuxCalls).toEqual([{ name: "killSession", args: ["0-overview"] }]);
  });

  test("creates overview panes for filtered oracle sessions through SDK tmux", async () => {
    sessions = [
      { name: "1-mawjs", windows: [{ index: 0, name: "main", active: true }] },
      { name: "2-neo", windows: [{ index: 1, name: "shell" }] },
    ];

    const { result, output } = await invokeCli(["mawjs"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("overview: 1 oracles across 1 page");
    expect(output).toContain("page-1: mawjs");
    expect(tmuxCalls.map((call) => call.name)).toContain("newSession");
    expect(tmuxCalls.some((call) => call.name === "sendKeys" && String(call.args[1]).includes("target=1-mawjs%3A0"))).toBe(true);
    expect(tmuxCalls.at(-1)).toEqual({ name: "selectWindow", args: ["0-overview:page-1"] });
  });
});
