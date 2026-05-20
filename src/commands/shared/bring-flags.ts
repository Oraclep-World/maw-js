/**
 * #1816 — bring-specific flag helpers.
 *
 * Pure functions only — no side effects, no tmux calls. Fixture-tested for
 * Rust portability per project directive (canonical-session-name.ts style).
 *
 * Why this module exists:
 *   `maw bring` is a thin alias for `maw wake --split`, but it has its own
 *   verb-shaped flag (`--to`) and its own safety guard (refusing to split
 *   an oracle into its own pane — the #1562 amplifier loop). Both are
 *   pure transformations and belong outside the dispatch + side-effecting
 *   layers so they can be tested as data.
 */

/**
 * Translate `--to <session>` to `--session <session>` so the bring verb
 * reads as English ("bring foo TO 50-mawjs") while the underlying wake
 * dispatcher keeps using its existing `--session` flag.
 *
 * Returns a NEW array. Does not mutate. `--to` without a following arg is
 * left intact so the downstream parser surfaces its own error.
 */
export function translateBringToFlag(argv: string[]): { argv: string[]; anchorWindow?: string } {
  const out: string[] = [];
  let anchorWindow: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to" && i + 1 < argv.length) {
      const { session, window } = parseBringToTarget(argv[++i]!);
      out.push("--session", session);
      if (window) anchorWindow = window;
      continue;
    }
    if (arg !== undefined) out.push(arg);
  }
  return { argv: out, anchorWindow };
}

/**
 * Detect whether a `--split` target points at the caller's own pane. When
 * true, the splitting layer must refuse — splitting an active TUI session
 * into a child pane that attach-sessions back to its own parent session
 * creates a nested-attach loop (the #1562 amplifier).
 *
 * Inputs:
 *   target              — tmux address as passed to `attach-session -t`.
 *                         Shapes: "session", "session:window",
 *                         "session:window.pane".
 *   callerSessionWindow — tmux address of the caller's pane, formatted as
 *                         "session:window" (no pane suffix). Pass null
 *                         when the caller is headless (no TMUX_PANE).
 *
 * Returns:
 *   true  → target resolves to the caller's pane / window (refuse to split)
 *   false → target is elsewhere (safe to split)
 *
 * Edge cases:
 *   - Headless caller (null) → false (no pane to collide with).
 *   - Empty target          → false (caller will hit a downstream error).
 *   - target = "session" only (no window) → compares session prefix only;
 *     considered self-bring if it equals caller's session prefix. This
 *     mirrors `attach-session -t <session>`, which attaches to whichever
 *     window is currently active in that session — including the caller's.
 */
/**
 * #1816 Part 3 — parse a `--to` value that may contain a window component.
 *
 *   "--to 50-mawjs"              → { session: "50-mawjs" }
 *   "--to 50-mawjs:maw-js-1816"  → { session: "50-mawjs", window: "maw-js-1816" }
 *   "--to mawjs"                 → { session: "mawjs" }
 *   "--to "                      → { session: "" }
 *
 * The window component tells the split layer which pane to split INTO.
 */
export type BringToTarget = { session: string; window?: string };

export function parseBringToTarget(value: string): BringToTarget {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return { session: value };
  return {
    session: value.slice(0, colonIdx),
    window: value.slice(colonIdx + 1) || undefined,
  };
}

export function isSelfBring(target: string, callerSessionWindow: string | null): boolean {
  if (!callerSessionWindow) return false;
  if (!target) return false;

  // Strip optional ".pane" suffix from target.
  const targetNoPane = target.replace(/\.[^.:]+$/, "");

  // Exact session:window match.
  if (targetNoPane === callerSessionWindow) return true;

  // Session-only target ("50-mawjs") collides with any window in the same
  // session, including the caller's.
  const callerSession = callerSessionWindow.split(":")[0];
  if (!targetNoPane.includes(":") && targetNoPane === callerSession) return true;

  return false;
}
