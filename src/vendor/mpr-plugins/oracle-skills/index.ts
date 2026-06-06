/**
 * maw oracle-skills — pure wrapper around the arra-oracle-skills CLI.
 *
 * Mirrors the maw-token / pass / direnv precedent: spawn the external
 * binary directly with inherited stdio, propagate its exit code, surface
 * an install hint if it isn't on $PATH.
 *
 * All argv (verbs, flags, --help) flows through transparently. The
 * upstream CLI owns help text, verb routing, and output formatting.
 */

import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";

export const command = {
  name: "oracle-skills",
  description:
    "Pass through to arra-oracle-skills to manage Oracle skills across AI coding agents.",
};

export type OracleSkillsSpawn = typeof Bun.spawnSync;

export function runOracleSkills(args: string[], spawn: OracleSkillsSpawn = Bun.spawnSync): InvokeResult {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = spawn(["arra-oracle-skills", ...args], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
  } catch (_e: any) {
    return {
      ok: false,
      error:
        `arra-oracle-skills not found on $PATH. ` +
        `Install with: bun add -g arra-oracle-skills`,
      output: "",
    };
  }

  if (proc.exitCode === 0) {
    return { ok: true, output: "" };
  }

  return {
    ok: false,
    error: `arra-oracle-skills exited with code ${proc.exitCode}`,
    output: "",
  };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args: string[] = ctx.source === "cli" ? (ctx.args as string[]) : [];
  return runOracleSkills(args);
}
