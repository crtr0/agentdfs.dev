import { Hono } from "hono";
import { PROTOCOL_VERSION } from "../../src/shared/contracts";
import { one, type Database } from "../db/postgres";
import { apiError } from "../lib/http";
import { requireApiKey } from "../middleware/auth";
import { appendAuditEvent } from "../services/audit";
import {
  challengeResponse,
  createChallenge,
  getOrCreateRun,
} from "../services/challenges";
import { submitLineup } from "../services/lineups";
import type { AppVariables, AttemptRecord, ChallengeRecord, Env, RunRecord } from "../types";

export const challengeRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

async function activeChallenge(db: Database, season: number): Promise<ChallengeRecord | null> {
  const now = new Date().toISOString();
  return one<ChallengeRecord>(db,
    `SELECT * FROM challenges
     WHERE season = $1 AND released_at <= $2 AND deadline_at > $3
     ORDER BY week DESC LIMIT 1`, [season, now, now]);
}

async function upcomingChallenge(db: Database, season: number): Promise<ChallengeRecord | null> {
  return one<ChallengeRecord>(db,
    `SELECT * FROM challenges
     WHERE season = $1 AND released_at > $2
     ORDER BY released_at ASC LIMIT 1`, [season, new Date().toISOString()]);
}

challengeRoutes.post("/challenges/test", requireApiKey, async (c) => {
  const team = c.get("team");
  const now = new Date();
  const challengeId = `challenge_test_${team.id}_${PROTOCOL_VERSION.replace(".", "_")}`;
  let challenge = await one<ChallengeRecord>(
    c.env.DB,
    "SELECT * FROM challenges WHERE id = $1",
    [challengeId],
  );
  let run = challenge
    ? await one<RunRecord>(
      c.env.DB,
      "SELECT * FROM runs WHERE challenge_id = $1 AND team_id = $2",
      [challenge.id, team.id],
    )
    : null;

  if (run && Date.parse(run.deadline_at) <= now.getTime()) {
    await c.env.DB.query("DELETE FROM challenges WHERE id = $1", [challengeId]);
    challenge = null;
    run = null;
  }

  const created = !run;
  if (!run) {
    const releasedAt = now.toISOString();
    const deadlineAt = new Date(
      now.getTime() + Number(c.env.CHALLENGE_WINDOW_SECONDS || 300) * 1000,
    ).toISOString();
    if (challenge) await c.env.DB.query("DELETE FROM challenges WHERE id = $1", [challenge.id]);
    challenge = await createChallenge(c.env.DB, {
      id: challengeId,
      season: 0,
      week: 0,
      releasedAt,
      deadlineAt,
      firstGameAt: deadlineAt,
    });
    run = await getOrCreateRun(c.env.DB, challenge, team);
  }
  if (!challenge || !run) throw new Error("Test challenge creation failed");
  await appendAuditEvent(c.env.DB, run.id, created ? "challenge.delivered" : "challenge.redelivered", {
    challengeId: challenge.id,
    contentHash: challenge.content_hash,
    protocolVersion: challenge.protocol_version,
    transport: "https",
    test: true,
  });
  return c.json(challengeResponse(
    c.env.APP_BASE_URL,
    challenge,
    run,
    "TEST challenge retrieved. This is an offline Yahoo-shaped fixture; submit a valid lineup before the five-minute deadline to verify your integration. It never affects live scoring or standings.",
  ), created ? 201 : 200);
});

challengeRoutes.get("/challenges/active", requireApiKey, async (c) => {
  const team = c.get("team");
  const season = Number(c.env.CURRENT_SEASON);
  let challenge = await activeChallenge(c.env.DB, season);
  if (!challenge) {
    const upcoming = await upcomingChallenge(c.env.DB, season);
    const waitSeconds = Math.min(Math.max(Number(c.req.query("wait") ?? 0), 0), 25);
    if (upcoming && waitSeconds > 0) {
      const untilRelease = Date.parse(upcoming.released_at) - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitSeconds * 1000, Math.max(untilRelease, 0))));
      challenge = await activeChallenge(c.env.DB, season);
    }
    if (!challenge) {
      if (upcoming) {
        c.header("Retry-After", "30");
        return c.json({
          message: "No weekly challenge is available yet. Try again after its release time.",
          available: false,
        });
      }
      const latest = await one<{ deadline_at: string }>(
        c.env.DB,
        "SELECT deadline_at FROM challenges WHERE season = $1 ORDER BY week DESC LIMIT 1",
        [season],
      );
      if (latest && Date.now() >= Date.parse(latest.deadline_at)) {
        return apiError(c, 410, "CHALLENGE_CLOSED", "The current challenge window is closed.");
      }
      return c.json({
        message: "No weekly challenge is currently available.",
        available: false,
      });
    }
  }

  const run = await getOrCreateRun(c.env.DB, challenge, team);
  await appendAuditEvent(c.env.DB, run.id, "challenge.delivered", {
    challengeId: challenge.id,
    contentHash: challenge.content_hash,
    protocolVersion: challenge.protocol_version,
    transport: "https",
    client: c.req.header("User-Agent") ?? "unknown",
  });
  return c.json(challengeResponse(
    c.env.APP_BASE_URL,
    challenge,
    run,
  ));
});

challengeRoutes.post("/runs/:runId/lineup", requireApiKey, async (c) => {
  const team = c.get("team");
  const rawBody = await c.req.text();
  const receivedAt = new Date().toISOString();
  const routeRunId = c.req.param("runId");
  if (!routeRunId) return apiError(c, 404, "RUN_NOT_FOUND", "Run not found.");
  const result = await submitLineup({
    db: c.env.DB,
    routeRunId,
    teamId: team.id,
    rawBody,
    receivedAt,
    transport: "https",
  });
  return c.json(result.body, result.status);
});

challengeRoutes.get("/runs/:runId/status", requireApiKey, async (c) => {
  const team = c.get("team");
  const run = await one<RunRecord>(
    c.env.DB,
    "SELECT * FROM runs WHERE id = $1 AND team_id = $2",
    [c.req.param("runId"), team.id],
  );
  if (!run) return apiError(c, 404, "RUN_NOT_FOUND", "Run not found.");
  if (run.status !== "accepted" && Date.now() >= Date.parse(run.deadline_at)) {
    run.status = "expired";
    await c.env.DB.query("UPDATE runs SET status = 'expired' WHERE id = $1", [run.id]);
  }
  const latestAttempt = await one<AttemptRecord>(c.env.DB,
    `SELECT status, validation_errors, received_at FROM attempts
     WHERE run_id = $1 ORDER BY received_at DESC LIMIT 1`, [run.id]);
  return c.json({
    message: `Run status retrieved: ${run.status}.`,
    runId: run.id,
    status: run.status,
    deadlineAt: run.deadline_at,
    acceptedAt: run.accepted_at,
    latestAttempt: latestAttempt ? {
      status: latestAttempt.status,
      receivedAt: latestAttempt.received_at,
      errors: latestAttempt.validation_errors,
    } : null,
  });
});
