import { describe, it, expect } from "bun:test";
import { isClaudeLikeEngine } from "./is-claude-like";
import type { MawConfig } from "../../config/types";

describe("isClaudeLikeEngine", () => {
  it("returns false for empty / undefined engine", () => {
    expect(isClaudeLikeEngine(undefined)).toBe(false);
    expect(isClaudeLikeEngine("")).toBe(false);
    expect(isClaudeLikeEngine("   ")).toBe(false);
  });

  it("matches the literal claude name case-insensitively", () => {
    expect(isClaudeLikeEngine("claude")).toBe(true);
    expect(isClaudeLikeEngine("Claude")).toBe(true);
    expect(isClaudeLikeEngine("  CLAUDE  ")).toBe(true);
  });

  it("treats non-claude built-in engines as not claude-like", () => {
    expect(isClaudeLikeEngine("codex")).toBe(false);
    expect(isClaudeLikeEngine("opencode")).toBe(false);
    expect(isClaudeLikeEngine("aider")).toBe(false);
  });

  it("resolves a config alias whose command is claude-like", () => {
    const config: Partial<MawConfig> = {
      engines: { fast: { name: "fast", cmd: "claude --model opus" } },
    };
    expect(isClaudeLikeEngine("fast", config)).toBe(true);
  });

  it("resolves a legacy commands alias whose command is claude-like", () => {
    const config: Partial<MawConfig> = {
      commands: { beta: "claudeBeta --foo" },
    };
    expect(isClaudeLikeEngine("beta", config)).toBe(true);
  });

  it("treats a config alias with a non-claude command as not claude-like", () => {
    const config: Partial<MawConfig> = {
      engines: { custom: { name: "custom", cmd: "codex exec" } },
    };
    expect(isClaudeLikeEngine("custom", config)).toBe(false);
  });

  it("matches an engine that declares the system-prompt-file capability", () => {
    const config: Partial<MawConfig> = {
      engines: {
        wrapped: { name: "wrapped", cmd: "my-wrapper", capabilities: ["system-prompt-file"] },
      },
    };
    expect(isClaudeLikeEngine("wrapped", config)).toBe(true);
  });

  it("does not match a raw command merely named like an unknown engine", () => {
    expect(isClaudeLikeEngine("mystery")).toBe(false);
  });
});
