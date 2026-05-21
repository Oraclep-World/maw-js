/**
 * Read-only peer alias resolution for `maw ls <peer>` and `maw ls --all`.
 *
 * Mirrors plugins/wake/internal/peer-resolve.ts in shape — reads the same
 * maw state `peers.json` store managed by `maw peers add/list/rm`. Adds
 * `resolveAllPeers()` for the `--all` aggregation path. Path resolution
 * is a function (not a const) so tests can override via `PEERS_FILE`.
 *
 * Kept minimal on purpose — no atomic writes, no locking. The full store
 * impl in `src/lib/peers/store.ts` adds those for the write path; nothing
 * here needs them for a read-only URL lookup at dispatch time.
 */
import { readFileSync, existsSync } from "fs";
import { legacyMawPath, mawStatePath } from "../../../../core/xdg";

export interface ResolvedPeer {
  alias: string;
  url: string;
  node: string | null;
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
}

function peersPath(): string {
  return process.env.PEERS_FILE || mawStatePath("peers.json");
}

function legacyPeersPath(): string | null {
  if (process.env.PEERS_FILE || process.env.MAW_HOME) return null;
  const legacy = legacyMawPath("peers.json");
  return legacy === peersPath() ? null : legacy;
}

function readablePeersPath(): string {
  const primary = peersPath();
  if (existsSync(primary)) return primary;
  const legacy = legacyPeersPath();
  return legacy && existsSync(legacy) ? legacy : primary;
}

function readPeers(): Record<string, { url?: string; node?: string; sshAlias?: string; ssh?: string; sshHost?: string; sshUser?: string; user?: string }> | null {
  const path = readablePeersPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.peers && typeof parsed.peers === "object" ? parsed.peers : null;
  } catch {
    return null;
  }
}

export function resolvePeer(alias: string): ResolvedPeer | null {
  const peers = readPeers();
  if (!peers) return null;
  const peer = peers[alias];
  if (!peer || typeof peer.url !== "string") return null;
  return {
    alias,
    url: peer.url,
    node: typeof peer.node === "string" ? peer.node : null,
    ...(typeof peer.sshAlias === "string" && peer.sshAlias.trim() ? { sshAlias: peer.sshAlias.trim() } : {}),
    ...(typeof peer.ssh === "string" && peer.ssh.trim() ? { sshAlias: peer.ssh.trim() } : {}),
    ...(typeof peer.sshHost === "string" && peer.sshHost.trim() ? { sshHost: peer.sshHost.trim() } : {}),
    ...(typeof peer.sshUser === "string" && peer.sshUser.trim() ? { sshUser: peer.sshUser.trim() } : {}),
    ...(typeof peer.user === "string" && peer.user.trim() ? { sshUser: peer.user.trim() } : {}),
  };
}

export function resolveAllPeers(): ResolvedPeer[] {
  const peers = readPeers();
  if (!peers) return [];
  return Object.entries(peers)
    .filter(([, v]) => v && typeof v.url === "string")
    .map(([alias, v]) => ({
      alias,
      url: v.url as string,
      node: typeof v.node === "string" ? v.node : null,
      ...(typeof v.sshAlias === "string" && v.sshAlias.trim() ? { sshAlias: v.sshAlias.trim() } : {}),
      ...(typeof v.ssh === "string" && v.ssh.trim() ? { sshAlias: v.ssh.trim() } : {}),
      ...(typeof v.sshHost === "string" && v.sshHost.trim() ? { sshHost: v.sshHost.trim() } : {}),
      ...(typeof v.sshUser === "string" && v.sshUser.trim() ? { sshUser: v.sshUser.trim() } : {}),
      ...(typeof v.user === "string" && v.user.trim() ? { sshUser: v.user.trim() } : {}),
    }));
}
