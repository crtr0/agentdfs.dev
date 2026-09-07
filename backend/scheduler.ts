import {
  GLOBAL_DEADLINE_MINUTES_BEFORE_KICKOFF,
  PROTOCOL_VERSION,
  SCORE_REFRESH_INTERVAL_SECONDS,
} from "../src/shared/contracts";
import { one, transaction } from "./db/postgres";
import { createChallenge, entryClosesAt, refreshChallenge } from "./services/challenges";
import { getChallengePlayers, getSeasonSchedule } from "./services/provider";
import { syncChallengeScores } from "./services/scoring";
import type { ChallengeRecord, Env } from "./types";

const TICK_INTERVAL_MS = 15_000;
const RETRY_INTERVAL_MS = 60_000;

interface ScheduledJob {
  name: string;
  lockId: number;
  intervalMs: number;
  retryIntervalMs?: number;
  nextRunAt: number;
  run: () => Promise<unknown>;
}

async function withAdvisoryLock(
  env: Env,
  lockId: number,
  callback: () => Promise<unknown>,
): Promise<boolean> {
  const client = await env.DB.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [2026, lockId],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return false;
    await callback();
    return true;
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [2026, lockId]);
    }
    client.release();
  }
}

export async function reconcileChallengeSchedule(env: Env) {
  const season = Number(env.CURRENT_SEASON);
  const schedule = await getSeasonSchedule(env, season);
  const nextWeek = schedule.find((entry) => Date.parse(entry.firstGameAt) > Date.now());
  if (!nextWeek) return { created: false };

  const challengeId = `challenge_${season}_${nextWeek.week}`;
  const deadlineAt = new Date(
    Date.parse(nextWeek.firstGameAt) - GLOBAL_DEADLINE_MINUTES_BEFORE_KICKOFF * 60 * 1000,
  ).toISOString();
  if (Date.now() >= Date.parse(entryClosesAt(deadlineAt))) {
    return { created: false, entryClosed: true, challengeId };
  }
  const existing = await one<ChallengeRecord>(env.DB, "SELECT * FROM challenges WHERE id = $1", [challengeId]);
  if (existing) {
    const issuedRuns = await one<{ count: number }>(env.DB,
      "SELECT COUNT(*)::INTEGER AS count FROM runs WHERE challenge_id = $1", [challengeId]);
    const protocolChanged = existing.protocol_version !== PROTOCOL_VERSION;
    const timingChanged = existing.deadline_at !== deadlineAt;
    if (
      (protocolChanged || timingChanged)
      && Date.parse(existing.first_game_at) > Date.now()
      && (issuedRuns?.count ?? 0) === 0
    ) {
      await refreshChallenge(env.DB, env, {
        ...existing,
        released_at: protocolChanged ? new Date().toISOString() : existing.released_at,
        deadline_at: deadlineAt,
      });
      return { created: false, refreshed: true, challengeId };
    }
    return { created: false, challengeId };
  }

  // A successful provider fetch is the release event. Store one immutable
  // snapshot so every team receives the same player pool and prices.
  const players = await getChallengePlayers(
    env,
    season,
    nextWeek.week,
    challengeId,
    nextWeek.firstGameAt,
  );
  const releasedAt = new Date().toISOString();
  await createChallenge(env.DB, {
    id: challengeId,
    season,
    week: nextWeek.week,
    releasedAt,
    deadlineAt,
    firstGameAt: nextWeek.firstGameAt,
    players,
  });
  return { created: true, challengeId };
}

export async function reconcileChallengeLifecycle(env: Env, now = new Date().toISOString()) {
  return transaction(env.DB, async (client) => {
    const opened = await client.query(
      `UPDATE challenges SET status = 'open'
       WHERE status = 'ready' AND released_at <= $1 AND deadline_at > $2`,
      [now, now],
    );
    const closed = await client.query(
      `UPDATE challenges SET status = 'closed'
       WHERE status IN ('ready', 'open') AND deadline_at <= $1`,
      [now],
    );
    const expired = await client.query(
      `UPDATE runs SET status = 'expired'
       WHERE status != 'accepted' AND deadline_at <= $1`,
      [now],
    );
    return {
      opened: opened.rowCount ?? 0,
      closed: closed.rowCount ?? 0,
      expired: expired.rowCount ?? 0,
    };
  });
}

export async function reconcileScores(env: Env, now = new Date().toISOString()) {
  const challenges = await env.DB.query<ChallengeRecord>(
    `SELECT * FROM challenges
     WHERE first_game_at <= $1 AND status != 'final'
     ORDER BY season, week`,
    [now],
  );
  for (const challenge of challenges.rows) {
    await syncChallengeScores(env, challenge);
  }
  return { challengesUpdated: challenges.rows.length };
}

export function startScheduler(env: Env) {
  const jobs: ScheduledJob[] = [
    {
      name: "challenge-lifecycle",
      lockId: 1,
      intervalMs: TICK_INTERVAL_MS,
      nextRunAt: 0,
      run: () => reconcileChallengeLifecycle(env),
    },
    {
      name: "challenge-schedule",
      lockId: 2,
      intervalMs: 6 * 60 * 60 * 1000,
      nextRunAt: 0,
      run: () => reconcileChallengeSchedule(env),
    },
    {
      name: "score-sync",
      lockId: 3,
      intervalMs: SCORE_REFRESH_INTERVAL_SECONDS * 1000,
      retryIntervalMs: SCORE_REFRESH_INTERVAL_SECONDS * 1000,
      nextRunAt: 0,
      run: () => reconcileScores(env),
    },
  ];
  let stopped = false;
  let activeTick: Promise<void> | null = null;

  async function tick() {
    for (const job of jobs) {
      if (stopped || job.nextRunAt > Date.now()) continue;
      job.nextRunAt = Date.now() + job.intervalMs;
      try {
        await withAdvisoryLock(env, job.lockId, job.run);
      } catch (error) {
        job.nextRunAt = Date.now() + (job.retryIntervalMs ?? RETRY_INTERVAL_MS);
        console.error(`Scheduled job ${job.name} failed`, error);
      }
    }
  }

  function requestTick() {
    if (stopped || activeTick) return;
    activeTick = tick().finally(() => {
      activeTick = null;
    });
  }

  requestTick();
  const timer = setInterval(requestTick, TICK_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await activeTick;
    },
  };
}
