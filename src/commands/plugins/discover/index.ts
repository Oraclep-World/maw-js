import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { loadConfig } from "../../../config";
import { getRepos } from "../../../core/repo-discovery";
import { discoverPackages } from "../../../plugin/registry";
import type { LoadedPlugin } from "../../../plugin/types";
import {
  formatTmuxLiveState,
  markPeerTargetsLive,
  resolveTmuxLiveState,
  type DiscoverLivePane,
  type PeerTargetWithLive,
  type TmuxLiveStateResult,
} from "../../shared/discover-live-state";
import {
  formatPeerSources,
  type PeerSourceResult,
  parsePeerSourceMode,
  resolvePeerSources,
} from "../../shared/peer-sources";

export const command = {
  name: "discover",
  description: "List configured/discovered federation peers, inventory sources, and live tmux state.",
};

const USAGE = "usage: maw discover [--peers config|scout|both] [--json] [--tree] [--awake]";

function cliArgs(ctx: InvokeContext): string[] {
  return ctx.source === "cli" && Array.isArray(ctx.args) ? ctx.args : [];
}

function argsObject(ctx: InvokeContext): Record<string, unknown> {
  return ctx.source !== "cli" && ctx.args && !Array.isArray(ctx.args)
    ? ctx.args as Record<string, unknown>
    : {};
}

function readOption(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function boolish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  return undefined;
}

function hasFlag(args: string[], name: string, value: unknown): boolean {
  return args.includes(name) || boolish(value) === true;
}

interface LiveWindowSummary {
  name: string;
  paneCount: number;
  panes: DiscoverLivePane[];
}

interface LiveSessionSummary {
  source: "tmux";
  name: string;
  awake: true;
  paneCount: number;
  windows: LiveWindowSummary[];
}

interface LiveJsonState {
  source: "tmux";
  total: number;
  panes: DiscoverLivePane[];
  sessions: LiveSessionSummary[];
}

interface PluginRecord {
  source: "plugin-registry";
  type: "plugin";
  name: string;
  version: string;
  kind: LoadedPlugin["kind"];
  tier: string;
  weight: number;
  disabled: boolean;
  dir: string;
  command?: string;
  aliases: string[];
  capabilities: string[];
  dependencies: string[];
}

interface PluginRegistryState {
  source: "plugin-registry";
  total: number;
  records: PluginRecord[];
  warnings: string[];
}

interface GhqRepoRecord {
  source: "ghq";
  type: "repo";
  path: string;
  name: string;
  owner?: string;
  host?: string;
  oracleLike: boolean;
  worktree: boolean;
}

interface GhqState {
  source: "ghq";
  total: number;
  repos: GhqRepoRecord[];
  warnings: string[];
}

function liveJsonState(live: TmuxLiveStateResult): LiveJsonState {
  return {
    source: live.source,
    total: live.live.length,
    panes: live.live,
    sessions: summarizeLiveSessions(live.live),
  };
}

function summarizeLiveSessions(panes: DiscoverLivePane[]): LiveSessionSummary[] {
  const sessions = new Map<string, Map<string, DiscoverLivePane[]>>();
  for (const pane of panes) {
    const windows = sessions.get(pane.session) ?? new Map<string, DiscoverLivePane[]>();
    const windowPanes = windows.get(pane.window) ?? [];
    windowPanes.push(pane);
    windows.set(pane.window, windowPanes);
    sessions.set(pane.session, windows);
  }
  return [...sessions.entries()].map(([name, windows]) => {
    const summaryWindows = [...windows.entries()].map(([windowName, windowPanes]) => ({
      name: windowName,
      paneCount: windowPanes.length,
      panes: windowPanes,
    }));
    return {
      source: "tmux" as const,
      name,
      awake: true as const,
      paneCount: summaryWindows.reduce((total, window) => total + window.paneCount, 0),
      windows: summaryWindows,
    };
  });
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function repoRecord(path: string): GhqRepoRecord {
  const normalized = normalizeRepoPath(path);
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) ?? normalized;
  const hostIndex = parts.findIndex((part) => part.includes("."));
  const host = hostIndex >= 0 ? parts[hostIndex] : undefined;
  const owner = hostIndex >= 0 ? parts[hostIndex + 1] : parts.at(-2);
  return {
    source: "ghq",
    type: "repo",
    path: normalized,
    name,
    owner,
    host,
    oracleLike: /(^|[-_])oracle($|[-_])/.test(name) || name.includes("oracle"),
    worktree: /\.wt[-/.]/.test(normalized) || /\.wt-[^/]+$/.test(normalized),
  };
}

