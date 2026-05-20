import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import type { DiscoveryError, DiscoveryResponse } from "../../src/vendor/mpr-plugins/peers/discovered";
import type { LoadedPlugin } from "../../src/plugin/types";

const configPath = import.meta.resolve("../../src/config");
const discoveredPath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/discovered");
const liveStatePath = import.meta.resolve("../../src/commands/shared/discover-live-state");
const registryPath = import.meta.resolve("../../src/plugin/registry");
const repoDiscoveryPath = import.meta.resolve("../../src/core/repo-discovery");

let configValue: Record<string, unknown> = {};
let discoveryResult: DiscoveryResponse | DiscoveryError;
let fetchCalls: Array<Record<string, unknown> | undefined> = [];
let liveCalls: unknown[] = [];
let liveStateResult: {
  source: "tmux";
  live: Array<{
    source: "tmux";
    id: string;
    target: string;
    session: string;
    window: string;
    pane: string;
    command?: string;
    cwd?: string;
    awake: true;
    matches: string[];
  }>;
  warnings: string[];
};
let pluginRows: LoadedPlugin[] = [];
let pluginError: Error | null = null;
let ghqPaths: string[] = [];
let ghqError: Error | null = null;

mock.module(configPath, () => ({
  ...mockConfigModule(() => configValue as never),
}));

mock.module(discoveredPath, () => ({
  fetchDiscoveries: async (opts?: Record<string, unknown>) => {
    fetchCalls.push(opts);
    return discoveryResult;
  },
}));

mock.module(liveStatePath, () => ({
  resolveTmuxLiveState: async (peers: Array<Record<string, unknown>>) => {
    liveCalls.push(peers);
    return liveStateResult;
  },
  markPeerTargetsLive: (peers: Array<Record<string, unknown>>, live: Array<Record<string, unknown>>) => peers.map((peer) => {
    const signals = new Set([peer.name, peer.node, peer.oracle, peer.url].filter(Boolean));
    const matching = live.filter((pane) => Array.isArray(pane.matches) && pane.matches.some((match) => signals.has(match)));
    return {
      ...peer,
      awake: matching.length > 0,
      liveTargets: matching.map((pane) => pane.target),
      liveSessions: [...new Set(matching.map((pane) => pane.session))],
    };
  }),
  formatTmuxLiveState: (result: { live: Array<Record<string, unknown>>; warnings: string[] }) =>
    result.live.length > 0
      ? result.live.map((pane) => `tmux ${pane.session}:${pane.window}.${pane.pane} ${pane.command ?? "-"}`).join("\n")
      : `no live tmux sessions/windows found${result.warnings.length ? `\nwarning: ${result.warnings.join(",")}` : ""}`,
}));

mock.module(registryPath, () => ({
  discoverPackages: () => {
    if (pluginError) throw pluginError;
    return pluginRows;
  },
}));

mock.module(repoDiscoveryPath, () => ({
  getRepos: () => ({
    name: "ghq",
    list: async () => {
      if (ghqError) throw ghqError;
      return ghqPaths;
    },
    listSync: () => ghqPaths,
    findBySuffix: async () => null,
    findBySuffixSync: () => null,
  }),
}));

const { command, default: handler } = await import("../../src/commands/plugins/discover/index.ts?discover-plugin-peer-sources");

function discovery(url: string, node = "scout-node"): DiscoveryResponse {
  return {
    ok: true,
    total: 1,
    shown: 1,
    filtered: false,
    peers: [{
      zid: "z1",
      node,
      oracle: "mawjs",
      host: "scout-host",
      locators: [url],
      capabilities: ["send"],
      oracles: ["mawjs"],
      firstSeen: "2026-05-20T00:00:00.000Z",
      lastSeen: "2026-05-20T00:00:01.000Z",
      seenRel: "now",
      paired: false,
    }],
  };
}

function plugin(name: string, overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.2.3",
      sdk: "^1.0.0",
      tier: "standard",
      weight: 12,
      cli: { command: name, aliases: [`${name}-alias`] },
      capabilities: ["sdk:identity"],
      dependencies: { plugins: ["base"] },
    },
    dir: `/plugins/${name}`,
    wasmPath: "",
    entryPath: `/plugins/${name}/index.ts`,
    kind: "ts",
    ...overrides,
  };
}

