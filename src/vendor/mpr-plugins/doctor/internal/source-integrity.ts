import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { loadConfig } from "maw-js/sdk";
import { detectBunLinkedCheckout } from "./bun-link-detect";
import type { DoctorCheck } from "../impl";

/**
 * #desync-gate (spec: foodydev 2026-06-29, impl: ora101) — source-integrity check.
 *
 * Incident 2026-06-26: a bundle (2288 lines) clobbered `src/cli.ts` (64-line
 * HEAD) inside a bun-linked dev checkout. `maw serve` ran the broken
 * working-tree and died silently; no integrity check caught it — only a failed
 * cross-node hey surfaced it.
 *
 * This check compares the install's source entrypoints against `git HEAD` and
 * flags an abnormal divergence (clobber / bundle-over-source) BEFORE serve
 * crashes. All git ops are READ-ONLY (`git show`, `diff --numstat`).
 *
 * Scope (locked w/ foodydev): source-vs-HEAD only. NOT version-vs-binary
 * (global install version ≠ checkout version is a separate axis).
 */

const DEFAULT_WATCH = ["src/cli.ts"];
// step 5 thresholds — tunable via config, never hardcoded into the verdict
const DEFAULT_LINE_BLOWUP = 10; // working-tree > N× HEAD line count
const DEFAULT_ADDED_FLOOR = 500; // or +added lines over HEAD

function gitHeadLineCount(repo: string, file: string): number | null {
  try {
    const out = execFileSync("git", ["-C", repo, "show", `HEAD:${file}`], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").length;
  } catch {
    return null; // file not in HEAD (new/untracked) — nothing to compare
  }
}

function numstat(repo: string, file: string): { added: number; deleted: number } | null {
  try {
    const out = execFileSync("git", ["-C", repo, "diff", "--numstat", "HEAD", "--", file], {
      encoding: "utf-8",
    }).trim();
    if (!out) return { added: 0, deleted: 0 };
    const [a, d] = out.split("\t");
    return { added: Number(a) || 0, deleted: Number(d) || 0 };
  } catch {
    return null;
  }
}

function bundleSignature(absFile: string): boolean {
  try {
    const head = readFileSync(absFile, "utf-8").slice(0, 8192);
    const lines = head.split("\n").slice(0, 5);
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    if (maxLen > 2000) return true; // minified/bundled single-line blob
    return /\(\(\)=>\{|sourceMappingURL|esbuild|webpackBootstrap|__esModule.*Object\.defineProperty/.test(head);
  } catch {
    return false;
  }
}

export function checkSourceIntegrity(checkoutOverride?: string): DoctorCheck {
  const name = "cli:source-integrity";

  // step 2 — activate ONLY for a symlinked dev-checkout install (git working
  // tree). npm/bun normal installs (no symlink / no .git) skip → no false flag.
  // checkoutOverride: test-only injection of the checkout path (prod = detect).
  const checkout = checkoutOverride ?? detectBunLinkedCheckout();
  if (!checkout) {
    return { name, ok: true, severity: "info", message: "source-integrity: n/a (install ไม่ใช่ symlinked dev checkout)" };
  }
  if (!existsSync(join(checkout, ".git"))) {
    return { name, ok: true, severity: "info", message: "source-integrity: n/a (checkout ไม่มี .git)" };
  }

  let watch = DEFAULT_WATCH;
  let ignore: string[] = [];
  let blowup = DEFAULT_LINE_BLOWUP;
  let addedFloor = DEFAULT_ADDED_FLOOR;
  try {
    const cfg = loadConfig() as Record<string, any>;
    const integ = cfg?.doctor?.integrity;
    if (Array.isArray(integ?.watch)) watch = integ.watch;
    if (Array.isArray(integ?.ignore)) ignore = integ.ignore;
    if (Number.isFinite(integ?.lineBlowup)) blowup = integ.lineBlowup;
    if (Number.isFinite(integ?.addedFloor)) addedFloor = integ.addedFloor;
  } catch {
    /* config optional — defaults stand */
  }

  const reds: string[] = [];
  const yellows: string[] = [];
  const details: Array<Record<string, unknown>> = [];

  for (const file of watch) {
    if (ignore.includes(file)) continue;
    const abs = join(checkout, file);
    if (!existsSync(abs)) continue;
    const headLines = gitHeadLineCount(checkout, file);
    const stat = numstat(checkout, file);
    if (headLines === null || stat === null) continue; // untracked/new — skip
    if (stat.added === 0 && stat.deleted === 0) continue; // 🟢 matches HEAD

    const workLines = readFileSync(abs, "utf-8").split("\n").length;
    const bundle = bundleSignature(abs);
    const blownUp = workLines > headLines * blowup || stat.added > addedFloor;
    details.push({ file, headLines, workLines, added: stat.added, deleted: stat.deleted, bundle, blownUp });

    // step 5 — RED needs BOTH blow-up size AND bundle signature; else YELLOW
    if (blownUp && bundle) reds.push(file);
    else yellows.push(file);
  }

  if (reds.length) {
    return {
      name,
      ok: false,
      severity: "error",
      message: `source-integrity: ${reds.join(", ")} DESYNC (likely clobber) — serve route registration อาจ fail`,
      details: { install: checkout, files: details },
      // recover = git stash (Nothing-is-Deleted), NOT git checkout (destroys)
      fix: reds.map(f => `cd ${checkout} && git stash push -m "clobber ${f}" -- ${f} && maw serve restart`),
    };
  }
  if (yellows.length) {
    return {
      name,
      ok: true,
      severity: "warn",
      message: `source-integrity: ${yellows.join(", ")} มี local edit (uncommitted, ใต้ threshold — อาจตั้งใจ)`,
      details: { install: checkout, files: details },
    };
  }
  return { name, ok: true, severity: "info", message: `source-integrity: ${watch.length} entrypoint ตรง HEAD ✓` };
}
