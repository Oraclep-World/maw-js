import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { tmux, isAgentCommand, loadOracleRegistry, loadFleetEntries } from "maw-js/sdk";

export interface BroadcastScopeOptions {
  session?: string;
  team?: string;
  fleet?: string;
  dryRun?: boolean;
}

/**
 * ด่านกัน "ใบไม่จ่าหน้า" เข้าโต๊ะคนงาน — tmux session option ที่เจ้าของโต๊ะตั้งเอง:
 *   tmux set-option -t 90-family-codex @maw-no-broadcast 1
 *
 * เหตุ (7 ส.ค. 2026 · พลีมเคาะ): broadcast แบบไม่ scope ตกลง pane ของ codex ทั้ง 5 ห้อง
 * ⇒ 1 คำถาม กลายเป็นคำตอบครึ่งใบ 4 ชิ้นวิ่งไปหาผู้ส่ง + จ่าย token 4 รอบ
 * เกิดซ้ำ 2 รอบใน 6 วัน (31 ก.ค. ค้าง composer ทั้ง 5 → 6 ส.ค. ตอบซ้ำ) ทั้งที่
 * codex-workspace/FLEET-PLAYBOOK.md กฎเหล็กข้อ 3 เขียนอาการ+ของแก้ไว้ครบแล้ว
 * ⇒ กฎที่เป็นตัวหนังสือกันไม่อยู่ ด่านต้องอยู่ในกลไกที่ส่ง ไม่ใช่ในคู่มือที่คนอ่าน
 *
 * จ่าหน้าถึงตรงๆ ด้วย --session <name> ยังส่งได้เสมอ — ด่านนี้กันเฉพาะใบที่ไม่ได้จ่าหน้า
 */
export const NO_BROADCAST_OPTION = "@maw-no-broadcast";

