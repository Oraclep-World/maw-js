import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

let attached: Array<{ node: string; sshAlias: string; sessionName: string }> = [];

class MockSshAttachError extends Error {}

mock.module("maw-js/sdk", () => ({
  attachRemoteSession: (target: { node: string; sshAlias: string; sessionName: string }) => {
    attached.push(target);
  },
  SshAttachError: MockSshAttachError,
}));

const attachSsh = await import("../../src/vendor/mpr-plugins/attach-ssh/index.ts");

type Tier3Target = { tier: 3; sessionName: string; node: string; peerUrl: string; sshAlias: string };

function target(overrides: Partial<Tier3Target> = {}): Tier3Target {
  return {
    tier: 3,
    sessionName: "54-mawjs",
    node: "m5",
    peerUrl: "http://m5.local:47777",
    sshAlias: "m5-wg",
    ...overrides,
  };
}

beforeEach(() => {
  attached = [];
});

describe("attach-ssh plugin standalone boundary (#2225)", () => {
  test("has no core or shared imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/attach-ssh/index.ts"), "utf8");

    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);
    expect(source).toContain('from "maw-js/sdk"');
  });

  test("execute probes SSH then attaches through the SDK helper", async () => {
    const probes: Array<{ alias: string; timeoutMs: number }> = [];

    await attachSsh.default.execute(target(), {
      probe: (alias, timeoutMs) => {
        probes.push({ alias, timeoutMs });
        return { ok: true };
      },
    });

    expect(probes).toEqual([{ alias: "m5-wg", timeoutMs: 4000 }]);
    expect(attached).toEqual([{ node: "m5", sshAlias: "m5-wg", sessionName: "54-mawjs" }]);
  });

  test("unreachable probe reports actionable SSH hints and does not attach", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await expect(attachSsh.default.execute(target(), {
        probe: () => ({ ok: false, reason: "timeout" }),
      })).rejects.toThrow("ssh m5-wg unreachable");
    } finally {
      console.error = originalError;
    }

    expect(attached).toEqual([]);
    const rendered = errors.join("\n");
    expect(rendered).toContain("check ~/.ssh/config");
    expect(rendered).toContain("maw peers list");
    expect(rendered).toContain("ssh m5-wg.wg");
  });

  test("friendly SshAttachError is surfaced without process exit", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await expect(attachSsh.default.execute(target(), {
        probe: () => ({ ok: true }),
        ssh: () => { throw new MockSshAttachError("tmux remote missing"); },
      })).rejects.toThrow("tmux remote missing");
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual(["tmux remote missing"]);
  });
});
