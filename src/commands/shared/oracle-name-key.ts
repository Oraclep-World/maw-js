/**
 * oracle-name-key.ts — one canonical key for "are these two names the same oracle?"
 *
 * An oracle answers to several spellings of the same identity:
 *
 *   tmux session name   `08-PQ`          (numeric fleet prefix, original case)
 *   tmux window name    `pq-oracle`      (lowercased by the window creator)
 *   what operators type `PQ`, `main:PQ`  (canonical display case)
 *
 * Every one of those is the same oracle. Call sites that compare the raw
 * strings answer "no" for mixed-case names and then act on a liveness verdict
 * that is simply wrong — `maw hey main:PQ` decided `PQ-oracle !== pq-oracle`,
 * concluded the oracle was dead, and auto-woke a session that was running.
 *
 * The normalization already existed as a private helper inside
 * `wake-resolve-impl.ts` (`hyphenInsensitiveSessionKey`); it was correct but
 * unreachable, so the next call site rolled its own comparison. This module is
 * that helper promoted to a shared export — the fix is "everyone uses the one
 * that works", not "rename the windows to match the comparison".
 *
 * Renaming the tmux windows would have closed the same symptom, but only for
 * the four oracles that exist today: the next bud with an uppercase letter
 * reopens it. Normalizing at the comparison closes the class.
 */

/** Drop a trailing `-oracle` suffix, case-insensitively. */
export function stripOracleSuffix(name: string): string {
  return name.replace(/-oracle$/i, "");
}

/** Drop a leading fleet ordinal (`08-PQ` → `PQ`). */
export function stripNumericFleetPrefix(name: string): string {
  return name.replace(/^\d+-/, "");
}

/**
 * Canonical identity key for an oracle name in any of its spellings.
 *
 *   oracleNameKey("08-PQ")                    === "pq"
 *   oracleNameKey("pq-oracle")                === "pq"
 *   oracleNameKey("PQ")                       === "pq"
 *   oracleNameKey("13-pqBot-executor")        === "pqbotexecutor"
 *   oracleNameKey("pqbot-executor-oracle")    === "pqbotexecutor"
 *
 * Insensitive to case, hyphenation, the `-oracle` suffix, and the numeric
 * fleet prefix. Returns `""` for input that normalizes to nothing — callers
 * must treat an empty key as "no match", never as a wildcard.
 */
export function oracleNameKey(name: string): string {
  return stripOracleSuffix(stripNumericFleetPrefix(name.trim().toLowerCase())).replace(/-/g, "");
}

/**
 * True when both names denote the same oracle. Empty keys never match — an
 * unnamed window must not be treated as every oracle at once.
 */
export function isSameOracleName(a: string, b: string): boolean {
  const keyA = oracleNameKey(a);
  if (!keyA) return false;
  return keyA === oracleNameKey(b);
}
