import {
  AUTONOMY_POLICY,
  CONTEST_RULES,
  LINEUP_SUBMISSION_SCHEMA,
  PROTOCOL_VERSION,
  ROSTER_RULES,
  SALARY_CAP,
  SCORING_SYSTEM,
  type ChallengePacket,
  type ChallengePlayer,
  type ChallengeResponse,
  type RosterRule,
} from "../../src/shared/contracts";
import { fixturePlayers } from "../fixtures/players";
import { randomId, sha256, stableStringify } from "../lib/crypto";
import { apiAction } from "../lib/http";
import type { ChallengeRecord, RunRecord, TeamRecord } from "../types";
import { one, transaction, type Database } from "../db/postgres";
import { getChallengePlayers } from "./provider";
import type { Env } from "../types";

export interface CreateChallengeInput {
  id: string;
  season: number;
  week: number;
  releasedAt: string;
  deadlineAt: string;
  firstGameAt: string;
  players?: ChallengePlayer[];
  roster?: readonly RosterRule[];
}

export async function refreshChallenge(db: Database, env: Env, challenge: ChallengeRecord) {
  const players = await getChallengePlayers(env, challenge.season, challenge.week, challenge.id, challenge.first_game_at);
  const generatedAt = new Date().toISOString();
  const packetWithoutHash = {
    challengeId: challenge.id,
    season: challenge.season,
    week: challenge.week,
    releasedAt: challenge.released_at,
    deadlineAt: challenge.deadline_at,
    firstGameAt: challenge.first_game_at,
    salaryCap: SALARY_CAP,
    roster: ROSTER_RULES,
    scoringSystem: SCORING_SYSTEM,
    players,
    submissionSchema: LINEUP_SUBMISSION_SCHEMA,
    generatedAt,
  };
  const contentHash = await sha256(stableStringify(packetWithoutHash));
  const packet = { ...packetWithoutHash, contentHash };
  await transaction(db, async (client) => {
    // The foreign keys on all challenge-owned records use ON DELETE CASCADE.
    // Removing the challenge first ensures stale runs, attempts, audits, and
    // accepted lineups cannot survive the destructive refresh.
    await client.query("DELETE FROM challenges WHERE id = $1", [challenge.id]);
    await client.query(
      `INSERT INTO challenges
        (id, season, week, status, protocol_version, released_at, deadline_at,
         first_game_at, salary_cap, packet, content_hash, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        challenge.id,
        challenge.season,
        challenge.week,
        Date.parse(challenge.released_at) > Date.now() ? "ready" : "open",
        PROTOCOL_VERSION,
        challenge.released_at,
        challenge.deadline_at,
        challenge.first_game_at,
        SALARY_CAP,
        packet,
        contentHash,
        generatedAt,
      ],
    );
    for (const entry of players) {
      await client.query(
        `INSERT INTO selections
          (challenge_id, selection_id, player_id, provider_player_id, name, nfl_team,
           opponent, position, eligible_slots, price, player_status, game_starts_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [challenge.id, entry.selectionId, entry.playerId, entry.playerId, entry.name, entry.team,
          entry.opponent, entry.position, entry.eligibleSlots, entry.price, entry.status, entry.gameStartsAt],
      );
    }
    await client.query(
      "UPDATE challenges SET packet = $1, content_hash = $2, generated_at = $3 WHERE id = $4",
      [packet, contentHash, packetWithoutHash.generatedAt, challenge.id],
    );
  });
  return { challengeId: challenge.id, players: players.length, contentHash };
}

export async function createChallenge(
  db: Database,
  input: CreateChallengeInput,
): Promise<ChallengeRecord> {
  const id = input.id;
  const generatedAt = new Date().toISOString();
  const players = input.players ?? fixturePlayers(id, input.firstGameAt);
  const packetWithoutHash = {
    challengeId: id,
    season: input.season,
    week: input.week,
    releasedAt: input.releasedAt,
    deadlineAt: input.deadlineAt,
    firstGameAt: input.firstGameAt,
    salaryCap: SALARY_CAP,
    roster: input.roster ?? ROSTER_RULES,
    scoringSystem: SCORING_SYSTEM,
    players,
    submissionSchema: LINEUP_SUBMISSION_SCHEMA,
    generatedAt,
  };
  const contentHash = await sha256(stableStringify(packetWithoutHash));
  const packet: ChallengePacket = { ...packetWithoutHash, contentHash };
  const status = Date.parse(input.releasedAt) > Date.now() ? "ready" : "open";

  await transaction(db, async (client) => {
    await client.query(
      `INSERT INTO challenges
        (id, season, week, status, protocol_version, released_at, deadline_at,
         first_game_at, salary_cap, packet, content_hash, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.season,
        input.week,
        status,
        PROTOCOL_VERSION,
        input.releasedAt,
        input.deadlineAt,
        input.firstGameAt,
        SALARY_CAP,
        packet,
        contentHash,
        generatedAt,
      ],
    );

    for (const entry of players) {
      await client.query(
        `INSERT INTO selections
          (challenge_id, selection_id, player_id, provider_player_id, name, nfl_team,
           opponent, position, eligible_slots, price, player_status, game_starts_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING`,
        [
          id,
          entry.selectionId,
          entry.playerId,
          entry.playerId,
          entry.name,
          entry.team,
          entry.opponent,
          entry.position,
          entry.eligibleSlots,
          entry.price,
          entry.status,
          entry.gameStartsAt,
        ],
      );
    }
  });

  const challenge = await one<ChallengeRecord>(db, "SELECT * FROM challenges WHERE id = $1", [id]);
  if (!challenge) throw new Error("Challenge creation failed");
  return challenge;
}

export async function getOrCreateRun(
  db: Database,
  challenge: ChallengeRecord,
  team: TeamRecord,
  deadlineAt = challenge.deadline_at,
): Promise<RunRecord> {
  const runId = randomId("run");
  const nonce = randomId("nonce");
  const deliveredAt = new Date().toISOString();

  await db.query(
    `INSERT INTO runs
      (id, challenge_id, team_id, nonce, deadline_at, status, first_delivered_at)
     VALUES ($1, $2, $3, $4, $5, 'delivered', $6)
     ON CONFLICT DO NOTHING`,
    [runId, challenge.id, team.id, nonce, deadlineAt, deliveredAt],
  );

  const run = await one<RunRecord>(
    db,
    "SELECT * FROM runs WHERE challenge_id = $1 AND team_id = $2",
    [challenge.id, team.id],
  );
  if (!run) throw new Error("Run creation failed");
  return run;
}

export function challengeResponse(
  appBaseUrl: string,
  challenge: ChallengeRecord,
  run: RunRecord,
  message = `Week ${challenge.week} challenge retrieved. The autonomous phase is active; choose and submit a valid lineup before the deadline without human input or approval.`,
): ChallengeResponse {
  return {
    message,
    available: true,
    protocolVersion: PROTOCOL_VERSION,
    autonomyPolicy: AUTONOMY_POLICY,
    contestRules: CONTEST_RULES,
    run: { runId: run.id, nonce: run.nonce },
    actions: {
      submitLineup: apiAction(appBaseUrl, "POST", `/api/runs/${run.id}/lineup`),
      getStatus: apiAction(appBaseUrl, "GET", `/api/runs/${run.id}/status`),
    },
    challenge: { ...challenge.packet, deadlineAt: run.deadline_at },
  };
}
