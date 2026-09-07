import { eligibleSlots, type ChallengePlayer } from "../../src/shared/contracts";

type FixturePlayer = Omit<ChallengePlayer, "selectionId" | "gameStartsAt">;

const player = (
  playerId: string,
  name: string,
  team: string,
  opponent: string,
  position: string,
  price: number,
  status = "ACTIVE",
): FixturePlayer => ({
  playerId,
  name,
  team,
  opponent,
  position,
  eligibleSlots: eligibleSlots(position),
  price,
  status,
});

export const FIXTURE_PLAYER_POOL: FixturePlayer[] = [
  player("p_qb_buf", "Josh Allen", "BUF", "MIA", "QB", 34),
  player("p_qb_bal", "Lamar Jackson", "BAL", "CIN", "QB", 33),
  player("p_qb_phi", "Jalen Hurts", "PHI", "DAL", "QB", 31),
  player("p_qb_hou", "C.J. Stroud", "HOU", "IND", "QB", 27),
  player("p_rb_atl", "Bijan Robinson", "ATL", "CAR", "RB", 30),
  player("p_rb_det", "Jahmyr Gibbs", "DET", "GB", "RB", 29),
  player("p_rb_sf", "Christian McCaffrey", "SF", "SEA", "RB", 28, "QUESTIONABLE"),
  player("p_rb_bal", "Derrick Henry", "BAL", "CIN", "RB", 27),
  player("p_rb_lar", "Kyren Williams", "LAR", "ARI", "RB", 24),
  player("p_rb_nyJ", "Breece Hall", "NYJ", "NE", "RB", 23),
  player("p_rb_buf", "James Cook", "BUF", "MIA", "RB", 21),
  player("p_wr_min", "Justin Jefferson", "MIN", "CHI", "WR", 31),
  player("p_wr_cin", "Ja'Marr Chase", "CIN", "BAL", "WR", 31),
  player("p_wr_det", "Amon-Ra St. Brown", "DET", "GB", "WR", 29),
  player("p_wr_dal", "CeeDee Lamb", "DAL", "PHI", "WR", 29),
  player("p_wr_mia", "Tyreek Hill", "MIA", "BUF", "WR", 27),
  player("p_wr_hou", "Nico Collins", "HOU", "IND", "WR", 25),
  player("p_wr_lar", "Puka Nacua", "LAR", "ARI", "WR", 24),
  player("p_wr_gb", "Jayden Reed", "GB", "DET", "WR", 19),
  player("p_te_kc", "Travis Kelce", "KC", "LV", "TE", 24),
  player("p_te_det", "Sam LaPorta", "DET", "GB", "TE", 22),
  player("p_te_ari", "Trey McBride", "ARI", "LAR", "TE", 21),
  player("p_te_buf", "Dalton Kincaid", "BUF", "MIA", "TE", 18),
];

export function fixturePlayers(challengeId: string, firstGameAt: string): ChallengePlayer[] {
  return FIXTURE_PLAYER_POOL.map((entry, index) => ({
    ...entry,
    selectionId: `sel_${challengeId}_${String(index + 1).padStart(2, "0")}`,
    gameStartsAt: firstGameAt,
  }));
}
