import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const pluginRoot = join(root, "src/vendor/mpr-plugins/check");

type SpawnResult = { status?: number | null; stdout?: string; stderr?: string; error?: Error };
let spawnCalls: Array<{ cmd: string; args: string[] }>;
let results: Record<string, SpawnResult>;

mock.module("child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return results[`${cmd} ${args.join(" ")}`] ?? results[cmd] ?? { status: 0, stdout: `${cmd} 1.2.3\n`, stderr: "" };
  },
}));

mock.module("maw-js/sdk", () => ({
  tlink: (url: string) => `<${url}>`,
}));

const { command, default: checkHandler } = await import("../../src/vendor/mpr-plugins/check/index.ts?plugin-check-standalone");
const { checkTool } = await import("../../src/vendor/mpr-plugins/check/impl.ts?plugin-check-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

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
  spawnCalls = [];
  results = {
    "gh --version": { error: new Error("missing gh") },
    "uv --version": { status: 0, stdout: "uv 0.8.0\n", stderr: "" },
    "which uvx": { status: 1, stdout: "", stderr: "" },
  };
});

describe("check plugin standalone boundary (#2226)", () => {
  test("imports host contracts and terminal helper through SDK boundaries", () => {
    const sources = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginRoot, file), "utf8"));
    const imports = sources.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/") && spec !== "maw-js/sdk")).toEqual([]);
    expect(imports.filter((spec) => spec.startsWith("../"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["@maw-js/sdk/plugin", "maw-js/sdk"]));
  });

  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "check",
      description: "Audit installed prep tools (ghq, gh, git, tmux, bun, uv, uvx)",
    });
  });

  test("CLI default audits tools and reports missing installs through SDK tlink", async () => {
    const result = await checkHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("maw check tools");
    expect(output).toContain("Required:");
    expect(output).toContain("gh        not installed");
    expect(output).toContain("<https://cli.github.com>");
    expect(output).toContain("uv        0.8.0");
    expect(spawnCalls).toContainEqual({ cmd: "tmux", args: ["-V"] });
    expect(spawnCalls).toContainEqual({ cmd: "which", args: ["uvx"] });
  });

  test("writer path returns no captured output and unknown subcommands stay successful usage output", async () => {
    const writes: string[] = [];
    const result = await checkHandler({
      source: "cli",
      args: ["bogus"],
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes.join("\n")).toContain("unknown subcommand: bogus");
    expect(writes.join("\n")).toContain("usage: maw check [tools]");
  });

  test("checkTool uses uv version for uvx when wrapper is present", () => {
    results["which uvx"] = { status: 0, stdout: "/opt/bin/uvx\n", stderr: "" };
    results["uv --version"] = { status: 0, stdout: "uv 0.9.1\n", stderr: "" };

    expect(checkTool("uvx")).toEqual({ present: true, version: "0.9.1" });
  });
});
