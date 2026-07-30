import { describe, expect, test } from "bun:test";
import { isSameOracleName, oracleNameKey } from "../src/commands/shared/oracle-name-key";

describe("oracleNameKey", () => {
  test("collapses the three spellings of one oracle to one key", () => {
    // session name / window name / what the operator types
    expect(oracleNameKey("08-PQ")).toBe("pq");
    expect(oracleNameKey("pq-oracle")).toBe("pq");
    expect(oracleNameKey("PQ")).toBe("pq");
  });

  test("survives hyphens inside the stem", () => {
    expect(oracleNameKey("13-pqBot-executor")).toBe("pqbotexecutor");
    expect(oracleNameKey("pqbot-executor-oracle")).toBe("pqbotexecutor");
    expect(oracleNameKey("pqBot-executor")).toBe("pqbotexecutor");
  });

  test("trims surrounding whitespace", () => {
    expect(oracleNameKey("  AQ  ")).toBe("aq");
  });

  test("empty and prefix-only input normalize to empty", () => {
    expect(oracleNameKey("")).toBe("");
    expect(oracleNameKey("   ")).toBe("");
    expect(oracleNameKey("-oracle")).toBe("");
  });
});

describe("isSameOracleName", () => {
  // The exact pairs that made `maw hey` auto-wake a live oracle: the tmux
  // window is lowercased at creation, the oracle name is not.
  test.each([
    ["pq-oracle", "PQ"],
    ["bq-oracle", "BQ"],
    ["aq-oracle", "AQ"],
    ["pqbot-executor-oracle", "pqBot-executor"],
    ["08-PQ", "PQ"],
    ["13-pqBot-executor", "pqBot-executor"],
    ["ferris-oracle", "ferris"],
  ])("matches %s against %s", (windowName, bareAgent) => {
    expect(isSameOracleName(windowName, bareAgent)).toBe(true);
  });

  test("does not match different oracles", () => {
    expect(isSameOracleName("pq-oracle", "BQ")).toBe(false);
    expect(isSameOracleName("ferris-oracle", "ora101")).toBe(false);
    // substring must not be enough — `pq` is a prefix of `pqbotexecutor`
    expect(isSameOracleName("pqbot-executor-oracle", "PQ")).toBe(false);
  });

  test("an empty name never matches — not even another empty name", () => {
    expect(isSameOracleName("", "")).toBe(false);
    expect(isSameOracleName("", "PQ")).toBe(false);
    expect(isSameOracleName("pq-oracle", "")).toBe(false);
  });
});
