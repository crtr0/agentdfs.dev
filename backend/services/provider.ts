import { eligibleSlots, type ChallengePlayer } from "../../src/shared/contracts";
import { fixturePlayers, FIXTURE_PLAYER_POOL } from "../fixtures/players";
import type { Env } from "../types";

interface FantasyScheduleGame {
  season: number;
  week: number;
  game_date?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  winner?: string | null;
}

interface FantasyScore {
  playerId?: number | string | null;
  team?: string | null;
  position?: string | null;
  points?: number | string | null;
}

interface FantasyLeadersResponse {
  season?: number | string;
  format?: string;
  week?: number | string;
  players?: FantasyScore[];
}

interface FantasyNerdsScheduleResponse {
  schedule?: FantasyScheduleGame[];
}

export interface WeekSchedule {
  season: number;
  week: number;
  firstGameAt: string;
}

export interface ProviderScoreResult {
  points: Map<string, number>;
  allFinal: boolean;
}

const allowedPositions = new Set(["QB", "RB", "WR", "TE"]);

async function providerFetchJson<T>(env: Env, path: string): Promise<T> {
  if (!env.FANTASYNERDS_API_KEY) throw new Error("FANTASYNERDS_API_KEY is required");
  const url = new URL(`${env.FANTASYNERDS_BASE_URL || "https://api.fantasynerds.com"}${path}`);
  url.searchParams.set("apikey", env.FANTASYNERDS_API_KEY);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Fantasy Nerds ${response.status}: ${path}`);
  return (await response.json()) as T;
}

function fixtureSchedule(season: number): WeekSchedule[] {
  const firstKickoff = Date.parse(`${season}-09-10T00:20:00Z`);
  return Array.from({ length: 18 }, (_, index) => ({
    season,
    week: index + 1,
    firstGameAt: new Date(firstKickoff + index * 7 * 24 * 60 * 60 * 1000).toISOString(),
  }));
}

export async function getSeasonSchedule(env: Env, season: number): Promise<WeekSchedule[]> {
  if (env.USE_FIXTURES === "true" || !env.FANTASYNERDS_API_KEY) return fixtureSchedule(season);
  const scheduleResponse = await providerFetchJson<FantasyNerdsScheduleResponse>(env, "/v1/nfl/schedule");
  const games = scheduleResponse.schedule ?? [];
  const weeks = new Map<number, number>();
  for (const game of games) {
    if (game.week < 1 || game.week > 18) continue;
    const value = game.game_date;
    if (!value) continue;
    const timestamp = Date.parse(value);
    const existing = weeks.get(game.week);
    if (!Number.isNaN(timestamp) && (existing === undefined || timestamp < existing)) {
      weeks.set(game.week, timestamp);
    }
  }
  return [...weeks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([week, timestamp]) => ({ season, week, firstGameAt: new Date(timestamp).toISOString() }));
}

export async function getChallengePlayers(
  env: Env,
  season: number,
  week: number,
  challengeId: string,
  firstGameAt: string,
): Promise<ChallengePlayer[]> {
  if (env.USE_FIXTURES === "true" || !env.FANTASYNERDS_API_KEY) {
    return fixturePlayers(challengeId, firstGameAt);
  }

  if (!env.FANTASYNERDS_API_KEY) throw new Error("FANTASYNERDS_API_KEY is required");
  const slateListing = await providerFetchJson<Record<string, unknown>>(env, "/v1/nfl/dfs-slates");
  const yahoo = ((slateListing.platforms as Record<string, unknown> | undefined)?.yahoo ?? []) as Array<Record<string, unknown>>;
  const eligibleSlates = yahoo.filter((candidate) =>
    Number(candidate.season) === season && Number(candidate.week) === week,
  );
  const slate = eligibleSlates.reduce<Record<string, unknown> | null>((best, candidate) => {
    if (!best || Number(candidate.teams ?? 0) > Number(best.teams ?? 0)) return candidate;
    return best;
  }, null);
  if (!slate?.slateId) throw new Error(`No Yahoo DFS slate found for ${season} week ${week}`);
  const [dfs, scheduleResponse] = await Promise.all([
    providerFetchJson<Record<string, unknown>>(env, `/v1/nfl/dfs?slateId=${encodeURIComponent(String(slate.slateId))}`),
    providerFetchJson<FantasyNerdsScheduleResponse>(env, "/v1/nfl/schedule"),
  ]);
  const entries = (dfs.players ?? dfs.data ?? []) as Array<Record<string, unknown>>;
  const games = (scheduleResponse.schedule ?? []).filter((game) => Number(game.week) === week);

  return entries.flatMap((entry, index) => {
    const rawPosition = String(entry.position ?? "").split(/[,/]/)[0].trim();
    const position = rawPosition;
    const team = String(entry.team ?? entry.team_code ?? "");
    const game = games.find((candidate) => candidate.home_team === team || candidate.away_team === team);
    const opponent = String(entry.opponent ?? (game?.home_team === team ? game.away_team : game?.home_team) ?? "");
    const providerId = entry.playerId;
    const salary = Number(entry.salary ?? entry.yahoo_salary ?? entry.operator_salary ?? 0);
    const gameStartsAt = String(entry.game_date ?? game?.game_date ?? slate.slate_start ?? firstGameAt);
    if (!providerId || !entry.name || !team || !opponent || salary <= 0
      || !allowedPositions.has(position)) return [];
    return [{
      selectionId: `sel_${challengeId}_${String(index + 1).padStart(3, "0")}`,
      playerId: `fantasynerds_${providerId}`,
      name: String(entry.name),
      team,
      opponent,
      position,
      eligibleSlots: eligibleSlots(position),
      // Fantasy Nerds returns Yahoo salaries already expressed in Yahoo's $200 scale
      // (for example, 14 means $14). Do not convert them from a $50,000 scale.
      price: Math.max(1, Math.round(salary)),
      status: String(entry.status ?? "ACTIVE").toUpperCase(),
      gameStartsAt: new Date(gameStartsAt).toISOString(),
    } satisfies ChallengePlayer];
  });
}

export async function getWeekScores(env: Env, season: number, week: number): Promise<ProviderScoreResult> {
  if (env.USE_FIXTURES === "true" || !env.FANTASYNERDS_API_KEY) {
    const points = new Map<string, number>();
    for (const entry of FIXTURE_PLAYER_POOL) {
      const seed = [...entry.playerId].reduce((total, char) => total + char.charCodeAt(0), week * 17);
      points.set(entry.playerId, Number(((seed % 240) / 10).toFixed(2)));
    }
    return { points, allFinal: false };
  }

  const [leaders, scheduleResponse] = await Promise.all([
    providerFetchJson<FantasyLeadersResponse>(env, `/v1/nfl/leaders?format=std&position=ALL&week=${week}`),
    providerFetchJson<FantasyNerdsScheduleResponse>(env, "/v1/nfl/schedule"),
  ]);
  if (Number(leaders.season) !== season || Number(leaders.week) !== week || leaders.format !== "std") {
    throw new Error(`Fantasy Nerds returned an unexpected leaders result for ${season} week ${week}`);
  }

  const points = new Map<string, number>();
  for (const player of leaders.players ?? []) {
    if (!player.playerId || !allowedPositions.has(player.position ?? "")) continue;
    const total = Number(player.points);
    if (Number.isFinite(total)) points.set(`fantasynerds_${player.playerId}`, total);
  }
  const games = (scheduleResponse.schedule ?? []).filter((game) => game.season === season && game.week === week);
  return { points, allFinal: games.length > 0 && games.every((game) => Boolean(game.winner)) };
}
