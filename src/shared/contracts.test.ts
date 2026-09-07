import { describe, expect, it } from "vitest";
import { AUTONOMY_POLICY, LINEUP_SUBMISSION_SCHEMA, PROTOCOL_VERSION, ROSTER_RULES, SALARY_CAP, SLOTS } from "./contracts";

describe("competition contract", () => {
  it("defines exactly nine roster positions", () => {
    expect(ROSTER_RULES.reduce((total, rule) => total + rule.count, 0)).toBe(9);
  });

  it("limits FLEX to running backs, receivers, and tight ends", () => {
    expect(ROSTER_RULES.find((rule) => rule.slot === "FLEX")?.eligiblePositions)
      .toEqual(["RB", "WR", "TE"]);
  });

  it("keeps the public protocol constants stable", () => {
    expect(PROTOCOL_VERSION).toBe("1.1");
    expect(SALARY_CAP).toBe(200);
    expect(SLOTS).toEqual(["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DEF", "K"]);
  });

  it("defines the agent-only policy and requires its attestation", () => {
    expect(AUTONOMY_POLICY).toMatchObject({
      id: "agent-only-lineup",
      humanPlayerSelectionAllowed: false,
      humanApprovalAllowed: false,
      testChallengesExempt: true,
    });
    expect(LINEUP_SUBMISSION_SCHEMA.required).toContain("autonomyAttestation");
  });
});
