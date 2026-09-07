import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createChallenge, getOrCreateRun } from "./services/challenges";
import { reconcileChallengeLifecycle, reconcileChallengeSchedule } from "./scheduler";
import type { Env, TeamRecord } from "./types";

function testEnvironment(): Env {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const directory = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    memory.public.none(readFileSync(resolve(directory, name), "utf8"));
  }
  const adapter = memory.adapters.createPg();
  return {
    DB: new adapter.Pool() as unknown as Pool,
    APP_BASE_URL: "https://fantasy.example",
    CURRENT_SEASON: "2099",
    SEASON_START_AT: "2099-09-10T00:00:00Z",
    SEASON_END_AT: "2100-01-11T23:59:59Z",
    FANTASYNERDS_BASE_URL: "https://api.fantasynerds.com",
    USE_FIXTURES: "true",
  };
}

describe("application scheduler", () => {
  it("prepares the next challenge idempotently", async () => {
    const env = testEnvironment();
    const beforeRelease = Date.now();
    await expect(reconcileChallengeSchedule(env)).resolves.toMatchObject({ created: true });
    const afterRelease = Date.now();
    await expect(reconcileChallengeSchedule(env)).resolves.toMatchObject({ created: false });
    const count = await env.DB.query<{ count: number }>(
      "SELECT COUNT(*)::INTEGER AS count FROM challenges",
    );
    expect(count.rows[0]?.count).toBe(1);
    const timing = await env.DB.query<{ released_at: string; deadline_at: string; first_game_at: string }>(
      "SELECT released_at, deadline_at, first_game_at FROM challenges",
    );
    expect(Date.parse(timing.rows[0]!.released_at)).toBeGreaterThanOrEqual(beforeRelease - 1_000);
    expect(Date.parse(timing.rows[0]!.released_at)).toBeLessThanOrEqual(afterRelease);
    expect(Date.parse(timing.rows[0]!.first_game_at) - Date.parse(timing.rows[0]!.deadline_at)).toBe(15 * 60 * 1000);
    await env.DB.end();
  });

  it("closes elapsed challenges and expires unfinished runs", async () => {
    const env = testEnvironment();
    const team: TeamRecord = {
      id: "team_scheduler",
      team_name: "Scheduler Team",
      x_handle: null,
      email: "scheduler@example.test",
      api_key_hash: "scheduler_hash",
      created_at: "2000-01-01T00:00:00Z",
    };
    await env.DB.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [team.id, team.team_name, "scheduler team", team.email, team.email, team.api_key_hash, team.created_at],
    );
    const challenge = await createChallenge(env.DB, {
      id: "challenge_elapsed",
      season: 0,
      week: 0,
      releasedAt: "2000-01-01T00:00:00Z",
      deadlineAt: "2000-01-01T00:05:00Z",
      firstGameAt: "2000-01-01T01:00:00Z",
    });
    const run = await getOrCreateRun(env.DB, challenge, team);

    await expect(reconcileChallengeLifecycle(env)).resolves.toMatchObject({ closed: 1, expired: 1 });
    const statuses = await env.DB.query<{ challenge_status: string; run_status: string }>(
      `SELECT c.status AS challenge_status, r.status AS run_status
       FROM challenges c JOIN runs r ON r.challenge_id = c.id
       WHERE r.id = $1`,
      [run.id],
    );
    expect(statuses.rows[0]).toEqual({ challenge_status: "closed", run_status: "expired" });
    await env.DB.end();
  });
});
