import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/check");

type SpawnResult = { status?: number | null; stdout?: string; stderr?: string; error?: Error };
let spawnCalls: Array<{ cmd: string; args: string[] }>;
let spawnResults: Record<string, SpawnResult>;

mock.module("child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return spawnResults[[cmd, ...args].join(" ")] ?? spawnResults[cmd] ?? { status: 0, stdout: `${cmd} 1.2.3\n`, stderr: "" };
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

function loadCheckPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadCheckPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

const { checkTool, TOOLS } = await import("../../src/vendor/mpr-plugins/check/impl.ts?plugin-check-standalone");

beforeEach(() => {
  spawnCalls = [];
  spawnResults = {};
});

describe("check plugin standalone boundary (#2252)", () => {
  test("plugin sources stay off direct core/shared/lib/config imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk"]));
  });

  test("plugin loads from manifest and exposes CLI metadata", async () => {
    const plugin = loadCheckPlugin();
    expect(plugin.manifest.name).toBe("check");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("check v1.0.0");
    expect(result.output).toContain("maw check [tools]");
  });

  test("checkTool uses tmux -V, normal --version, and uvx which detection", () => {
    spawnResults["tmux -V"] = { status: 0, stdout: "tmux 3.4\n" };
    spawnResults["git --version"] = { status: 0, stdout: "git version 2.45.1\n" };
    spawnResults["which uvx"] = { status: 0, stdout: "/usr/bin/uvx\n" };
    spawnResults["uv --version"] = { status: 0, stdout: "uv 0.5.4\n" };
    spawnResults["gh --version"] = { error: new Error("missing") };

    expect(checkTool("tmux")).toEqual({ present: true, version: "3.4" });
    expect(checkTool("git")).toEqual({ present: true, version: "2.45.1" });
    expect(checkTool("uvx")).toEqual({ present: true, version: "0.5.4" });
    expect(checkTool("gh")).toEqual({ present: false });
    expect(spawnCalls.map((call) => [call.cmd, call.args])).toEqual([
      ["tmux", ["-V"]],
      ["git", ["--version"]],
      ["which", ["uvx"]],
      ["uv", ["--version"]],
      ["gh", ["--version"]],
    ]);
  });

  test("tools command renders required, optional, missing, and linked install guidance", async () => {
    for (const tool of TOOLS) {
      if (tool.name === "uv") spawnResults["uv --version"] = { error: new Error("missing") };
      else if (tool.name === "uvx") spawnResults["which uvx"] = { status: 1, stdout: "", stderr: "" };
      else spawnResults[`${tool.name} ${tool.name === "tmux" ? "-V" : "--version"}`] = { status: 0, stdout: `${tool.name} 9.8.7\n` };
    }

    const { result, output } = await invokeCli(["tools"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("maw check tools");
    expect(output).toContain("Required:");
    expect(output).toContain("Optional (Python plugins):");
    expect(output).toContain("uv");
    expect(output).toContain("not installed");
    expect(output).toContain("https://docs.astral.sh/uv/getting-started/installation/");
  });

  test("unknown subcommand prints usage without probing tools", async () => {
    const { result, output } = await invokeCli(["wat"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("unknown subcommand: wat");
    expect(output).toContain("usage: maw check [tools]");
    expect(spawnCalls).toEqual([]);
  });
});
