import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import type { DiscoveryError, DiscoveryResponse } from "../../src/vendor/mpr-plugins/peers/discovered";

const configPath = import.meta.resolve("../../src/config");
const discoveredPath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/discovered");
const liveStatePath = import.meta.resolve("../../src/commands/shared/discover-live-state");

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
});

describe("discover plugin peer-source integration (#1808)", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "discover",
      description: "List configured/discovered federation peers and live tmux state.",
    });
  });

  test("rejects invalid peer-source mode before loading peers", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "bogus"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "invalid_peer_source",
      output: "usage: maw discover [--peers config|scout|both] [--awake] [--json]",
    });
    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toEqual([]);
  });

  test("renders text output for inline scout mode", async () => {
    const result = await handler({ source: "cli", args: ["--peers=scout"] } as any);

    expect(fetchCalls).toEqual([{ all: true }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("scout-node");
    expect(result.output).toContain("http://scout:3456");
    expect(liveCalls).toEqual([]);
  });

  test("renders config-only JSON without calling scout", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toHaveLength(1);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.mode).toBe("config");
    expect(parsed.total).toBe(2);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.live[0].target).toBe("101-mawjs:agent.0");
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

  test("awake mode renders live tmux state through the discover surface", async () => {
    const result = await handler({ source: "cli", args: ["--awake"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("tmux 101-mawjs:agent.0 claude");
    expect(liveCalls).toHaveLength(1);
  });

  test("awake JSON filters peer rows to live matches while preserving live rows", async () => {
    const result = await handler({ source: "cli", args: ["--awake", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.awake).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.peers.map((peer: { name?: string }) => peer.name)).toEqual(["named"]);
    expect(parsed.liveTotal).toBe(1);
  });
});
