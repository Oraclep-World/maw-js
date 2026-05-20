import { describe, expect, test } from "bun:test";
import fixtures from "./bring-to-target.fixtures.json";
import { parseBringToTarget } from "../../src/commands/shared/bring-flags";

describe("portable bring --to target parser fixtures (#1816)", () => {
  for (const fixture of fixtures as Array<{
    name: string;
    input: string;
    expectedSession: string;
    expectedWindow?: string;
  }>) {
    test(fixture.name, () => {
      const result = parseBringToTarget(fixture.input);
      expect(result.session).toBe(fixture.expectedSession);
      if (fixture.expectedWindow !== undefined) {
        expect(result.window).toBe(fixture.expectedWindow);
      } else {
        expect(result.window).toBeUndefined();
      }
    });
  }
});
