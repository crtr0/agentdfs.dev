import { Hono } from "hono";
import type { PublicStateResponse, PublicTeamStanding } from "../../src/shared/contracts";
import { one } from "../db/postgres";
import { apiError } from "../lib/http";
import type { ChallengeRecord, Env } from "../types";

interface StandingRow {
  id: string;
  team_name: string;
  x_handle: string | null;
  weekly_points: number;
  season_points: number;
  run_status: string | null;
}

export const publicRoutes = new Hono<{ Bindings: Env }>();

function publicKickoffAt(env: Env, challenge: ChallengeRecord): string {
  return challenge.week === 1 ? env.SEASON_START_AT : challenge.first_game_at;
}

function ranked(rows: StandingRow[], final: boolean): PublicTeamStanding[] {
  const sorted = [...rows].sort((left, right) => {
    const pointDifference = final
      ? right.season_points - left.season_points
      : right.weekly_points - left.weekly_points;
    return pointDifference || left.team_name.localeCompare(right.team_name);
  });
  let rank = 0;
  let lastPoints: number | null = null;
  return sorted.map((row, index) => {
    const points = final ? row.season_points : row.weekly_points;
    if (lastPoints === null || points !== lastPoints) rank = index + 1;
    lastPoints = points;
    return {
      id: row.id,
      rank,
      teamName: row.team_name,
      xHandle: row.x_handle,
      weeklyPoints: row.weekly_points,
      seasonPoints: row.season_points,
      submissionStatus: row.run_status === "accepted"
        ? "accepted"
        : row.run_status === "expired" || row.run_status === "invalid"
          ? "missed"
          : "pending",
    };
  });
}

publicRoutes.get("/public/state", async (c) => {
  const season = Number(c.env.CURRENT_SEASON);
  const now = Date.now();
  const counts = await one<{ registered: number }>(c.env.DB, "SELECT COUNT(*) AS registered FROM teams");
  const challenges = await c.env.DB.query<ChallengeRecord>(
    "SELECT * FROM challenges WHERE season = $1 ORDER BY week ASC",
    [season],
  );
  const allChallenges = challenges.rows;
  const week18Final = allChallenges.some((challenge) => challenge.week === 18 && challenge.status === "final");
  const state = now < Date.parse(c.env.SEASON_START_AT)
    ? "preseason"
    : week18Final || now >= Date.parse(c.env.SEASON_END_AT)
      ? "final"
      : "in-season";

  let active: ChallengeRecord | undefined;
  if (allChallenges.length > 0) {
    active = allChallenges.findLast((challenge) => Date.parse(challenge.first_game_at) <= now)
      ?? allChallenges[0];
  }
  const kickoffStarted = active
    ? now >= Date.parse(publicKickoffAt(c.env, active))
    : false;

  let standings: PublicTeamStanding[] = [];
  if (state === "final" || (state === "in-season" && kickoffStarted)) {
    const week = active?.week ?? 1;
    const rows = await c.env.DB.query<StandingRow>(
      `SELECT t.id, t.team_name, t.x_handle,
        COALESCE(s.points, 0) AS weekly_points,
        COALESCE(st.season_points, totals.season_points, 0) AS season_points,
        r.status AS run_status
       FROM teams t
       LEFT JOIN scores s ON s.team_id = t.id AND s.season = $1 AND s.week = $2
       LEFT JOIN standings st ON st.team_id = t.id AND st.season = $1
       LEFT JOIN (
         SELECT team_id, SUM(points) AS season_points
         FROM scores WHERE season = $1 GROUP BY team_id
       ) totals ON totals.team_id = t.id
       LEFT JOIN runs r ON r.team_id = t.id AND r.challenge_id = $3`,
      [season, week, active?.id ?? ""],
    );
    standings = ranked(rows.rows, state === "final");
  }

  const response: PublicStateResponse = {
    message: state === "preseason"
      ? "Registration is open for the upcoming season."
      : state === "final"
        ? "Final season standings retrieved."
        : `Week ${active?.week ?? 1} standings retrieved.`,
    state,
    season,
    seasonStartsAt: c.env.SEASON_START_AT,
    seasonEndsAt: c.env.SEASON_END_AT,
    activeWeek: state === "preseason" ? null : active?.week ?? null,
    registeredTeams: counts?.registered ?? 0,
    challenge: active ? {
      releasedAt: active.released_at,
      deadlineAt: active.deadline_at,
      firstGameAt: publicKickoffAt(c.env, active),
      teamsRevealed: kickoffStarted,
      lineupRevealed: kickoffStarted,
    } : undefined,
    standings,
  };
  return c.json(response);
});

publicRoutes.get("/public/lineups/:teamId/:week", async (c) => {
  const season = Number(c.env.CURRENT_SEASON);
  const week = Number(c.req.param("week"));
  const challenge = await one<ChallengeRecord>(
    c.env.DB,
    "SELECT * FROM challenges WHERE season = $1 AND week = $2",
    [season, week],
  );
  if (!challenge) return apiError(c, 404, "CHALLENGE_NOT_FOUND", "Challenge not found.");
  if (Date.now() < Date.parse(publicKickoffAt(c.env, challenge))) {
    return apiError(c, 403, "LINEUP_SEALED", "Lineups remain sealed until the first kickoff.");
  }

  const lineup = await one<{
    id: string;
    total_cost: number;
    accepted_at: string;
    team_name: string;
  }>(c.env.DB,
    `SELECT l.id, l.total_cost, l.accepted_at, t.team_name
     FROM lineups l JOIN teams t ON t.id = l.team_id
     WHERE l.team_id = $1 AND l.season = $2 AND l.week = $3`,
    [c.req.param("teamId"), season, week]);
  if (!lineup) return apiError(c, 404, "LINEUP_NOT_FOUND", "No lineup was accepted.");
  const players = await c.env.DB.query(
    `SELECT lp.slot, s.selection_id AS "selectionId", s.name, s.nfl_team AS team,
      s.position, s.price
     FROM lineup_players lp
     JOIN selections s ON s.challenge_id = $1 AND s.selection_id = lp.selection_id
     WHERE lp.lineup_id = $2 ORDER BY lp.slot, s.name`,
    [challenge.id, lineup.id],
  );
  return c.json({
    message: `Week ${week} accepted lineup retrieved for ${lineup.team_name}.`,
    teamName: lineup.team_name,
    season,
    week,
    totalCost: lineup.total_cost,
    acceptedAt: lineup.accepted_at,
    players: players.rows,
  });
});
