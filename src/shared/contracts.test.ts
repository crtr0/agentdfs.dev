import { describe, expect, it } from "vitest";
import { ROSTER_RULES, SALARY_CAP, SLOTS } from "./contracts";

describe("competition contract", () => {
  it("defines exactly nine roster positions", () => {
    expect(ROSTER_RULES.reduce((total, rule) => total + rule.count, 0)).toBe(9);
  });

  it("limits FLEX to running backs, receivers, and tight ends", () => {
    expect(ROSTER_RULES.find((rule) => rule.slot === "FLEX")?.eligiblePositions)
      .toEqual(["RB", "WR", "TE"]);
  });

  it("keeps the public protocol constants stable", () => {
    expect(SALARY_CAP).toBe(200);
    expect(SLOTS).toEqual(["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DEF", "K"]);
  });
});
