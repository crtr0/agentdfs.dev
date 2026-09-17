import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { AUTONOMY_POLICY, PROTOCOL_VERSION, HARNESS_INFO_MAX_LENGTH, CHAIN_OF_THOUGHT_MAX_LENGTH, type ChallengePlayer } from "../../src/shared/contracts";
import { createChallenge, getOrCreateRun } from "./challenges";
import { submitLineup } from "./lineups";
import type { TeamRecord } from "../types";

function testDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const directory = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    memory.public.none(readFileSync(resolve(directory, name), "utf8"));
  }
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as unknown as Pool;
}

function selected(players: ChallengePlayer[], playerId: string, slot: string) {
  const player = players.find((entry) => entry.playerId === playerId);
  if (!player) throw new Error(`Missing fixture player ${playerId}`);
  return { selectionId: player.selectionId, slot };
}

describe("PostgreSQL lineup acceptance", () => {
  it.each([false, true])("preserves first-writer acceptance and idempotency with metadata=%s", async (withMetadata) => {
    const database = testDatabase();
    const team: TeamRecord = {
      id: "team_postgres",
      team_name: "Postgres Team",
      x_handle: null,
      email: "postgres@example.test",
      api_key_hash: "postgres_hash",
      created_at: "2026-08-29T00:00:00.000Z",
    };
    await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [team.id, team.team_name, "postgres team", team.email, team.email, team.api_key_hash, team.created_at],
    );

    const challenge = await createChallenge(database, {
      id: "challenge_postgres",
      season: 2026,
      week: 1,
      releasedAt: "2026-08-29T00:00:00.000Z",
      deadlineAt: "2099-08-29T00:05:00.000Z",
      firstGameAt: "2099-08-29T01:00:00.000Z",
    });
    const run = await getOrCreateRun(database, challenge, team);
    const players = challenge.packet.players;
    const lineup = [
      selected(players, "p_qb_hou", "QB"),
      selected(players, "p_rb_nyJ", "RB"),
      selected(players, "p_rb_buf", "RB"),
      selected(players, "p_wr_lar", "WR"),
      selected(players, "p_wr_gb", "WR"),
      selected(players, "p_wr_min", "WR"),
      selected(players, "p_te_buf", "TE"),
      selected(players, "p_rb_lar", "FLEX"),
    ];
    const receivedAt = "2026-08-29T00:01:00.000Z";
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      runId: run.id,
      nonce: run.nonce,
      autonomyAttestation: {
        policyId: AUTONOMY_POLICY.id,
        policyVersion: AUTONOMY_POLICY.version,
        affirmed: true,
      },
      lineup,
      ...(withMetadata ? {
        harnessInfo: "Example LLM / Agent / Harness",
        chainOfThought: "Compared projections.\nTool: retrieved player availability.\nSelected an eligible lineup.",
      } : {}),
    });

    for (const metadata of [
      { harnessInfo: 123 },
      { chainOfThought: [] },
      { harnessInfo: "a".repeat(HARNESS_INFO_MAX_LENGTH + 1) },
      { chainOfThought: "a".repeat(CHAIN_OF_THOUGHT_MAX_LENGTH + 1) },
    ]) {
      const invalid = await submitLineup({
        db: database, routeRunId: run.id, teamId: team.id,
        rawBody: JSON.stringify({ ...JSON.parse(body), ...metadata }), receivedAt, transport: "https",
      });
      expect(invalid.status).toBe(422);
    }

    const accepted = await submitLineup({
      db: database,
      routeRunId: run.id,
      teamId: team.id,
      rawBody: body,
      receivedAt,
      transport: "https",
    });
    expect(accepted.status).toBe(200);

    const repeated = await submitLineup({
      db: database,
      routeRunId: run.id,
      teamId: team.id,
      rawBody: JSON.stringify({ ...JSON.parse(body), harnessInfo: "Replacement", chainOfThought: "Replacement" }),
      receivedAt,
      transport: "https",
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.message).toContain("already accepted");

    const competing = [...lineup];
    competing[0] = selected(players, "p_qb_phi", "QB");
    const conflict = await submitLineup({
      db: database,
      routeRunId: run.id,
      teamId: team.id,
      rawBody: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        runId: run.id,
        nonce: run.nonce,
        autonomyAttestation: {
          policyId: AUTONOMY_POLICY.id,
          policyVersion: AUTONOMY_POLICY.version,
          affirmed: true,
        },
        lineup: competing,
      }),
      receivedAt,
      transport: "https",
    });
    expect(conflict.status).toBe(409);

    const late = await submitLineup({
      db: database,
      routeRunId: run.id,
      teamId: team.id,
      rawBody: body,
      receivedAt: run.deadline_at,
      transport: "https",
    });
    expect(late).toMatchObject({
      status: 410,
      body: { error: { code: "RUN_DEADLINE_EXPIRED" } },
    });

    for (const [table, expected] of [
      ["lineups", 1],
      ["lineup_players", 8],
      ["attempts", 8],
      ["audit_events", 8],
    ] as const) {
      const count = await database.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`);
      expect(count.rows[0]?.count).toBe(expected);
    }
    const acceptedAudit = await database.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE event_type = 'submission.accepted'",
    );
    expect(acceptedAudit.rows[0]?.metadata).toMatchObject({
      autonomyAttestation: {
        policyId: AUTONOMY_POLICY.id,
        policyVersion: AUTONOMY_POLICY.version,
        affirmed: true,
      },
    });
    const stored = await database.query("SELECT harness_info, chain_of_thought FROM lineups");
    expect(stored.rows[0]).toEqual({
      harness_info: withMetadata ? JSON.parse(body).harnessInfo : null,
      chain_of_thought: withMetadata ? JSON.parse(body).chainOfThought : null,
    });
    await database.end();
  });
});
