import { getWeekScores } from "./provider";
import { transaction } from "../db/postgres";
import type { ChallengeRecord, Env } from "../types";

interface LineupPlayerRow {
  team_id: string;
  player_id: string;
}

export async function syncChallengeScores(env: Env, challenge: ChallengeRecord) {
  const provider = await getWeekScores(env, challenge.season, challenge.week);
  const rows = await env.DB.query<LineupPlayerRow>(
    `SELECT l.team_id, lp.player_id FROM lineups l
     JOIN lineup_players lp ON lp.lineup_id = l.id
     WHERE l.challenge_id = $1`,
    [challenge.id],
  );
  const totals = new Map<string, number>();
  for (const row of rows.rows) {
    totals.set(row.team_id, (totals.get(row.team_id) ?? 0) + (provider.points.get(row.player_id) ?? 0));
  }

  const now = new Date().toISOString();
  const teams = await env.DB.query<{ id: string }>("SELECT id FROM teams");
  await transaction(env.DB, async (client) => {
    for (const team of teams.rows) {
      await client.query(
        `INSERT INTO scores (team_id, season, week, points, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(team_id, season, week)
         DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`,
        [team.id, challenge.season, challenge.week, totals.get(team.id) ?? 0, now],
      );
    }

    await client.query("DELETE FROM standings WHERE season = $1", [challenge.season]);
    await client.query(
      `INSERT INTO standings (team_id, season, season_points, rank, updated_at)
       SELECT team_id, $1, season_points,
         RANK() OVER (ORDER BY season_points DESC)::INTEGER AS rank, $2
       FROM (
         SELECT t.id AS team_id, COALESCE(SUM(s.points), 0) AS season_points
         FROM teams t LEFT JOIN scores s ON s.team_id = t.id AND s.season = $3
         GROUP BY t.id
       ) ranked`,
      [challenge.season, now, challenge.season],
    );

    if (provider.allFinal) {
      await client.query("UPDATE challenges SET status = 'final' WHERE id = $1", [challenge.id]);
    }
  });
  return { teamsUpdated: teams.rows.length, allFinal: provider.allFinal };
}
