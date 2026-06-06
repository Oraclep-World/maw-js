import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
let spawnCalls: unknown[][] = [];
let spawnImpl: (...args: unknown[]) => { exitCode: number } = () => ({ exitCode: 0 });

const { command, runOracleSkills } = await import("../../src/vendor/mpr-plugins/oracle-skills/index.ts?plugin-oracle-skills-standalone");

beforeEach(() => {
  spawnCalls = [];
  spawnImpl = () => ({ exitCode: 0 });
});

describe("oracle-skills plugin standalone boundary (#2113)", () => {
  test("uses SDK plugin types and no maw private imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/oracle-skills/index.ts"), "utf8");

    expect(source).toContain('from "@maw-js/sdk/plugin"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("exports command metadata", () => {
    expect(command).toMatchObject({
      name: "oracle-skills",
      description: expect.stringContaining("arra-oracle-skills"),
    });
  });

  test("passes CLI args through to arra-oracle-skills with inherited stdio", async () => {
    const result = runOracleSkills(["go", "list", "--json"], ((...args: unknown[]) => {
      spawnCalls.push(args);
      return spawnImpl(...args);
    }) as typeof Bun.spawnSync);

    expect(result).toEqual({ ok: true, output: "" });
    expect(spawnCalls).toEqual([
      [["arra-oracle-skills", "go", "list", "--json"], { stdout: "inherit", stderr: "inherit", stdin: "inherit" }],
    ]);
  });

  test("surfaces missing binary and non-zero exit as InvokeResult failures", async () => {
    spawnImpl = () => {
      throw new Error("ENOENT");
    };
    expect(runOracleSkills([], ((...args: unknown[]) => {
      spawnCalls.push(args);
      return spawnImpl(...args);
    }) as typeof Bun.spawnSync)).toMatchObject({
      ok: false,
      error: expect.stringContaining("arra-oracle-skills not found"),
      output: "",
    });

    spawnImpl = () => ({ exitCode: 42 });
    expect(runOracleSkills([], ((...args: unknown[]) => {
      spawnCalls.push(args);
      return spawnImpl(...args);
    }) as typeof Bun.spawnSync)).toEqual({
      ok: false,
      error: "arra-oracle-skills exited with code 42",
      output: "",
    });
  });
});

