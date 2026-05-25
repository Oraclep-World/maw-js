import { tmux } from "maw-js/sdk";
import { isAgentCommand } from "../../../core/agent-detect";

/**
 * maw broadcast <message> — send to ALL agent windows across ALL sessions
 * Always prefixes with sender identity so receivers know who broadcasted.
 *
 * #1881 — uses shared isAgentCommand (not hardcoded "claude" substring) so
 * panes running thclaws / codex / configured engines are reached. Emits a
 * skip-reason breakdown when at least one window is skipped, so 0-windows
 * surprises become diagnosable.
 */
export async function cmdBroadcast(message: string) {
  if (!message) {
    throw new Error("usage: maw broadcast <message>");
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
  let sent = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  for (const s of sessions) {
    // Skip overview/scratch/view sessions
    if (s.name === "99-overview" || s.name === "scratch") continue;
    if (s.name.endsWith("-view")) continue;

    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      try {
        // Check if window is running an agent (shared with ssh.ts post-#1906)
        const cmd = await tmux.run("display-message", "-t", target, "-p", "#{pane_current_command}");
        if (!isAgentCommand(cmd)) {
          skipped++;
          skipReasons.set("non-agent-pane", (skipReasons.get("non-agent-pane") ?? 0) + 1);
          continue;
        }
        await tmux.sendText(target, message);
        console.log(`\x1b[32msent\x1b[0m → ${s.name}:${w.name}`);
        sent++;
      } catch {
        skipped++;
        skipReasons.set("exception", (skipReasons.get("exception") ?? 0) + 1);
      }
    }
  }

  console.log(`\n\x1b[32m✓\x1b[0m Broadcast to ${sent} windows (${skipped} skipped)`);
  if (skipped > 0) {
    console.log(`  \x1b[90mskipped breakdown:\x1b[0m`);
    for (const [reason, count] of skipReasons) {
      console.log(`    \x1b[90m${reason}: ${count}\x1b[0m`);
    }
  }
}
