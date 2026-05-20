import { describe, expect, test } from "bun:test";
import fixtures from "./bring-to-flag.fixtures.json";
import { translateBringToFlag } from "../../src/commands/shared/bring-flags";

describe("portable bring --to flag translation fixtures (#1816)", () => {
  for (const fixture of fixtures as Array<{
    name: string;
    input: string[];
    expectedArgv: string[];
    expectedAnchorWindow?: string;
  }>) {
    test(fixture.name, () => {
      const result = translateBringToFlag(fixture.input);
      expect(result.argv).toEqual(fixture.expectedArgv);
      if (fixture.expectedAnchorWindow !== undefined) {
        expect(result.anchorWindow).toBe(fixture.expectedAnchorWindow);
      } else {
        expect(result.anchorWindow).toBeUndefined();
      }
    });
  }
});
