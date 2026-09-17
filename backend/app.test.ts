import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { Env } from "./types";
import {
  AUTONOMY_POLICY,
  CONTEST_RULES,
  type ChallengeResponse,
  type PublicLineupResponse,
  type PublicStateResponse,
} from "../src/shared/contracts";
import { createChallenge } from "./services/challenges";

function application() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const directory = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    memory.public.none(readFileSync(resolve(directory, name), "utf8"));
  }
  const adapter = memory.adapters.createPg();
  const database = new adapter.Pool() as unknown as Pool;
  const env: Env = {
    DB: database,
    APP_BASE_URL: "https://fantasy.example",
    EMAIL_FROM: "AgentDFS <test@example.com>",
    RESEND_API_KEY: "re_test",
    ADMIN_SECRET: "test-admin",
    CURRENT_SEASON: "2026",
    SEASON_START_AT: "2026-09-10T00:20:00Z",
    SEASON_END_AT: "2027-01-11T23:59:59Z",
    FANTASYNERDS_BASE_URL: "https://api.fantasynerds.com",
    USE_FIXTURES: "true",
  };
  return { app: createApp(env), database, env };
}

describe("Node application", () => {
  it("serves health checks and writes signups to PostgreSQL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { app, database, env } = application();
    const health = await app.request("/api/health", {}, env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "daily-fantasy-ai" });

    const signup = await app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Signup Test", email: "signup@example.test", x_handle: "@Signup_Test" }),
    }, env);
    expect(signup.status).toBe(201);
    const signupBody = await signup.json() as { apiKey: string; autonomyPolicy: unknown; contestRules: unknown; message: string; openApiUrl: string; team: { id: string; xHandle: string | null } };
    expect(signupBody).toMatchObject({
      message: expect.stringContaining("Team registered"),
      openApiUrl: "https://fantasy.example/api/openapi.json",
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
      team: { xHandle: "Signup_Test" },
    });

    const count = await database.query<{ count: number }>("SELECT COUNT(*)::INTEGER AS count FROM teams");
    expect(count.rows[0]?.count).toBe(1);
    const registered = await database.query<{ x_handle: string | null }>("SELECT x_handle FROM teams");
    expect(registered.rows[0]?.x_handle).toBe("Signup_Test");
    await database.query("UPDATE teams SET email_verified_at = NOW() WHERE normalized_email = $1", ["signup@example.test"]);
    const unavailable = await app.request("/api/challenges/active", {
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({
      available: false,
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
    });

    const globalDeadlineAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await createChallenge(database, {
      id: "challenge_2026_1",
      season: 2026,
      week: 1,
      releasedAt: new Date(Date.now() - 60_000).toISOString(),
      deadlineAt: globalDeadlineAt,
      firstGameAt: new Date(Date.parse(globalDeadlineAt) + 15 * 60 * 1000).toISOString(),
    });
    const active = await app.request("/api/challenges/active", {
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    const activeBody = await active.json() as ChallengeResponse;
    expect(activeBody.message).toContain("fixed 300-second clock");
    expect(activeBody.challenge).toMatchObject({ globalDeadlineAt });
    expect(Date.parse(activeBody.challenge.globalDeadlineAt) - Date.parse(activeBody.challenge.entryClosesAt)).toBe(300_000);
    expect(Date.parse(activeBody.run.deadlineAt) - Date.parse(activeBody.run.startedAt)).toBe(300_000);
    const repeated = await app.request("/api/challenges/active", {
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(await repeated.json()).toMatchObject({
      run: { runId: activeBody.run.runId, deadlineAt: activeBody.run.deadlineAt },
    });

    const lateGlobalDeadlineAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    await createChallenge(database, {
      id: "challenge_2026_2",
      season: 2026,
      week: 2,
      releasedAt: new Date(Date.now() - 60_000).toISOString(),
      deadlineAt: lateGlobalDeadlineAt,
      firstGameAt: new Date(Date.parse(lateGlobalDeadlineAt) + 15 * 60 * 1000).toISOString(),
    });
    const lateEntry = await app.request("/api/challenges/active", {
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(lateEntry.status).toBe(410);
    expect(await lateEntry.json()).toMatchObject({
      error: { code: "CHALLENGE_ENTRY_CLOSED" },
      contestRules: CONTEST_RULES,
    });

    const testChallenge = await app.request("/api/challenges/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(testChallenge.status).toBe(201);
    expect(await testChallenge.json()).toMatchObject({
      contestRules: CONTEST_RULES,
      challenge: {
        roster: CONTEST_RULES.roster,
        scoringSystem: CONTEST_RULES.scoringSystem,
      },
    });

    env.SEASON_START_AT = "2099-09-10T00:20:00Z";
    const sealedPublicState = await app.request("/api/public/state", {}, env);
    expect(await sealedPublicState.json()).toMatchObject({
      challenge: {
        firstGameAt: env.SEASON_START_AT,
        teamsRevealed: false,
        lineupRevealed: false,
      },
      standings: [],
    });
    const sealedLineup = await app.request(`/api/public/lineups/${signupBody.team.id}/1`, {}, env);
    expect(sealedLineup.status).toBe(403);
    expect(await sealedLineup.json()).toMatchObject({ error: { code: "LINEUP_SEALED" } });

    env.SEASON_START_AT = "2020-01-01T00:00:00Z";
    const publicState = await app.request("/api/public/state", {}, env);
    const publicStateBody = await publicState.json() as PublicStateResponse;
    expect(publicStateBody.weeks.find((week) => week.week === 1)).toMatchObject({
      week: 1,
      teamsRevealed: true,
      lineupRevealed: true,
      standings: [{ teamName: "Signup Test", xHandle: "Signup_Test" }],
    });
    await database.end();
    vi.restoreAllMocks();
  });

  it("publishes weekly winners and excludes teams that joined after that week's deadline", async () => {
    const { app, database, env } = application();
    env.SEASON_START_AT = "2020-01-01T00:00:00Z";
    await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
       VALUES
        ('team_winner', 'Weekly Winner', 'weekly winner', 'winner@example.test', 'winner@example.test', 'hash_1', '2026-09-01T00:00:00Z'),
        ('team_runner_up', 'Runner Up', 'runner up', 'runner@example.test', 'runner@example.test', 'hash_2', '2026-09-02T00:00:00Z'),
        ('team_late', 'Late Arrival', 'late arrival', 'late@example.test', 'late@example.test', 'hash_3', '2026-09-11T00:00:00Z')`,
    );
    await createChallenge(database, {
      id: "challenge_final_week",
      season: 2026,
      week: 1,
      releasedAt: "2026-09-01T00:00:00Z",
      deadlineAt: "2026-09-10T00:05:00Z",
      firstGameAt: "2026-09-10T00:20:00Z",
    });
    await database.query("UPDATE challenges SET status = 'final' WHERE id = 'challenge_final_week'");
    await database.query(
      `INSERT INTO runs
        (id, challenge_id, team_id, nonce, deadline_at, status, first_delivered_at, accepted_at, accepted_lineup_hash)
       VALUES
        ('run_winner', 'challenge_final_week', 'team_winner', 'nonce_1', '2026-09-10T00:05:00Z', 'accepted', '2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z', 'lineup_1'),
        ('run_runner_up', 'challenge_final_week', 'team_runner_up', 'nonce_2', '2026-09-10T00:05:00Z', 'accepted', '2026-09-02T00:00:00Z', '2026-09-02T00:01:00Z', 'lineup_2')`,
    );
    await database.query(
      `INSERT INTO scores (team_id, season, week, points, updated_at)
       VALUES
        ('team_winner', 2026, 1, 27.5, NOW()),
        ('team_runner_up', 2026, 1, 19.25, NOW()),
        ('team_late', 2026, 1, 99, NOW())`,
    );

    const response = await app.request("/api/public/state", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as PublicStateResponse;
    expect(body.weeks).toHaveLength(1);
    expect(body.weeks[0]).toMatchObject({
      week: 1,
      status: "final",
      standings: [
        { rank: 1, teamName: "Weekly Winner", weeklyPoints: 27.5 },
        { rank: 2, teamName: "Runner Up", weeklyPoints: 19.25 },
      ],
      winners: [{ rank: 1, teamName: "Weekly Winner", weeklyPoints: 27.5 }],
    });
    expect(body.weeks[0]?.standings.map((team) => team.teamName)).not.toContain("Late Arrival");
    await database.end();
  });

  it("rejects invalid X handles", async () => {
    const { app, database, env } = application();
    const signup = await app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Bad Handle", email: "bad-handle@example.test", x_handle: "not/a/handle" }),
    }, env);
    expect(signup.status).toBe(400);
    expect(await signup.json()).toMatchObject({ error: { code: "INVALID_SIGNUP" } });
    await database.end();
  });

  it("returns game times and available Fantasy Nerds points for revealed lineup players", async () => {
    const { app, database, env } = application();
    env.SEASON_START_AT = "2026-09-10T00:20:00Z";
    await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["team_public_lineup", "Public Lineup", "public lineup", "public@example.test",
        "public@example.test", "public_hash", "2026-09-01T00:00:00Z"],
    );
    const challenge = await createChallenge(database, {
      id: "challenge_2026_1",
      season: 2026,
      week: 1,
      releasedAt: "2026-09-01T00:00:00Z",
      deadlineAt: "2026-09-10T00:05:00Z",
      firstGameAt: "2026-09-09T20:20:00Z",
    });
    const [scoredPlayer, unscoredPlayer] = challenge.packet.players;
    await database.query(
      `INSERT INTO runs
        (id, challenge_id, team_id, nonce, deadline_at, status, first_delivered_at,
         accepted_at, accepted_lineup_hash)
       VALUES ($1, $2, $3, $4, $5, 'accepted', $6, $7, $8)`,
      ["run_public_lineup", challenge.id, "team_public_lineup", "nonce", "2026-09-10T00:05:00Z",
        "2026-09-01T00:00:00Z", "2026-09-01T00:01:00Z", "lineup_hash"],
    );
    await database.query(
      `INSERT INTO lineups
        (id, run_id, team_id, challenge_id, season, week, total_cost, lineup_hash, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ["lineup_public", "run_public_lineup", "team_public_lineup", challenge.id, 2026, 1,
        scoredPlayer!.price + unscoredPlayer!.price, "lineup_hash", "2026-09-01T00:01:00Z"],
    );
    await database.query(
      `INSERT INTO lineup_players (lineup_id, selection_id, player_id, slot)
       VALUES ($1, $2, $3, 'QB'), ($1, $4, $5, 'RB')`,
      ["lineup_public", scoredPlayer!.selectionId, scoredPlayer!.playerId,
        unscoredPlayer!.selectionId, unscoredPlayer!.playerId],
    );
    const harnessInfo = "Example model / autonomous agent / local harness";
    const chainOfThought = "Compared projected points and salary.\nTool log: checked player status.\n<script>example text</script>";
    await database.query(
      "UPDATE lineups SET harness_info = $1, chain_of_thought = $2 WHERE id = 'lineup_public'",
      [harnessInfo, chainOfThought],
    );
    await database.query(
      `INSERT INTO selection_scores (challenge_id, selection_id, points, updated_at)
       VALUES ($1, $2, $3, $4)`,
      [challenge.id, scoredPlayer!.selectionId, 12.34, "2026-09-10T03:00:00Z"],
    );

    const response = await app.request("/api/public/lineups/team_public_lineup/1", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as PublicLineupResponse;
    expect(body).toMatchObject({ harnessInfo, chainOfThought });
    const publicState = await app.request("/api/public/state", {}, env);
    const publicBody = await publicState.json() as PublicStateResponse;
    expect(publicBody.weeks[0]?.standings[0]?.harnessInfo).toBe(harnessInfo);
    expect(JSON.stringify(publicBody)).not.toContain("chainOfThought");

    env.SEASON_START_AT = "2099-09-10T00:20:00Z";
    const sealedState = await app.request("/api/public/state", {}, env);
    const sealedBody = await sealedState.json() as PublicStateResponse;
    expect(sealedBody.weeks[0]?.standings).toEqual([]);
    expect(JSON.stringify(sealedBody)).not.toContain(harnessInfo);
    const sealedLineup = await app.request("/api/public/lineups/team_public_lineup/1", {}, env);
    expect(sealedLineup.status).toBe(403);
    expect(body.players).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selectionId: scoredPlayer!.selectionId,
        gameStartsAt: "2026-09-10T00:20:00.000Z",
        points: 12.34,
      }),
      expect.objectContaining({
        selectionId: unscoredPlayer!.selectionId,
        gameStartsAt: "2026-09-10T00:20:00.000Z",
        points: null,
      }),
    ]));
    await database.end();
  });

  it("edits team names and X handles from the admin team page", async () => {
    const { app, database, env } = application();
    const authorization = `Basic ${Buffer.from("admin:test-admin").toString("base64")}`;
    await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at, x_handle)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8),
        ($9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        "team_edit", "Original Team", "original team", "edit@example.test", "edit@example.test", "edit_hash", "2026-09-01T00:00:00Z", "old_handle",
        "team_other", "Other Team", "other team", "other@example.test", "other@example.test", "other_hash", "2026-09-02T00:00:00Z", null,
      ],
    );

    const detail = await app.request("/admin/teams?id=team_edit", { headers: { Authorization: authorization } }, env);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('name="teamName" value="Original Team"');
    expect(html).toContain('name="x_handle" value="old_handle"');

    const updated = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "  Renamed   Team  ", x_handle: "@new_handle" }),
    }, env);
    expect(updated.status).toBe(303);
    expect(updated.headers.get("location")).toContain("updated=1");
    const team = await database.query<{ team_name: string; normalized_name: string; x_handle: string | null }>(
      "SELECT team_name, normalized_name, x_handle FROM teams WHERE id = $1",
      ["team_edit"],
    );
    expect(team.rows[0]).toEqual({ team_name: "Renamed Team", normalized_name: "renamed team", x_handle: "new_handle" });

    const duplicate = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "Other Team", x_handle: "" }),
    }, env);
    expect(duplicate.status).toBe(303);
    expect(duplicate.headers.get("location")).toContain("error=");

    const cleared = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "Renamed Team", x_handle: "" }),
    }, env);
    expect(cleared.status).toBe(303);
    const clearedTeam = await database.query<{ x_handle: string | null }>("SELECT x_handle FROM teams WHERE id = $1", ["team_edit"]);
    expect(clearedTeam.rows[0]?.x_handle).toBeNull();
    await database.end();
  });

  it("activates the API key only after email verification", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { app, database, env } = application();
    const signup = await app.request("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamName: "Verify Test", email: "verify@example.test" }) }, env);
    const body = await signup.json() as { apiKey: string };
    const blocked = await app.request("/api/challenges/test", { method: "POST", headers: { Authorization: `Bearer ${body.apiKey}` } }, env);
    expect(blocked.status).toBe(403);
    const token = (await database.query<{ token: string }>("SELECT token_hash AS token FROM email_verification_tokens")).rows[0]?.token;
    expect(token).toBeTruthy();
    await database.end();
    vi.restoreAllMocks();
  });

  it("redirects invalid verification links to the landing page", async () => {
    const { app, database, env } = application();
    const response = await app.request("/api/verify-email?token=invalid", {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("verification=failure");
    await database.end();
  });
});
