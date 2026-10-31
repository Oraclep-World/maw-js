/**
 * tmux-submit-statusline.test.ts — both submit gates must read the agent's
 * input line, not the bottom line of the screen.
 *
 * Fleet finding 2026-10-06: panes with a multi-line statusline under the
 * Claude Code input box (ours: 8 lines) made Tmux.sendText's confirm loop and
 * #1907 verifySubmitDelivered both conclude "submitted" after the first
 * Enter. A multi-line paste needs more than one Enter, so the message sat in
 * the input box until a human pressed Enter — once for 14 hours.
 *
 * Fixtures are shaped on a real capture (Claude Code v2.1.290, 39-line
 * screen); identifying values in the statusline are replaced.
 */
import { describe, test, expect } from "bun:test";
import { Tmux, agentInputLineText } from "../src/core/transport/tmux-class";
import { verifySubmitDelivered } from "../src/commands/shared/comm-send";

const STATUSLINE = [
  "────────────────────────────────────────",
  "    🧭 HOUSE  Model (1M context) │ 🏢 org.…",
  "    🔑 someone   #2569c9  🏢 org.example  ✓ …",
  "   🧠 ctx     ?",
  "   ⏳ 5h  ███████░░░░░░░░░░░  40% ↻4h19m 22:53",
  "   📅 7d  ███░░░░░░░░░░░░░░░  17%",
  "   🌟 F5  █████░░░░░░░░░░░░░  26% ↻now",
  "   🗂 ~/ghq/github.com/org/house-oracle",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const LETTER = [
  "[main:sombro-bot] [discord-reply 1541153726625091634] 🔬 test letter",
  "",
  "line two of the letter",
  "last line of the letter",
].join("\n");

/** Multi-line paste still sitting in the input box. */
const SCREEN_PENDING = [
  "  ▐▛███▛█   Claude Code",
  "",
  "────────────────────────────────────────",
  "❯ [main:sombro-bot] [discord-reply 1541153726625091634]",
  "  🔬 test letter",
  "",
  "  line two of the letter",
  "  last line of the letter",
  "",
  STATUSLINE,
].join("\n");

/** Submitted: the sent turn is echoed in history as `❯ …`, the live box is empty. */
const SCREEN_SUBMITTED = [
  "❯ [main:sombro-bot] [discord-reply 1541153726625091634]",
  "  🔬 test letter",
  "",
  "✽ Thinking… (9s)",
  "",
  "────────────────────────────────────────",
  "❯ ",
  STATUSLINE,
].join("\n");

/** A human is typing their own text; our letter is not in the box. */
const SCREEN_HUMAN_TYPING = [
  "────────────────────────────────────────",
  "❯ พลีม is half way through typing this",
  STATUSLINE,
].join("\n");

class FakeTmux extends Tmux {
  calls: string[] = [];
  captureScript: string[] = [];
  private captureIdx = 0;
  constructor() { super(undefined, ""); }
  async capture(_t: string, _l = 80): Promise<string> {
    this.calls.push("capture");
    const v = this.captureScript[this.captureIdx] ?? this.captureScript.at(-1) ?? "";
    this.captureIdx++;
    return v;
  }
  async sendKeys(_t: string, ...keys: string[]): Promise<void> { this.calls.push(`sendKeys:${keys.join(",")}`); }
  async sendKeysLiteral(_t: string, text: string): Promise<void> { this.calls.push(`sendKeysLiteral:${text}`); }
  async loadBuffer(text: string): Promise<void> { this.calls.push(`loadBuffer:${text.length}`); }
  async pasteBuffer(_t: string): Promise<void> { this.calls.push("pasteBuffer"); }
  async exitModeIfNeeded(_t: string): Promise<boolean> { return false; }
}
const enterCount = (calls: string[]) => calls.filter(c => c === "sendKeys:Enter").length;

describe("agentInputLineText", () => {
  test("finds the live input box above a multi-line statusline", () => {
    expect(agentInputLineText(SCREEN_PENDING)).toStartWith("[main:sombro-bot]");
  });

  test("stops at the empty live box, never reaches the history echo above it", () => {
    expect(agentInputLineText(SCREEN_SUBMITTED)).toBe("");
  });

  test("statusline lines with `%`, `#` and `:` are not taken for an input line", () => {
    expect(agentInputLineText(STATUSLINE)).toBeNull();
  });

  test("shell panes have no agent input line → null (legacy path)", () => {
    expect(agentInputLineText("agent@host:~$ unsent command text")).toBeNull();
  });

  test("the bottom line of the pending screen is statusline — why the old check was blind", () => {
    const bottom = SCREEN_PENDING.split("\n").filter(l => l.trim()).at(-1)!;
    expect(bottom).toContain("bypass permissions");
    expect(bottom).not.toContain("[main:sombro-bot]");
  });
});

describe("Tmux.sendText — keeps pressing Enter while a multi-line paste is stuck", () => {
  test("retries until the live box is empty (old code stopped after 1)", async () => {
    const t = new FakeTmux();
    t.captureScript = [SCREEN_PENDING, SCREEN_PENDING, SCREEN_SUBMITTED];
    await t.sendText("11-house:0", LETTER);
    expect(t.calls[0]).toStartWith("loadBuffer:");
    expect(t.calls[1]).toBe("pasteBuffer");
    expect(enterCount(t.calls)).toBe(3);
  }, 15_000);

  test("one Enter when the first check already shows an empty box", async () => {
    const t = new FakeTmux();
    t.captureScript = [SCREEN_SUBMITTED];
    await t.sendText("11-house:0", LETTER);
    expect(enterCount(t.calls)).toBe(1);
  }, 15_000);
});

describe("verifySubmitDelivered (#1907) — reads the input line, not the tail", () => {
  const fast = { delayMs: 0, sleepFn: async () => {} };

  test("stuck paste under a statusline → retries Enter, then delivered", async () => {
    let n = 0;
    let enters = 0;
    const r = await verifySubmitDelivered("11-house:0", LETTER, {
      ...fast,
      captureFn: async () => (++n === 1 ? SCREEN_PENDING : SCREEN_SUBMITTED),
      sendKeysFn: async (_t, text) => { enters++; expect(text).toBe("\r"); },
    });
    expect(r).toEqual({ delivered: true, retriesNeeded: 1 });
    expect(enters).toBe(1);
  });

  test("stays stuck → not delivered, warning (old code said delivered)", async () => {
    let enters = 0;
    const r = await verifySubmitDelivered("11-house:0", LETTER, {
      ...fast,
      captureFn: async () => SCREEN_PENDING,
      sendKeysFn: async () => { enters++; },
    });
    expect(r.delivered).toBe(false);
    expect(r.warning).toContain("submit unverified after 4 Enter retries");
    expect(enters).toBe(4);
  });

  test("a human's own half-typed text is never submitted by the backstop", async () => {
    const r = await verifySubmitDelivered("11-house:0", LETTER, {
      ...fast,
      captureFn: async () => SCREEN_HUMAN_TYPING,
      sendKeysFn: async () => { throw new Error("must not press Enter on a human's text"); },
    });
    expect(r).toEqual({ delivered: true, retriesNeeded: 0 });
  });
});


/**
 * 2026-10-31 (ora101): Claude Code draws a prompt suggestion in the EMPTY box as
 * faint text — `❯\u00a0\x1b[2m<suggestion>\x1b[0m` (bytes copied from a live
 * `capture-pane -e` of an idle pane). Read as plain text it looks like pending
 * input: every submit raised a false "still shows pending input" warning, and
 * the fleet stopped reading the warning.
 */
const GHOST_BOX = "\x1b[39m❯\u00a0\x1b[2mก2 ภาษาเข้ม ว่างานนี้ใช้ได้\x1b[0m";
const SCREEN_IDLE_GHOST = ["────────────────────────────────────────", GHOST_BOX, STATUSLINE].join("\n");

describe("ghost text (faint prompt suggestion) is not pending input", () => {
  test("idle box with a faint suggestion reads as empty", () => {
    expect(agentInputLineText(SCREEN_IDLE_GHOST)).toBe("");
  });

  test("real typed text in the box (not faint) is still read", () => {
    const typed = "\x1b[39m❯\u00a0[main:tenzai] 💬 DISCUSS — letter";
    expect(agentInputLineText([typed, STATUSLINE].join("\n"))).toStartWith("[main:tenzai]");
  });

  test("faint span without a reset at end of line is dropped too", () => {
    expect(agentInputLineText("❯\u00a0\x1b[2mtry something")).toBe("");
  });

  test("sendText: submitted → box shows ghost text → ONE Enter, no false retries", async () => {
    const t = new FakeTmux();
    t.captureScript = [SCREEN_IDLE_GHOST];
    await t.sendText("s:0", "short letter");
    expect(enterCount(t.calls)).toBe(1);
  });

  test("verify: letter still in the box under ghost-free render → retried and reported", async () => {
    let enters = 0;
    const r = await verifySubmitDelivered("s:0", LETTER, {
      delayMs: 0, sleepFn: async () => {},
      captureFn: async () => SCREEN_PENDING,
      sendKeysFn: async () => { enters++; },
    });
    expect(r.delivered).toBe(false);
    expect(enters).toBe(4);
  });

  test("verify: ghost text after submit is not mistaken for our letter", async () => {
    const r = await verifySubmitDelivered("s:0", LETTER, {
      delayMs: 0, sleepFn: async () => {},
      captureFn: async () => SCREEN_IDLE_GHOST,
      sendKeysFn: async () => { throw new Error("must not press Enter"); },
    });
    expect(r).toEqual({ delivered: true, retriesNeeded: 0 });
  });
});