beforeEach(() => {
  configValue = {
    peers: ["http://config:3456"],
    namedPeers: [{ name: "named", url: "http://named:3456" }],
  };
  discoveryResult = discovery("http://scout:3456");
  fetchCalls = [];
  liveCalls = [];
  liveStateResult = {
    source: "tmux",
    live: [{
      source: "tmux",
      id: "%1",
      target: "101-mawjs:agent.0",
      session: "101-mawjs",
      window: "agent",
      pane: "0",
      command: "claude",
      cwd: "/repo/mawjs-oracle",
      awake: true,
      matches: ["named"],
    }],
    warnings: [],
  };
  pluginRows = [];
  pluginError = null;
  ghqPaths = [];
  ghqError = null;
});

describe("discover plugin peer-source integration (#1808, #1831)", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "discover",
      description: "List configured/discovered federation peers, inventory sources, and live tmux state.",
    });
  });

  test("rejects invalid peer-source mode before loading peers", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "bogus"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "invalid_peer_source",
      output: "usage: maw discover [--peers config|scout|both] [--json] [--tree] [--awake]",
    });
    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toEqual([]);
  });

  test("renders text output for inline scout mode without probing tmux", async () => {
    const result = await handler({ source: "cli", args: ["--peers=scout"] } as any);

    expect(fetchCalls).toEqual([{ all: true }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("scout-node");
    expect(result.output).toContain("http://scout:3456");
    expect(liveCalls).toEqual([]);
  });

  test("renders config-only JSON with live peer metadata without calling scout", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toHaveLength(1);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.mode).toBe("config");
    expect(parsed.total).toBe(2);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
    expect(parsed.live.sessions[0].name).toBe("101-mawjs");
    expect(parsed.plugins).toEqual({
      source: "plugin-registry",
      total: 0,
      records: [],
    });
    expect(parsed.ghq).toEqual({
      source: "ghq",
      total: 0,
      repos: [],
    });
    expect(parsed.peers.find((peer: { name?: string }) => peer.name === "named").awake).toBe(true);
    expect(parsed.peers.map((peer: { url: string }) => peer.url)).toEqual(["http://config:3456", "http://named:3456"]);
  });

  test("API source writes JSON and defaults to both mode", async () => {
    const writes: string[] = [];

    const result = await handler({
      source: "api",
      args: { json: true },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(fetchCalls).toEqual([{ all: true }]);
    expect(liveCalls).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.mode).toBe("both");
    expect(parsed.total).toBe(3);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.peers.find((peer: { name?: string }) => peer.name === "named").awake).toBe(true);
  });

  test("API source accepts string false json and renders warnings in text", async () => {
    const writes: string[] = [];
    discoveryResult = {
      ok: false,
      error: "daemon_unreachable",
      hint: "is maw serve running?",
    };

    const result = await handler({
      source: "api",
      args: { peers: "both", json: "off" },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(liveCalls).toEqual([]);
    expect(writes.join("\n")).toContain("warning: scout unavailable");
  });

  test("includes registered plugins in JSON output without changing peer totals", async () => {
    pluginRows = [plugin("buddy")];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.total).toBe(2);
    expect(parsed.plugins.records).toEqual([{
      source: "plugin-registry",
      type: "plugin",
      name: "buddy",
      version: "1.2.3",
      kind: "ts",
      tier: "standard",
      weight: 12,
      disabled: false,
      dir: "/plugins/buddy",
      command: "buddy",
      aliases: ["buddy-alias"],
      capabilities: ["sdk:identity"],
      dependencies: ["base"],
    }]);
  });

  test("renders plugin registry in text output", async () => {
    pluginRows = [plugin("handover", { disabled: true })];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plugin registry");
    expect(result.output).toContain("handover");
    expect(result.output).toContain("disabled");
    expect(liveCalls).toEqual([]);
  });

  test("includes deduped ghq repos in JSON and tree output", async () => {
    ghqPaths = [
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
    ];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.ghq.total).toBe(2);
    expect(parsed.ghq.repos).toEqual([
      {
        source: "ghq",
        type: "repo",
        path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
        name: "maw-js",
        owner: "Soul-Brews-Studio",
        host: "github.com",
        oracleLike: false,
        worktree: false,
      },
      {
        source: "ghq",
        type: "repo",
        path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
        name: "maw-js.wt-features",
        owner: "Soul-Brews-Studio",
        host: "github.com",
        oracleLike: false,
        worktree: true,
      },
    ]);
    expect(parsed.tree.ghq.map((repo: { path: string }) => repo.path)).toEqual([
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
    ]);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
  });

  test("renders ghq repos in text output", async () => {
    ghqPaths = ["/opt/Code/github.com/Soul-Brews-Studio/mother-oracle"];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ghq repos");
    expect(result.output).toContain("mother-oracle");
    expect(result.output).toContain("yes");
    expect(liveCalls).toEqual([]);
  });

  test("renders discover tree with pane-level tmux live-state in JSON", async () => {
    liveStateResult = {
      source: "tmux",
      live: [
        {
          source: "tmux",
          id: "%1",
          target: "50-mawjs:mawjs-oracle.0",
          session: "50-mawjs",
          window: "mawjs-oracle",
          pane: "0",
          command: "claude",
          awake: true,
          matches: ["mawjs"],
        },
        {
          source: "tmux",
          id: "%2",
          target: "50-mawjs:mawjs-codex.0",
          session: "50-mawjs",
          window: "mawjs-codex",
          pane: "0",
          command: "codex",
          awake: true,
          matches: [],
        },
      ],
      warnings: [],
    };

    const result = await handler({
      source: "cli",
      args: ["--peers", "both", "--json", "--tree", "--awake"],
    } as any);

    expect(fetchCalls).toEqual([{ all: true }]);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.mode).toBe("both");
    expect(parsed.awake).toBe(true);
    expect(parsed.total).toBe(5);
    expect(parsed.plugins).toEqual({
      source: "plugin-registry",
      total: 0,
      records: [],
    });
    expect(parsed.ghq).toEqual({
      source: "ghq",
      total: 0,
      repos: [],
    });
    expect(parsed.live.total).toBe(2);
    expect(parsed.live.sessions[0].name).toBe("50-mawjs");
    expect(parsed.live.sessions[0].windows.map((window: { name: string }) => window.name)).toEqual([
      "mawjs-oracle",
      "mawjs-codex",
    ]);
    expect(parsed.tree.live[0].name).toBe("50-mawjs");
    expect(parsed.tree.peers.map((peer: { url: string }) => peer.url)).toEqual([
      "http://config:3456",
      "http://named:3456",
      "http://scout:3456",
    ]);
  });

  test("renders tree text with plugin and ghq live inventory rows", async () => {
    pluginRows = [plugin("handover", { disabled: true })];
    ghqPaths = ["/opt/Code/github.com/Soul-Brews-Studio/mother-oracle.wt-review"];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plugins (1 registered)");
    expect(result.output).toContain("handover@1.2.3 ts/standard command=handover disabled");
    expect(result.output).toContain("ghq (1 repos)");
    expect(result.output).toContain("mother-oracle.wt-review oracle-like worktree");
  });

  test("renders awake-only text from tmux panes without loading peers", async () => {
    const result = await handler({ source: "cli", args: ["--awake"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toEqual([[]]);
    expect(result.output).toContain("tmux 101-mawjs:agent.0 claude");
    expect(result.output).not.toContain("http://config:3456");
  });

  test("awake JSON filters peer rows to live matches while preserving live panes", async () => {
    const result = await handler({ source: "cli", args: ["--awake", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.awake).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.peers.map((peer: { name?: string }) => peer.name)).toEqual(["named"]);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
    expect(parsed.plugins.records).toEqual([]);
    expect(parsed.ghq.repos).toEqual([]);
  });

  test("renders awake JSON with tmux warning when live-state is unavailable", async () => {
    liveStateResult = {
      source: "tmux",
      live: [],
      warnings: ["tmux unavailable (tmux missing)"],
    };

    const result = await handler({ source: "cli", args: ["--awake", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.live.total).toBe(0);
    expect(parsed.live.sessions).toEqual([]);
    expect(parsed.warnings).toContain("tmux unavailable (tmux missing)");
  });

  test("renders plugin registry warnings in tree output without crashing", async () => {
    pluginError = new Error("bad registry");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plugins (0 registered)");
    expect(result.output).toContain("warning: plugin registry unavailable (bad registry)");
  });

  test("renders ghq warnings in tree output without crashing", async () => {
    ghqError = new Error("ghq missing");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ghq (0 repos)");
    expect(result.output).toContain("warning: ghq unavailable (ghq missing)");
  });
});
