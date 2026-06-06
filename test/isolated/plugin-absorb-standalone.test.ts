import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const sandbox = join(import.meta.dir, ".tmp-absorb-standalone");
const ghqRoot = join(sandbox, "ghq");

let fleetEntries: any[] = [];
let hostCommands: string[] = [];
let archiveCalls: Array<{ oracle: string; opts: unknown }> = [];
let syncCalls: Array<{ fromPath: string; toPath: string; fromName: string; toName: string }> = [];
let resolvedPaths: Record<string, string | null> = {};

mock.module("maw-js/sdk", () => ({
  getGhqRoot: () => ghqRoot,
  hostExec: async (command: string) => {
    hostCommands.push(command);
    return "";
  },
  loadFleetEntries: () => fleetEntries,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/archive/impl.ts"), () => ({
  cmdArchive: async (oracle: string, opts: unknown) => {
    archiveCalls.push({ oracle, opts });
  },
  fleetConfigFilePath: (entry: { path?: string; file: string }) => entry.path ?? join("/tmp/fleet", entry.file),
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/soul-sync/resolve.ts"), () => ({
  resolveOraclePath: async (name: string) => resolvedPaths[name] ?? null,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/soul-sync/sync-helpers.ts"), () => ({
  syncOracleVaults: (fromPath: string, toPath: string, fromName: string, toName: string) => {
    syncCalls.push({ fromPath, toPath, fromName, toName });
    return { from: fromName, to: toName, synced: { "memory/learnings": 2 }, total: 2 };
  },
}));

const { command, default: absorbHandler } = await import("../../src/vendor/mpr-plugins/absorb/index.ts?plugin-absorb-standalone");
const { findAbsorbFleetEntry } = await import("../../src/vendor/mpr-plugins/absorb/impl.ts?plugin-absorb-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function fleetEntry(name: string, file: string, repo: string, windowName = "main") {
  return {
    file,
    path: join(sandbox, "fleet", file),
    groupName: name,
    session: {
      name,
      windows: [{ name: windowName, repo }],
    },
  };
}

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  fleetEntries = [
    fleetEntry("101-donor", "donor.json", "Soul-Brews-Studio/donor-oracle", "donor-oracle"),
    fleetEntry("202-receiver", "receiver.json", "Soul-Brews-Studio/receiver-oracle", "receiver-oracle"),
  ];
  hostCommands = [];
  archiveCalls = [];
  syncCalls = [];
  resolvedPaths = {};
  delete process.env.TMUX;
});

describe("absorb plugin standalone boundary (#2221)", () => {
  test("keeps absorb runtime imports on the SDK boundary with no core imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/absorb", file), "utf8"),
    );

    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["']@?maw-js\/(?!sdk(?:\/plugin)?["'])/);
    }
    const combined = files.join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain('from "@maw-js/sdk/plugin"');
  });

  test("exports command metadata", () => {
    expect(command).toMatchObject({
      name: "absorb",
      description: expect.stringContaining("Absorb one oracle"),
    });
  });

  test("matches fleet entries by session, stripped name, window, and repo stem", () => {
    expect(findAbsorbFleetEntry(fleetEntries, "101-donor")?.file).toBe("donor.json");
    expect(findAbsorbFleetEntry(fleetEntries, "donor")?.file).toBe("donor.json");
    expect(findAbsorbFleetEntry(fleetEntries, "donor-oracle")?.file).toBe("donor.json");
    expect(findAbsorbFleetEntry(fleetEntries, "receiver-oracle")?.file).toBe("receiver.json");
  });

  test("dry-run resolves paths through SDK fallback and avoids mutations", async () => {
    const donorRepo = join(ghqRoot, "github.com", "Soul-Brews-Studio", "donor-oracle");
    const receiverRepo = join(ghqRoot, "github.com", "Soul-Brews-Studio", "receiver-oracle");
    mkdirSync(donorRepo, { recursive: true });
    mkdirSync(receiverRepo, { recursive: true });

    const result = await absorbHandler({ source: "cli", args: ["donor", "--into", "receiver", "--dry-run"] } as any);

    expect(result.ok).toBe(true);
    expect(archiveCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
    expect(hostCommands).toEqual([]);
    const output = stripAnsi(result.output);
    expect(output).toContain("Absorbing donor -> receiver");
    expect(output).toContain("would sync psi memory");
    expect(output).toContain("would archive donor via: maw archive donor");
    expect(output).toContain("not inside tmux; run manually");
  });

  test("non-dry-run syncs, archives donor, and switches tmux client", async () => {
    process.env.TMUX = "/tmp/tmux.sock";
    resolvedPaths = {
      donor: "/repo/donor-oracle",
      receiver: "/repo/receiver-oracle",
    };
    mkdirSync(join(sandbox, "fleet"), { recursive: true });
    writeFileSync(join(sandbox, "fleet", "donor.json.disabled"), "disabled", "utf8");

    const result = await absorbHandler({ source: "cli", args: ["donor", "--into", "receiver"] } as any);

    expect(result.ok).toBe(true);
    expect(syncCalls).toEqual([
      { fromPath: "/repo/donor-oracle", toPath: "/repo/receiver-oracle", fromName: "donor", toName: "receiver" },
    ]);
    expect(archiveCalls).toEqual([{ oracle: "donor", opts: { dryRun: false } }]);
    expect(hostCommands).toEqual(["tmux switch-client -t '202-receiver'"]);
    const output = stripAnsi(result.output);
    expect(output).toContain("psi memory sync complete: 2 learnings");
    expect(output).toContain("switched client to 202-receiver");
    expect(output).toContain("donor absorbed into receiver; donor archived");
  });

  test("returns usage and validation errors as InvokeResult failures", async () => {
    await expect(absorbHandler({ source: "cli", args: ["donor"] } as any)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("usage: maw absorb"),
    });

    const missing = await absorbHandler({ source: "cli", args: ["ghost", "--into", "receiver"] } as any);
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("donor oracle 'ghost' not found") });
  });
});
