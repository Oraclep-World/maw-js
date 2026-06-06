import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

type Pane = {
  id: string;
  target: string;
  command?: string;
  title?: string;
  cwd?: string;
  lastActivity?: number;
};

let panes: Pane[] = [];
let gitRoots = new Map<string, string>();
let gitBranches = new Map<string, string>();
let gitHeads = new Map<string, string>();
let commands: string[] = [];

mock.module(join(srcRoot, "src/sdk"), () => ({
  tmux: { listPanes: async () => panes, capture: async () => "" },
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("rev-parse --show-toplevel")) {
      for (const [cwd, root] of gitRoots) if (cmd.includes(`'${cwd}'`)) return root;
      throw new Error("not a git repo");
    }
    if (cmd.includes("branch --show-current")) {
      for (const [root, branch] of gitBranches) if (cmd.includes(`'${root}'`)) return branch;
      return "";
    }
    if (cmd.includes("rev-parse --short=8 HEAD")) {
      for (const [root, head] of gitHeads) if (cmd.includes(`'${root}'`)) return head;
      return "";
    }
    return "";
  },
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [{ file: "101-mawjs.json" }],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => [],
  ghqListSync: () => [],
}));

const { cmdTmuxLs, describePaneWorktree } = await import("../src/commands/plugins/tmux/impl");

const originalLog = console.log;

async function captureJson(fn: () => Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs.join("\n"));
}

beforeEach(() => {
  panes = [];
  commands = [];
  gitRoots = new Map();
  gitBranches = new Map();
  gitHeads = new Map();
});

describe("maw ls --json worktree metadata (#1990)", () => {
  test("adds git worktree path, branch, and head for pane cwd", async () => {
    panes = [{ id: "%1", target: "101-mawjs:main.0", command: "claude", cwd: "/repo/agents/1-codex" }];
    gitRoots.set("/repo/agents/1-codex", "/repo/agents/1-codex");
    gitBranches.set("/repo/agents/1-codex", "agents/1-codex");
    gitHeads.set("/repo/agents/1-codex", "a596969b");

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0].worktree).toEqual({
      path: "/repo/agents/1-codex",
      branch: "agents/1-codex",
      head: "a596969b",
    });
    expect(rows[0].cwd).toBeUndefined();
  });

  test("uses null worktree when cwd is absent or not inside git", async () => {
    expect(await describePaneWorktree(undefined)).toBeNull();

    panes = [{ id: "%2", target: "scratch:main.0", command: "zsh", cwd: "/tmp" }];
    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0].worktree).toBeNull();
    expect(commands.some(cmd => cmd.includes("/tmp"))).toBe(true);
  });
});