function optionIsOn(raw: string | null | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

async function sessionOptsOutOfBroadcast(sessionName: string): Promise<boolean> {
  try {
    return optionIsOn(await tmux.run("show-options", "-t", sessionName, "-qv", NO_BROADCAST_OPTION));
  } catch {
    // อ่าน option ไม่ได้ = ไม่ถือว่า opt-out (ด่านต้องไม่ทำให้ใบปกติหาย)
    return false;
  }
}

/**
 * ระดับ window — หน่วยที่ถูกต้องจริงๆ
 *
 * วัดบนเครื่อง main 7 ส.ค.: ห้อง codex ถูก link เข้าทั้ง `90-family-codex`, `08-PQ`
 * และ `fam-view-1..5` ⇒ ปิดที่ระดับ session ไม่พอ เพราะ `08-PQ` เป็นบ้านของ PQ เองด้วย
 * (ปิดทั้ง session = ปิดห้องทำงานของเขาไปด้วย) · window เดียวกันที่ link ข้าม session
 * ใช้ option ร่วมกัน ⇒ ตั้งครั้งเดียวคุมทุกชื่อที่มันโผล่
 *   tmux set-option -w -t 08-PQ:codex-workspace-codex-1 @maw-no-broadcast 1
 */
async function windowOptsOutOfBroadcast(target: string): Promise<boolean> {
  try {
    return optionIsOn(await tmux.run("show-options", "-w", "-t", target, "-qv", NO_BROADCAST_OPTION));
  } catch {
    return false;
  }
}

export interface BroadcastCommand {
  message: string;
  scope: BroadcastScopeOptions;
}

function usage(): string {
  return "usage: maw broadcast <message> [--session <name>] [--team <name>] [--fleet <name>] [--dry-run]";
}

export function parseBroadcastArgs(args: string[]): BroadcastCommand {
  const scope: BroadcastScopeOptions = {};
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      scope.dryRun = true;
      continue;
    }
    if (arg === "--session" || arg === "--team" || arg === "--fleet") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value\n${usage()}`);
      if (arg === "--session") scope.session = value;
      else if (arg === "--team") scope.team = value;
      else scope.fleet = value;
      continue;
    }
    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();
  if (!message) throw new Error(usage());
  return { message, scope };
}

function stripNumericPrefix(value: string): string {
  return value.replace(/^\d+-/, "");
}

function stripOracleSuffix(value: string): string {
  return value.replace(/-oracle$/i, "");
}

function normalizedNames(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const strippedPrefix = stripNumericPrefix(trimmed);
  return [...new Set([
    trimmed,
    strippedPrefix,
    stripOracleSuffix(trimmed),
    stripOracleSuffix(strippedPrefix),
    `${strippedPrefix}-oracle`,
  ].filter(Boolean))];
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

function teamConfigMemberNames(teamName: string): string[] {
  const cfg = readJson(join(homedir(), ".claude", "teams", teamName, "config.json"));
  if (!cfg || !Array.isArray(cfg.members)) return [];
  return cfg.members
    .filter((m: any) => m?.agentType !== "team-lead" && m?.role !== "lead" && m?.name !== "team-lead")
    .map((m: any) => typeof m?.name === "string" ? m.name : "")
    .filter(Boolean);
}

function resolvePsi(): string {
  let dir = process.cwd();
  while (true) {
    const psi = join(dir, "ψ");
    if (existsSync(psi) && existsSync(join(dir, "CLAUDE.md"))) return psi;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "ψ");
}

function teamManifestMemberNames(teamName: string): string[] {
  const manifest = readJson(join(resolvePsi(), "memory", "mailbox", "teams", teamName, "manifest.json"));
  if (!manifest) return [];
  const out: string[] = [];
  for (const entry of Array.isArray(manifest.members) ? manifest.members : []) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry.name === "string") out.push(entry.name);
  }
  for (const entry of Array.isArray(manifest.charter?.members) ? manifest.charter.members : []) {
    if (entry && typeof entry.name === "string") out.push(entry.name);
    else if (entry && typeof entry.role === "string") out.push(entry.role);
  }
  return out;
}

export function teamScopeMemberNames(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  const registryMembers = registry?.members.map(m => m.oracle).filter(Boolean) ?? [];
  return [...new Set([
    ...registryMembers,
    ...teamConfigMemberNames(teamName),
    ...teamManifestMemberNames(teamName),
  ])];
}

export function fleetScopeSessionNames(fleetName: string): Set<string> {
  const wanted = new Set(normalizedNames(fleetName));
  const sessions = new Set<string>();
  for (const entry of loadFleetEntries()) {
    const candidates = [
      entry.groupName,
      entry.file.replace(/\.json$/i, ""),
      entry.session.name,
      stripNumericPrefix(entry.session.name),
    ];
    if (candidates.some(c => wanted.has(c))) sessions.add(entry.session.name);
  }
  return sessions;
}

function windowMatchesTeamMember(sessionName: string, windowName: string, teamMembers: Set<string>): boolean {
  return [...normalizedNames(sessionName), ...normalizedNames(windowName)].some(name => teamMembers.has(name));
}

function scopeDescription(scope: BroadcastScopeOptions): string {
  const parts = [
    scope.session ? `session=${scope.session}` : "",
    scope.team ? `team=${scope.team}` : "",
    scope.fleet ? `fleet=${scope.fleet}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "all agents";
}

/**
 * maw broadcast <message> — send to agent windows, optionally scoped by
 * --session, --team charter members, and/or --fleet tagged session.
 * Always prefixes with sender identity so receivers know who broadcasted.
 *
 * #1881 — uses shared isAgentCommand (not hardcoded "claude" substring) so
 * panes running thclaws / codex / configured engines are reached. Emits a
 * skip-reason breakdown when at least one window is skipped, so 0-windows
 * surprises become diagnosable.
 */
