import { Hono } from "hono";
import { AUTONOMY_POLICY, CONTEST_RULES, LINEUP_WINDOW_SECONDS, PROTOCOL_VERSION } from "../../src/shared/contracts";
import { one, type Database } from "../db/postgres";
import { apiError } from "../lib/http";
import { requireApiKey } from "../middleware/auth";
import { appendAuditEvent } from "../services/audit";
import {
  challengeResponse,
  createChallenge,
  entryClosesAt,
  getOrCreateRun,
} from "../services/challenges";
import { submitLineup } from "../services/lineups";
import type { AppVariables, AttemptRecord, ChallengeRecord, Env, RunRecord } from "../types";

export const challengeRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

async function activeChallenge(db: Database, season: number, now: string): Promise<ChallengeRecord | null> {
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
    const deadlineAt = new Date(now.getTime() + LINEUP_WINDOW_SECONDS * 1000).toISOString();
    if (challenge) await c.env.DB.query("DELETE FROM challenges WHERE id = $1", [challenge.id]);
    challenge = await createChallenge(c.env.DB, {
      id: challengeId,
      season: 0,
      week: 0,
      releasedAt,
      deadlineAt,
      firstGameAt: deadlineAt,
    });
    run = await getOrCreateRun(c.env.DB, challenge, team, releasedAt);
  }
  if (!challenge || !run) throw new Error("Test challenge creation failed");
  await appendAuditEvent(c.env.DB, run.id, created ? "challenge.delivered" : "challenge.redelivered", {
    challengeId: challenge.id,
    contentHash: challenge.content_hash,
    protocolVersion: challenge.protocol_version,
    autonomyPolicyId: AUTONOMY_POLICY.id,
    autonomyPolicyVersion: AUTONOMY_POLICY.version,
    runDeadlineAt: run.deadline_at,
    transport: "https",
    test: true,
  });
  return c.json(challengeResponse(
    c.env.APP_BASE_URL,
    challenge,
    run,
    `TEST challenge retrieved. This is an offline fixture; human assistance is allowed. Your fixed 300-second clock ends at ${run.deadline_at}. It never affects live scoring or standings.`,
  ), created ? 201 : 200);
});

challengeRoutes.get("/challenges/active", requireApiKey, async (c) => {
  const team = c.get("team");
  const season = Number(c.env.CURRENT_SEASON);
  let now = new Date().toISOString();
  let challenge = await activeChallenge(c.env.DB, season, now);
  if (!challenge) {
    const upcoming = await upcomingChallenge(c.env.DB, season);
    const waitSeconds = Math.min(Math.max(Number(c.req.query("wait") ?? 0), 0), 25);
    if (upcoming && waitSeconds > 0) {
      const untilRelease = Date.parse(upcoming.released_at) - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitSeconds * 1000, Math.max(untilRelease, 0))));
      now = new Date().toISOString();
      challenge = await activeChallenge(c.env.DB, season, now);
    }
    if (!challenge) {
      if (upcoming) {
        c.header("Retry-After", "30");
        return c.json({
          message: "No weekly challenge is available yet. The autonomous phase has begun; continue without human input and try again after release.",
          available: false,
          autonomyPolicy: AUTONOMY_POLICY,
          contestRules: CONTEST_RULES,
        });
      }
      const latest = await one<{ deadline_at: string }>(
        c.env.DB,
        "SELECT deadline_at FROM challenges WHERE season = $1 ORDER BY week DESC LIMIT 1",
        [season],
      );
      if (latest && Date.now() >= Date.parse(latest.deadline_at)) {
        const message = "The current challenge window is closed and the autonomous phase has ended.";
        return c.json({
          message,
          error: { code: "CHALLENGE_CLOSED", message },
          autonomyPolicy: AUTONOMY_POLICY,
          contestRules: CONTEST_RULES,
        }, 410);
      }
      return c.json({
        message: "No weekly challenge is currently available. The autonomous phase has begun; continue without human input.",
        available: false,
        autonomyPolicy: AUTONOMY_POLICY,
        contestRules: CONTEST_RULES,
      });
    }
  }

  let run = await one<RunRecord>(c.env.DB,
    "SELECT * FROM runs WHERE challenge_id = $1 AND team_id = $2", [challenge.id, team.id]);
  const redelivered = Boolean(run);
  if (run && run.status !== "accepted" && Date.parse(run.deadline_at) <= Date.parse(now)) {
    await c.env.DB.query("UPDATE runs SET status = 'expired' WHERE id = $1", [run.id]);
    const message = `Your 300-second submission window ended at ${run.deadline_at}. Retrieving the challenge again does not start a new clock.`;
    return c.json({
      message,
      error: { code: "RUN_DEADLINE_EXPIRED", message },
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
      run: { runId: run.id, startedAt: run.first_delivered_at, deadlineAt: run.deadline_at },
    }, 410);
  }
  if (!run && Date.parse(now) >= Date.parse(entryClosesAt(challenge.deadline_at))) {
    const message = `New entries closed at ${entryClosesAt(challenge.deadline_at)} so every agent can receive a full 300 seconds before the global deadline at ${challenge.deadline_at}.`;
    return c.json({
      message,
      error: { code: "CHALLENGE_ENTRY_CLOSED", message },
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
    }, 410);
  }
  run ??= await getOrCreateRun(c.env.DB, challenge, team, now);
  await appendAuditEvent(c.env.DB, run.id, redelivered ? "challenge.redelivered" : "challenge.delivered", {
    challengeId: challenge.id,
    contentHash: challenge.content_hash,
    protocolVersion: challenge.protocol_version,
    autonomyPolicyId: AUTONOMY_POLICY.id,
    autonomyPolicyVersion: AUTONOMY_POLICY.version,
    runDeadlineAt: run.deadline_at,
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
    message: `Run status retrieved: ${run.status}. The fixed 300-second submission deadline is ${run.deadline_at}.`,
    runId: run.id,
    status: run.status,
    startedAt: run.first_delivered_at,
    deadlineAt: run.deadline_at,
    submissionWindowSeconds: LINEUP_WINDOW_SECONDS,
    secondsRemaining: Math.min(
      LINEUP_WINDOW_SECONDS,
      Math.max(0, Math.ceil((Date.parse(run.deadline_at) - Date.now()) / 1000)),
    ),
    acceptedAt: run.accepted_at,
    latestAttempt: latestAttempt ? {
      status: latestAttempt.status,
      receivedAt: latestAttempt.received_at,
      errors: latestAttempt.validation_errors,
    } : null,
  });
});
