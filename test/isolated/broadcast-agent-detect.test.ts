/**
 * #1881 — broadcast must use isAgentCommand (not hardcoded "claude" substring)
 * so panes running thclaws / codex / configured engines are reached.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { join } from "path";

let paneCommands = new Map<string, string>();
let sendCalls: Array<{ target: string; text: string }> = [];
let logs: string[] = [];
let originalLog: typeof console.log;

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      if (subcommand === "display-message") {
        if (args.length === 2 && args[0] === "-p" && args[1] === "#{window_name}") {
          return "sender-pane\n";
        }
        if (args.includes("-t")) {
          const target = args[args.indexOf("-t") + 1]!;
          return (paneCommands.get(target) ?? "zsh") + "\n";
        }
      }
      return "";
    },
    listAll: async () => [
      {
        name: "77-mawjs",
        windows: [
          { index: 0, name: "claude-pane" },
          { index: 1, name: "thclaws-pane" },
          { index: 2, name: "zsh-pane" },
        ],
      },
    ],
    sendText: async (target: string, text: string) => {
      sendCalls.push({ target, text });
    },
  },
}));

const { cmdBroadcast } = await import("../../src/vendor/mpr-plugins/broadcast/impl");

beforeEach(() => {
  paneCommands = new Map();
  sendCalls = [];
  logs = [];
  originalLog = console.log;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
});

describe("broadcast agent detection (#1881)", () => {
  test("reaches claude panes (regression)", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "claude");
    paneCommands.set("77-mawjs:2", "zsh");

    await cmdBroadcast("hello");
    console.log = originalLog;

    expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0", "77-mawjs:1"]);
    expect(logs.some(l => l.includes("Broadcast to 2 windows (1 skipped)"))).toBe(true);
  });

  test("reaches thclaws panes (#1906 + #1881 fix)", async () => {
    paneCommands.set("77-mawjs:0", "thclaws");
    paneCommands.set("77-mawjs:1", "thclaude");
    paneCommands.set("77-mawjs:2", "zsh");

    await cmdBroadcast("hello");
    console.log = originalLog;

    // Before fix: 0 sent, 3 skipped (all hardcoded "claude" includes failed)
    // After fix:  2 sent (thclaws + thclaude), 1 skipped (zsh)
    expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0", "77-mawjs:1"]);
    expect(logs.some(l => l.includes("Broadcast to 2 windows (1 skipped)"))).toBe(true);
  });

  test("emits verbose skip-reason breakdown (#1881 Q2)", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "zsh");
    paneCommands.set("77-mawjs:2", "bash");

    await cmdBroadcast("hi");
    console.log = originalLog;

    const breakdown = logs.find(l => l.includes("skipped breakdown:"));
    expect(breakdown).toBeDefined();
    expect(logs.some(l => /non-agent-pane: 2/.test(l))).toBe(true);
  });

  test("no breakdown printed when nothing was skipped", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "claude");
    paneCommands.set("77-mawjs:2", "claude");

    await cmdBroadcast("hi");
    console.log = originalLog;

    expect(logs.some(l => l.includes("skipped breakdown:"))).toBe(false);
  });
});
