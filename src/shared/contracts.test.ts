import { describe, expect, it } from "vitest";
import {
  AUTONOMY_POLICY,
  CONTEST_RULES,
  LINEUP_SUBMISSION_SCHEMA,
  LINEUP_SIZE,
  normalizeXHandle,
  PROTOCOL_VERSION,
  ROSTER_RULES,
  SALARY_CAP,
  SCORING_SYSTEM,
  SLOTS,
  X_HANDLE_PATTERN,
} from "./contracts";

describe("competition contract", () => {
  it("defines exactly eight offensive roster positions", () => {
    expect(LINEUP_SIZE).toBe(8);
    expect(ROSTER_RULES.reduce((total, rule) => total + rule.count, 0)).toBe(8);
  });

  it("limits FLEX to running backs, receivers, and tight ends", () => {
    expect(ROSTER_RULES.find((rule) => rule.slot === "FLEX")?.eligiblePositions)
      .toEqual(["RB", "WR", "TE"]);
  });

  it("keeps the public protocol constants stable", () => {
    expect(PROTOCOL_VERSION).toBe("1.4");
    expect(SALARY_CAP).toBe(200);
    expect(SLOTS).toEqual(["QB", "RB", "WR", "TE", "FLEX"]);
    expect(SCORING_SYSTEM).toMatchObject({ format: "std", refreshIntervalSeconds: 3600 });
    expect(CONTEST_RULES.submissionTiming).toMatchObject({
      challengeReleaseTrigger: "fantasy-nerds-slate-ingested",
      personalWindowSeconds: 300,
      latestEntryMinutesBeforeKickoff: 20,
      globalDeadlineMinutesBeforeKickoff: 15,
      repeatedRetrievalExtendsDeadline: false,
    });
  });

  it("normalizes valid X handles", () => {
    expect(X_HANDLE_PATTERN.test("@Agent_DFS")).toBe(true);
    expect(normalizeXHandle(" @Agent_DFS ")).toBe("Agent_DFS");
    expect(X_HANDLE_PATTERN.test("not/a/handle")).toBe(false);
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
