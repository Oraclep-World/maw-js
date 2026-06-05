import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import { Tmux } from "../../../core/transport/tmux";
import { isAgentCommand } from "../../../core/agent-detect";
import { loadConfig } from "../../../config/load";
import type { MawConfig } from "../../../config/types";
import { cmdWake, type WakeOptions } from "../../../commands/shared/wake-cmd";
import type { TeamCharterMember } from "./team-charter";

export type TeamMemberState = "live" | "dead" | "missing" | "skipped";

export interface TeamPaneSnapshot {
  sessionName: string;
  windowName: string;
  command: string;
  path: string;
  paneId: string;
}

export interface ClassifiedTeamMember {
  member: TeamCharterMember;
  role: string;
  engine: string;
  worktree: string;
  windowIdentity: string;
  state: TeamMemberState;
  pane?: TeamPaneSnapshot;
  skipReason?: string;
}

export interface WakeMemberDeps {
  cmdWakeFn?: typeof cmdWake;
}

export interface ClassifyMemberOptions {
  engine?: string;
  currentNode?: string;
  only?: Set<string>;
}

const SHELL_RE = /^-?(zsh|bash|sh|fish)$/i;

export function memberWindowIdentity(member: TeamCharterMember): string {
  return member.name?.trim() || member.role;
}

export function memberWorktree(member: TeamCharterMember): string {
  const identity = memberWindowIdentity(member);
  return typeof member.worktree === "string" && member.worktree.trim() ? member.worktree.trim() : identity;
}

export function memberEngine(member: TeamCharterMember, override?: string): string {
  return override ?? member.engine ?? member.model ?? "claude";
}

export function memberMatchesSelector(member: TeamCharterMember, selector: string): boolean {
  const wanted = selector.trim();
  if (!wanted) return false;
  return member.role === wanted || memberWindowIdentity(member) === wanted || memberWorktree(member) === wanted;
}

export function isOtherNodeMember(member: TeamCharterMember, currentNode?: string): boolean {
  return Boolean(member.node && member.node !== currentNode);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findRepoRoot(cwd = process.cwd()): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

export function resolveCharterPath(team: string, cwd = process.cwd()): string | null {
  const root = findRepoRoot(cwd);
  const local = join(root, ".maw", "teams", `${team}.yaml`);
  if (existsSync(local)) return local;
  const psi = join(root, "ψ", "teams", `${team}.yaml`);
  if (existsSync(psi)) return psi;
  return null;
}

export async function listPaneSnapshots(tmux: Pick<Tmux, "run"> = new Tmux()): Promise<TeamPaneSnapshot[]> {
  const raw = await tmux.run("list-panes", "-a", "-F", "#{session_name}|#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_id}");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sessionName = "", windowName = "", command = "", path = "", paneId = ""] = line.split("|");
    return { sessionName, windowName, command, path, paneId };
  });
}

export async function currentTmuxSession(tmux: Pick<Tmux, "run"> = new Tmux()): Promise<string> {
  return (await tmux.run("display-message", "-p", "#S")).trim();
}

export function classifyMember(
  member: TeamCharterMember,
  panes: TeamPaneSnapshot[],
  session: string,
  opts: ClassifyMemberOptions = {},
): ClassifiedTeamMember {
  const role = member.role;
  const windowIdentity = memberWindowIdentity(member);
  const engine = memberEngine(member, opts.engine);
  const worktree = memberWorktree(member);

  if (isOtherNodeMember(member, opts.currentNode)) {
    return { member, role, engine, worktree, windowIdentity, state: "skipped", skipReason: `other node: ${member.node}` };
  }
  if (opts.only && ![member.role, windowIdentity, worktree].some((value) => opts.only!.has(value))) {
    return { member, role, engine, worktree, windowIdentity, state: "skipped", skipReason: "outside --only" };
  }

  const suffix = new RegExp(`-${escapeRegex(windowIdentity)}$`);
  const pane = panes.find((candidate) =>
    candidate.sessionName === session && (candidate.windowName === windowIdentity || suffix.test(candidate.windowName))
  );
  if (!pane) return { member, role, engine, worktree, windowIdentity, state: "missing" };
  if (SHELL_RE.test(pane.command)) return { member, role, engine, worktree, windowIdentity, state: "dead", pane };
  if (isAgentCommand(pane.command)) return { member, role, engine, worktree, windowIdentity, state: "live", pane };
  return { member, role, engine, worktree, windowIdentity, state: "dead", pane };
}

export function engineCommand(engine: string, opts: { resume?: boolean } = {}, config: MawConfig = loadConfig()): string {
  const key = opts.resume ? `${engine}-resume` : engine;
  return config.commands?.[key] ?? config.commands?.default ?? key;
}

export function repoSlugFromRoot(root: string): string {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
    const remote = new TextDecoder().decode(proc.stdout).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  } catch { /* best effort */ }
  const parts = root.split(/[\\/]+/);
  const githubIdx = parts.lastIndexOf("github.com");
  if (githubIdx !== -1 && parts[githubIdx + 1] && parts[githubIdx + 2]) {
    return `${parts[githubIdx + 1]}/${parts[githubIdx + 2]}`;
  }
  return basename(root);
}

export async function wakeMember(
  repoSlug: string,
  member: TeamCharterMember,
  opts: WakeOptions & { engine: string; session: string; repoPath: string },
  deps: WakeMemberDeps = {},
): Promise<string> {
  const wake = deps.cmdWakeFn ?? cmdWake;
  return wake(repoSlug, {
    wt: memberWorktree(member),
    engine: opts.engine,
    session: opts.session,
    repoPath: opts.repoPath,
    ...(member.channels === true ? { channels: true } : {}),
  });
}