async function loadGhqState(): Promise<GhqState> {
  try {
    const seen = new Set<string>();
    const repos: GhqRepoRecord[] = [];
    for (const raw of await getRepos().list()) {
      const path = normalizeRepoPath(raw);
      const key = path.toLowerCase();
      if (!path || seen.has(key)) continue;
      seen.add(key);
      repos.push(repoRecord(path));
    }
    return {
      source: "ghq",
      total: repos.length,
      repos,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "ghq",
      total: 0,
      repos: [],
      warnings: [`ghq unavailable (${message})`],
    };
  }
}

function pluginRecord(plugin: LoadedPlugin): PluginRecord {
  const manifest = plugin.manifest;
  return {
    source: "plugin-registry",
    type: "plugin",
    name: manifest.name,
    version: manifest.version,
    kind: plugin.kind,
    tier: manifest.tier ?? "core",
    weight: manifest.weight ?? 50,
    disabled: plugin.disabled === true,
    dir: plugin.dir,
    command: manifest.cli?.command,
    aliases: manifest.cli?.aliases ?? [],
    capabilities: manifest.capabilities ?? [],
    dependencies: manifest.dependencies?.plugins ?? [],
  };
}

function loadPluginRegistryState(): PluginRegistryState {
  try {
    const records = discoverPackages().map(pluginRecord);
    return {
      source: "plugin-registry",
      total: records.length,
      records,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "plugin-registry",
      total: 0,
      records: [],
      warnings: [`plugin registry unavailable (${message})`],
    };
  }
}

