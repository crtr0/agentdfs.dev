import { setTimeout as delay } from "node:timers/promises";
import { LINEUP_WINDOW_SECONDS } from "../../src/shared/contracts";
import { entryClosesAt } from "./challenges";
import type { ChallengeRecord, Env } from "../types";

interface EmailPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

interface Notification {
  season: number;
  week: number;
  team_id: string;
  payload: EmailPayload;
  entry_closes_at: string;
  first_attempt_at: string | null;
  attempts: number;
}

// Resend retains idempotency keys for 24 hours. Stop uncertain retries early
// rather than risk a duplicate once that retention window has passed.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_SENDS_PER_PASS = 20;

function emailTime(timestamp: string): string {
  const date = new Date(timestamp);
  const format = (timeZone: string) => new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone,
  }).format(date);
  return `${format("America/Los_Angeles")} / ${format("America/New_York")} (${date.toISOString()})`;
}

export function challengeAnnouncement(env: Env, challenge: ChallengeRecord, email: string): EmailPayload {
  return {
    from: env.EMAIL_FROM ?? "AgentDFS <onboarding@resend.dev>",
    to: [email],
    subject: `AgentDFS ${challenge.season}: Week ${challenge.week} is open for submissions 🏈`,
    text: `Week ${challenge.week} of the ${challenge.season} Agent Fantasy Football season is open for submissions!

Start your agent's run before: ${emailTime(entryClosesAt(challenge.deadline_at))}
Final submission cutoff: ${emailTime(challenge.deadline_at)}
First kickoff: ${emailTime(challenge.first_game_at)}

Your agent has five minutes (300 seconds) from its first successful challenge retrieval to submit. Its personal deadline may be earlier than the final cutoff above. Starting a new run closes five minutes before the final cutoff, which is 15 minutes before kickoff.

Complete any human-provided strategy, instructions, and setup before your agent invokes get_active_challenge. Your agent must choose and submit its lineup autonomously without human player selection or approval. If you have not yet verified your email, use your registration confirmation email before starting a run.

Visit ${env.APP_BASE_URL.replace(/\/$/, "")} for setup instructions, the active week, and past results. Visiting the website does not start your submission clock.

You are receiving this notice because your team is registered for AgentDFS.`,
  };
}

/** Called under the scheduler's advisory lock, shared by all app Machines. */
export async function reconcileChallengeNotifications(env: Env) {
  if (!env.RESEND_API_KEY) return { queued: 0, sent: 0, failed: 0, skipped: "email-not-configured" };
  const startedAt = Date.now();
  const now = new Date(startedAt).toISOString();
  const challenges = await env.DB.query<ChallengeRecord>(
    `SELECT * FROM challenges WHERE season = $1 AND season > 0 AND week BETWEEN 1 AND 18
       AND status = 'open' AND released_at <= $2 AND deadline_at > $3 ORDER BY week`,
    [Number(env.CURRENT_SEASON), now, new Date(startedAt + LINEUP_WINDOW_SECONDS * 1000).toISOString()],
  );
  let queued = 0;
  for (const challenge of challenges.rows) {
    const teams = await env.DB.query<{ id: string; email: string }>(
      `SELECT t.id, t.email FROM teams t
       LEFT JOIN challenge_notifications n ON n.team_id = t.id AND n.season = $1 AND n.week = $2
       WHERE n.team_id IS NULL`,
      [challenge.season, challenge.week],
    );
    for (const team of teams.rows) {
      const inserted = await env.DB.query(
        `INSERT INTO challenge_notifications
          (season, week, team_id, payload, entry_closes_at, created_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT DO NOTHING`,
        [challenge.season, challenge.week, team.id, challengeAnnouncement(env, challenge, team.email),
          entryClosesAt(challenge.deadline_at), now],
      );
      queued += inserted.rowCount ?? 0;
    }
  }

  await env.DB.query(
    `UPDATE challenge_notifications SET status = 'expired', last_error = 'Entry window closed'
     WHERE status = 'pending' AND entry_closes_at <= $1`, [now],
  );
  const pending = await env.DB.query<Notification>(
    `SELECT n.* FROM challenge_notifications n
     JOIN challenges c ON c.season = n.season AND c.week = n.week
     WHERE n.status = 'pending' AND n.next_attempt_at <= $1 AND n.entry_closes_at > $1
       AND c.season = $2 AND c.status = 'open' AND c.released_at <= $1
       AND c.deadline_at > $3
     ORDER BY n.next_attempt_at, n.team_id LIMIT $4`,
    [now, Number(env.CURRENT_SEASON), new Date(startedAt + LINEUP_WINDOW_SECONDS * 1000).toISOString(), MAX_SENDS_PER_PASS],
  );
  let sent = 0;
  let failed = 0;
  for (const notification of pending.rows) {
    if (Date.now() - startedAt >= 20_000) break;
    const key = [notification.season, notification.week, notification.team_id];
    const attemptAt = new Date().toISOString();
    if (Date.now() >= Date.parse(notification.entry_closes_at)) continue;
    if (notification.first_attempt_at && Date.now() - Date.parse(notification.first_attempt_at) >= RETRY_WINDOW_MS) {
      await env.DB.query(
        `UPDATE challenge_notifications SET status = 'failed', last_error = 'Retry window exceeded; check provider delivery before retrying'
         WHERE season = $1 AND week = $2 AND team_id = $3`, key,
      );
      failed += 1;
      continue;
    }
    // Persist before sending so a crash can retry the exact payload and key.
    await env.DB.query(
      `UPDATE challenge_notifications SET first_attempt_at = COALESCE(first_attempt_at, $4),
         attempts = attempts + 1, next_attempt_at = $5
       WHERE season = $1 AND week = $2 AND team_id = $3`,
      [...key, attemptAt, new Date(Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(notification.attempts, 4))).toISOString()],
    );
    let emailId: string;
    try {
      // Native fetch provides a bounded timeout for this background job.
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `challenge-open/${notification.season}/${notification.week}/${notification.team_id}`,
        },
        body: JSON.stringify(notification.payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
      const body = await response.json() as { id?: string };
      if (!body.id) throw new Error("Email provider did not return a delivery ID");
      emailId = body.id;
    } catch (error) {
      failed += 1;
      await env.DB.query(
        `UPDATE challenge_notifications SET last_error = $4 WHERE season = $1 AND week = $2 AND team_id = $3`,
        [...key, error instanceof Error ? error.message : "Email request failed"],
      );
      await delay(1000);
      continue;
    }
    await env.DB.query(
      `UPDATE challenge_notifications SET status = 'sent', sent_at = $4, provider_email_id = $5, last_error = NULL
       WHERE season = $1 AND week = $2 AND team_id = $3`,
      [...key, new Date().toISOString(), emailId],
    );
    sent += 1;
    await delay(1000);
  }
  if (queued || sent || failed) console.info("Challenge notification delivery", { queued, sent, failed });
  return { queued, sent, failed };
}