export async function cmdBroadcast(message: string, scope: BroadcastScopeOptions = {}) {
  if (!message) {
    throw new Error(usage());
  }

  // Detect sender from current tmux window
  let sender = "unknown";
  try {
    sender = await tmux.run("display-message", "-p", "#{window_name}");
    sender = sender.trim() || "unknown";
  } catch { /* expected: may not be in tmux */ }

  // Prefix message with sender
  message = `[broadcast from ${sender}] ${message}`;

  const sessions = await tmux.listAll();
  const teamMembers = scope.team ? new Set(teamScopeMemberNames(scope.team).flatMap(normalizedNames)) : null;
  const fleetSessions = scope.fleet ? fleetScopeSessionNames(scope.fleet) : null;
  let sent = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  // 🔒 ด่านที่ 2 — ส่งซ้ำใส่ pane เดิม
  // tmux link-window ทำให้ pane เดียวโผล่ในหลาย session (โต๊ะ codex เห็นได้จาก
  // 08-PQ + 90-family-codex + fam-view-1..5) ⇒ วัดจริงบนเครื่อง main 7 ส.ค. 01:3x:
  // broadcast 1 ใบ = 50 target แต่ pane จริงแค่ 20 ⇒ **30 ใบเป็นของซ้ำ (60%)**
  // ห้อง codex 1 ห้องได้ข้อความเดียวกัน ~7 รอบ · กฎ `.endsWith("-view")` ที่มีอยู่
  // ไม่ครอบ `fam-view-1..5` เพราะชื่อลงท้ายด้วยเลข ⇒ ด่านต้องยึด pane ไม่ใช่ชื่อ session
  const deliveredPanes = new Set<string>();

  for (const s of sessions) {
    // Skip overview/scratch/view sessions
    if (s.name === "99-overview" || s.name === "scratch") continue;
    if (s.name.endsWith("-view")) continue;
    if (scope.session && s.name !== scope.session) continue;
    if (fleetSessions && !fleetSessions.has(s.name)) continue;

    // 🔒 ด่าน: โต๊ะคนงานที่ตั้ง @maw-no-broadcast รับเฉพาะใบที่จ่าหน้าถึงมันด้วย --session
    if (scope.session !== s.name && await sessionOptsOutOfBroadcast(s.name)) {
      const paneCount = s.windows.length;
      skipped += paneCount;
      const reason = `worker-desk ${NO_BROADCAST_OPTION} (ใส่ --session ${s.name} ถ้าตั้งใจส่งจริง)`;
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + paneCount);
      continue;
    }

    for (const w of s.windows) {
      if (teamMembers && !windowMatchesTeamMember(s.name, w.name, teamMembers)) continue;
      const target = `${s.name}:${w.index}`;
      try {
        // Check if window is running an agent (shared with ssh.ts post-#1906)
        // ดึง pane_id มาพร้อมกันในคำสั่งเดียว — ใช้กันส่งซ้ำใส่ pane ที่ link ข้าม session
        const info = await tmux.run("display-message", "-t", target, "-p", "#{pane_id}\t#{pane_current_command}");
        // tmux รุ่น/สภาพแวดล้อมที่ไม่คืน pane_id ⇒ ได้ก้อนเดียว = ถือว่าเป็นคำสั่งล้วน
        // (ห้ามเดาว่าก้อนแรกคือ pane_id — pane id จริงขึ้นต้นด้วย % เสมอ
        //  ถ้าเดา จะ dedupe ทุก pane ที่รันคำสั่งเดียวกันเหลือตัวเดียว = ใบหายเงียบ)
        const parts = info.trim().split("\t");
        const hasPaneId = parts.length === 2 && parts[0]!.startsWith("%");
        const paneId = hasPaneId ? parts[0]! : "";
        const cmd = hasPaneId ? parts[1]! : info;
        if (!isAgentCommand(cmd)) {
          skipped++;
          skipReasons.set("non-agent-pane", (skipReasons.get("non-agent-pane") ?? 0) + 1);
          continue;
        }
        if (paneId && deliveredPanes.has(paneId)) {
          skipped++;
          const reason = "duplicate-pane (linked window — ส่งไปแล้วในชื่ออื่น)";
          skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
          continue;
        }
        // ด่านระดับ window — ใบไม่จ่าหน้าไม่เข้าห้องคนงาน แม้ห้องนั้นจะ link อยู่ใน session ของบ้านคนอื่น
        if (scope.session !== s.name && await windowOptsOutOfBroadcast(target)) {
          skipped++;
          const reason = `worker-window ${NO_BROADCAST_OPTION} (ใส่ --session ${s.name} ถ้าตั้งใจส่งจริง)`;
          skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
          continue;
        }
        if (paneId) deliveredPanes.add(paneId);
        if (scope.dryRun) {
          console.log(`\x1b[33mwould send\x1b[0m → ${s.name}:${w.name}`);
        } else {
          await tmux.sendText(target, message);
          console.log(`\x1b[32msent\x1b[0m → ${s.name}:${w.name}`);
        }
        sent++;
      } catch {
        skipped++;
        skipReasons.set("exception", (skipReasons.get("exception") ?? 0) + 1);
      }
    }
  }

  const verb = scope.dryRun ? "DRY-RUN — would broadcast to" : "Broadcast to";
  console.log(`\n\x1b[32m✓\x1b[0m ${verb} ${sent} windows (${skipped} skipped) [scope: ${scopeDescription(scope)}]`);
  if (skipped > 0) {
    console.log(`  \x1b[90mskipped breakdown:\x1b[0m`);
    for (const [reason, count] of skipReasons) {
      console.log(`    \x1b[90m${reason}: ${count}\x1b[0m`);
    }
  }
}
