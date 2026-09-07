import { describe, expect, it } from "vitest";
import { AUTONOMY_POLICY, PROTOCOL_VERSION } from "../../src/shared/contracts";
import { validateLineup, type SelectionRecord } from "./lineups";
import type { RunRecord } from "../types";

const run: RunRecord = {
  id: "run_test",
  challenge_id: "challenge_test",
  team_id: "team_test",
  nonce: "nonce_test",
  deadline_at: "2099-01-01T00:00:00Z",
  status: "delivered",
  first_delivered_at: "2098-12-31T23:55:00Z",
  accepted_at: null,
  accepted_lineup_hash: null,
};

function selection(id: string, playerId: string, position: string, price: number): SelectionRecord {
  const slots = position === "RB" || position === "WR" || position === "TE"
    ? [position, "FLEX"]
    : [position];
  return {
    selection_id: id,
    player_id: playerId,
    name: playerId,
    position,
    eligible_slots: slots,
    price,
  };
}

const selections = [
  selection("qb", "quarterback", "QB", 28),
  selection("rb1", "running-one", "RB", 25),
  selection("rb2", "running-two", "RB", 23),
  selection("rb3", "running-three", "RB", 22),
  selection("wr1", "receiver-one", "WR", 24),
  selection("wr2", "receiver-two", "WR", 21),
  selection("wr3", "receiver-three", "WR", 20),
  selection("te", "tight-end", "TE", 18),
  selection("def", "defense", "DEF", 11),
];

const validLineup = [
  { selectionId: "qb", slot: "QB" },
  { selectionId: "rb1", slot: "RB" },
  { selectionId: "rb2", slot: "RB" },
  { selectionId: "wr1", slot: "WR" },
  { selectionId: "wr2", slot: "WR" },
  { selectionId: "wr3", slot: "WR" },
  { selectionId: "te", slot: "TE" },
  { selectionId: "rb3", slot: "FLEX" },
  { selectionId: "def", slot: "DEF" },
] as Array<{ selectionId: string; slot: string }>;

const autonomyAttestation = {
  policyId: AUTONOMY_POLICY.id,
  policyVersion: AUTONOMY_POLICY.version,
  affirmed: true,
};

function validate(lineup = validLineup) {
  return validateLineup(
    { protocolVersion: PROTOCOL_VERSION, runId: run.id, nonce: run.nonce, autonomyAttestation, lineup },
    run.id,
    run,
    selections,
  );
}

describe("lineup validation", () => {
  it("accepts a complete legal lineup", () => {
    const result = validate();
    expect(result.errors).toEqual([]);
    expect(result.totalCost).toBe(192);
    expect(result.entries).toHaveLength(9);
  });

  it("reports an unknown selection", () => {
    const lineup = validLineup.map((entry) => ({ ...entry }));
    lineup[0].selectionId = "missing";
    expect(validate(lineup).errors.map((entry) => entry.code)).toContain("UNKNOWN_SELECTION");
  });

  it("reports duplicate players", () => {
    const duplicate = selection("rb-copy", "running-one", "RB", 25);
    const lineup = validLineup.map((entry) => ({ ...entry }));
    lineup[2].selectionId = duplicate.selection_id;
    const result = validateLineup(
      { protocolVersion: PROTOCOL_VERSION, runId: run.id, nonce: run.nonce, autonomyAttestation, lineup },
      run.id,
      run,
      [...selections, duplicate],
    );
    expect(result.errors.map((entry) => entry.code)).toContain("DUPLICATE_SELECTION");
  });

  it("reports incorrect slot counts and eligibility", () => {
    const lineup = validLineup.map((entry) => ({ ...entry }));
    lineup[0].slot = "FLEX";
    const codes = validate(lineup).errors.map((entry) => entry.code);
    expect(codes).toContain("INVALID_SLOT");
    expect(codes).toContain("SLOT_COUNT");
  });

  it("reports salary cap violations", () => {
    const expensive = selections.map((entry) => ({ ...entry, price: entry.price + 10 }));
    const result = validateLineup(
      { protocolVersion: PROTOCOL_VERSION, runId: run.id, nonce: run.nonce, autonomyAttestation, lineup: validLineup },
      run.id,
      run,
      expensive,
    );
    expect(result.totalCost).toBeGreaterThan(200);
    expect(result.errors.map((entry) => entry.code)).toContain("SALARY_CAP_EXCEEDED");
  });

  it("reports run and nonce mismatches", () => {
    const result = validateLineup(
      { protocolVersion: PROTOCOL_VERSION, runId: "other", nonce: "other", autonomyAttestation, lineup: validLineup },
      run.id,
      run,
      selections,
    );
    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["RUN_MISMATCH", "NONCE_MISMATCH"]));
  });

  it("rejects an invalid autonomy attestation", () => {
    const result = validateLineup(
      {
        protocolVersion: PROTOCOL_VERSION,
        runId: run.id,
        nonce: run.nonce,
        autonomyAttestation: { ...autonomyAttestation, affirmed: false },
        lineup: validLineup,
      },
      run.id,
      run,
      selections,
    );
    expect(result.errors.map((entry) => entry.code)).toContain("AUTONOMY_ATTESTATION_INVALID");
  });
});