function renderPluginRecords(plugins: PluginRegistryState): string {
  if (plugins.records.length === 0) return "no registered plugins";
  const header = ["name", "version", "kind", "tier", "command", "disabled"];
  const rows = plugins.records.map((plugin) => [
    plugin.name,
    plugin.version,
    plugin.kind,
    plugin.tier,
    plugin.command ?? "-",
    plugin.disabled ? "yes" : "no",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

function renderGhqRepos(ghq: GhqState): string {
  if (ghq.repos.length === 0) return "no ghq repos discovered";
  const header = ["name", "owner", "oracle", "worktree", "path"];
  const rows = ghq.repos.map((repo) => [
    repo.name,
    repo.owner ?? "-",
    repo.oracleLike ? "yes" : "no",
    repo.worktree ? "yes" : "no",
    repo.path,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

function renderDiscoverTable(result: PeerSourceResult, plugins: PluginRegistryState, ghq: GhqState): string {
  const chunks = [formatPeerSources(result)];
  if (plugins.records.length > 0) chunks.push(`plugin registry\n${renderPluginRecords(plugins)}`);
  if (ghq.repos.length > 0) chunks.push(`ghq repos\n${renderGhqRepos(ghq)}`);
  for (const warning of plugins.warnings) chunks.push(`warning: ${warning}`);
  for (const warning of ghq.warnings) chunks.push(`warning: ${warning}`);
  return chunks.join("\n\n");
}

function renderDiscoverTree(
  result: PeerSourceResult,
  live: TmuxLiveStateResult,
  plugins: PluginRegistryState,
  ghq: GhqState,
): string {
  const lines = ["discover"];
  lines.push(`  tmux (${live.live.length} live pane${live.live.length === 1 ? "" : "s"})`);
  for (const session of summarizeLiveSessions(live.live)) {
    lines.push(`    ${session.name}`);
    for (const window of session.windows) {
      lines.push(`      ${window.name}`);
      for (const pane of window.panes) {
        const command = pane.command ? ` ${pane.command}` : "";
        const matches = pane.matches.length > 0 ? ` matches=${pane.matches.join(",")}` : "";
        lines.push(`        ${pane.pane}${command}${matches}`);
      }
    }
  }
  lines.push(`  federation peers (${result.peers.length})`);
  for (const peer of result.peers) {
    const label = peer.name ?? peer.node ?? peer.oracle ?? "-";
    lines.push(`    ${peer.source} ${label} -> ${peer.url}`);
  }
  lines.push(`  plugins (${plugins.records.length} registered)`);
  for (const plugin of plugins.records) {
    const command = plugin.command ? ` command=${plugin.command}` : "";
    const disabled = plugin.disabled ? " disabled" : "";
    lines.push(`    ${plugin.name}@${plugin.version} ${plugin.kind}/${plugin.tier}${command}${disabled}`);
  }
  lines.push(`  ghq (${ghq.repos.length} repos)`);
  for (const repo of ghq.repos) {
    const oracle = repo.oracleLike ? " oracle-like" : "";
    const worktree = repo.worktree ? " worktree" : "";
    lines.push(`    ${repo.name}${oracle}${worktree} -> ${repo.path}`);
  }
  for (const warning of [...result.warnings, ...live.warnings, ...plugins.warnings, ...ghq.warnings]) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = cliArgs(ctx);
  const query = argsObject(ctx);
  const logs: string[] = [];
  const emit = (...values: unknown[]) => {
    if (ctx.writer) ctx.writer(...values);
    else logs.push(values.map(String).join(" "));
  };

  const peerSourceRaw = readOption(args, "--peers")
    ?? (typeof query.peers === "string" ? query.peers : undefined);
  const mode = parsePeerSourceMode(peerSourceRaw, "both");
  if (!mode) {
    return {
      ok: false,
      error: "invalid_peer_source",
      output: USAGE,
    };
  }

  const json = hasFlag(args, "--json", query.json);
  const tree = hasFlag(args, "--tree", query.tree);
  const awake = hasFlag(args, "--awake", query.awake);

  if (awake && !tree && !json) {
    const liveState = await resolveTmuxLiveState([]);
    emit(formatTmuxLiveState(liveState));
    return { ok: true, output: logs.join("\n") || undefined };
  }

  const result = await resolvePeerSources(loadConfig(), mode);
  const plugins = loadPluginRegistryState();
  const ghq = await loadGhqState();
  const includeLiveState = json || tree || awake;
  const liveState = includeLiveState
    ? await resolveTmuxLiveState(result.peers)
    : { source: "tmux" as const, live: [], warnings: [] };
  const peersWithLive = includeLiveState
    ? markPeerTargetsLive(result.peers, liveState.live)
    : result.peers as PeerTargetWithLive[];
  const visiblePeers = awake && !tree
    ? peersWithLive.filter((peer) => peer.awake)
    : peersWithLive;
  const warnings = includeLiveState
    ? [...result.warnings, ...liveState.warnings, ...plugins.warnings, ...ghq.warnings]
    : [...result.warnings, ...plugins.warnings, ...ghq.warnings];

  if (!json && !tree && !awake) {
    emit(renderDiscoverTable(result, plugins, ghq));
    return { ok: true, output: logs.join("\n") || undefined };
  }

  if (json) {
    const live = liveJsonState(liveState);
    emit(JSON.stringify({
      ok: true,
      mode: result.mode,
      total: tree
        ? visiblePeers.length + liveState.live.length + plugins.records.length + ghq.repos.length
        : visiblePeers.length,
      awake,
      peers: visiblePeers,
      plugins: {
        source: plugins.source,
        total: plugins.total,
        records: tree || !awake ? plugins.records : [],
      },
      ghq: {
        source: ghq.source,
        total: ghq.total,
        repos: tree || !awake ? ghq.repos : [],
      },
      liveTotal: liveState.live.length,
      live,
      ...(tree ? { tree: { live: live.sessions, peers: visiblePeers, plugins: plugins.records, ghq: ghq.repos } } : {}),
      warnings,
    }, null, 2));
  } else {
    emit(tree ? renderDiscoverTree(result, liveState, plugins, ghq) : formatTmuxLiveState(liveState));
  }

  return { ok: true, output: logs.join("\n") || undefined };
}
