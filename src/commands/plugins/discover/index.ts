import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { loadConfig } from "../../../config";
import {
  formatTmuxLiveState,
  markPeerTargetsLive,
  resolveTmuxLiveState,
  type PeerTargetWithLive,
  type TmuxLiveStateResult,
} from "../../shared/discover-live-state";
import {
  formatPeerSources,
  parsePeerSourceMode,
  resolvePeerSources,
  type PeerSourceMode,
} from "../../shared/peer-sources";

export const command = {
  name: "discover",
  description: "List configured/discovered federation peers and live tmux state.",
};

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
      output: "usage: maw discover [--peers config|scout|both] [--awake] [--json]",
    };
  }

  const json = args.includes("--json") || boolish(query.json) === true;
  const awake = args.includes("--awake") || boolish(query.awake) === true;
  const result = await resolvePeerSources(loadConfig(), mode);
  const includeLiveState = json || awake;
  const liveState = includeLiveState
    ? await resolveTmuxLiveState(result.peers)
    : { source: "tmux" as const, live: [], warnings: [] };
  const peersWithLive = markPeerTargetsLive(result.peers, liveState.live);
  const visiblePeers = awake ? peersWithLive.filter((peer) => peer.awake) : peersWithLive;
  const warnings = includeLiveState ? [...result.warnings, ...liveState.warnings] : result.warnings;
  emit(json ? JSON.stringify({
    ok: true,
    mode: result.mode,
    awake,
    total: visiblePeers.length,
    peers: visiblePeers,
    liveTotal: liveState.live.length,
    live: liveState.live,
    warnings,
  }, null, 2) : formatDiscoverText({
    mode: result.mode,
    peers: visiblePeers,
    warnings,
    liveState,
    awake,
  }));
  return { ok: true, output: logs.join("\n") || undefined };
}

function formatDiscoverText(input: {
  mode: PeerSourceMode;
  peers: PeerTargetWithLive[];
  warnings: string[];
  liveState: TmuxLiveStateResult;
  awake: boolean;
}): string {
  if (input.awake) return formatTmuxLiveState(input.liveState);
  return formatPeerSources({
    mode: input.mode,
    peers: input.peers,
    warnings: input.warnings,
  });
}
