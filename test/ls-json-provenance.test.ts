import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

type Pane = { id: string; target: string; command?: string; title?: string; cwd?: string };

let panes: Pane[] = [];
let config: any = {};
let gitRoots = new Map<string, string>();
let gitRemotes = new Map<string, string>();
let gitCommits = new Map<string, string>();

mock.module("os", () => ({
  homedir: () => "/mock-home",
  hostname: () => "host-fallback",
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  tmux: { listPanes: async () => panes, capture: async () => "" },
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    if (cmd.includes("rev-parse --show-toplevel")) {
      for (const [cwd, root] of gitRoots) if (cmd.includes(`'${cwd}'`)) return root;
      throw new Error("not a git repo");
    }
    if (cmd.includes("config --get remote.origin.url")) {
      for (const [root, remote] of gitRemotes) if (cmd.includes(`'${root}'`)) return remote;
      return "";
    }
    if (cmd.includes("rev-parse --short=8 HEAD")) {
      for (const [root, commit] of gitCommits) if (cmd.includes(`'${root}'`)) return commit;
      return "";
    }
    return "";
  },
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [{ file: "101-mawjs.json" }],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({ scanWorktrees: async () => [] }));
mock.module(join(srcRoot, "src/core/ghq"), () => ({ ghqList: async () => [], ghqListSync: () => [] }));

const { cmdTmuxLs, paneProvenance } = await import("../src/commands/plugins/tmux/impl");

const originalLog = console.log;

async function captureJson(fn: () => Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try { await fn(); } finally { console.log = originalLog; }
  return JSON.parse(logs.join("\n"));
}

beforeEach(() => {
  panes = [];
  config = { node: "m5", oracle: "mawjs", sessionIds: { "mawjs-oracle": "26a2aa25" } };
  gitRoots = new Map();
  gitRemotes = new Map();
  gitCommits = new Map();
  delete process.env.MAW_SESSION_ID;
});

describe("maw ls --json provenance metadata (#1991)", () => {
  test("adds oracle, machine, logical session, repo, commit, and engine", async () => {
    panes = [{ id: "%1", target: "101-mawjs:mawjs-oracle.1", command: "claude", cwd: "/repo/agents/1" }];
    gitRoots.set("/repo/agents/1", "/repo/agents/1");
    gitRemotes.set("/repo/agents/1", "git@github.com:Soul-Brews-Studio/mawjs-oracle.git");
    gitCommits.set("/repo/agents/1", "a596969b");

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0].provenance).toEqual({
      oracle: "mawjs-oracle",
      machine: "m5",
      session: "26a2aa25",
      federation: "m5:mawjs-oracle",
      org: "Soul-Brews-Studio",
      repo: "mawjs-oracle",
      commit: "a596969b",
      engine: "claude",
    });
    expect(rows[0].cwd).toBeUndefined();
  });

  test("falls back safely when config and git metadata are missing", async () => {
    config = {};
    process.env.MAW_SESSION_ID = "env-session";

    expect(await paneProvenance({ target: "scratch:0.0", session: "scratch", command: "zsh" })).toMatchObject({
      oracle: "scratch-oracle",
      machine: "host-fallback",
      session: "env-session",
      commit: null,
      engine: "zsh",
    });
  });
});
