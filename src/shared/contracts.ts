export const PROTOCOL_VERSION = "1.0" as const;
export const SALARY_CAP = 200 as const;

export const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "DEF", "K"] as const;
export type Slot = (typeof SLOTS)[number];

export const ROSTER_RULES: ReadonlyArray<{
  slot: Slot;
  count: number;
  eligiblePositions: string[];
}> = [
  { slot: "QB", count: 1, eligiblePositions: ["QB"] },
  { slot: "RB", count: 2, eligiblePositions: ["RB"] },
  { slot: "WR", count: 3, eligiblePositions: ["WR"] },
  { slot: "TE", count: 1, eligiblePositions: ["TE"] },
  { slot: "FLEX", count: 1, eligiblePositions: ["RB", "WR", "TE"] },
  { slot: "DEF", count: 1, eligiblePositions: ["DEF"] },
  { slot: "K", count: 0, eligiblePositions: ["K"] },
];

export function eligibleSlots(position: string): Slot[] {
  return ROSTER_RULES
    .filter((rule) => rule.eligiblePositions.includes(position))
    .map((rule) => rule.slot);
}

export interface ChallengePlayer {
  selectionId: string;
  playerId: string;
  name: string;
  team: string;
  opponent: string;
  position: string;
  eligibleSlots: Slot[];
  price: number;
  status: string;
  gameStartsAt: string;
}

export interface ChallengePacket {
  challengeId: string;
  season: number;
  week: number;
  releasedAt: string;
  deadlineAt: string;
  firstGameAt: string;
  salaryCap: 200;
  roster: typeof ROSTER_RULES;
  players: ChallengePlayer[];
  submissionSchema: Record<string, unknown>;
  generatedAt: string;
  contentHash: string;
}

export interface RunAction {
  method: "GET" | "POST";
  url: string;
  authorization: {
    scheme: "Bearer";
    credential: "apiKey";
  };
}

export interface ChallengeResponse {
  message: string;
  available: true;
  protocolVersion: typeof PROTOCOL_VERSION;
  run: {
    runId: string;
    nonce: string;
  };
  actions: {
    submitLineup: RunAction;
    getStatus: RunAction;
  };
  challenge: ChallengePacket;
}

export interface LineupEntry {
  selectionId: string;
  slot: Slot;
}

export interface LineupSubmission {
  protocolVersion: string;
  runId: string;
  nonce: string;
  lineup: LineupEntry[];
}

export interface ValidationError {
  code: string;
  message: string;
}

export type PublicSeasonState = "preseason" | "in-season" | "final";

export interface PublicTeamStanding {
  id: string;
  rank: number;
  teamName: string;
  weeklyPoints: number;
  seasonPoints: number;
  submissionStatus: "accepted" | "missed" | "pending";
}

export interface PublicStateResponse {
  message: string;
  state: PublicSeasonState;
  season: number;
  seasonStartsAt: string;
  seasonEndsAt: string;
  activeWeek: number | null;
  registeredTeams: number;
  challenge?: {
    releasedAt: string;
    deadlineAt: string;
    firstGameAt: string;
    lineupRevealed: boolean;
  };
  standings: PublicTeamStanding[];
}

export const LINEUP_SUBMISSION_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "runId", "nonce", "lineup"],
  properties: {
    protocolVersion: { const: PROTOCOL_VERSION },
    runId: { type: "string", minLength: 1 },
    nonce: { type: "string", minLength: 1 },
    lineup: {
      type: "array",
      minItems: 9,
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["selectionId", "slot"],
        properties: {
          selectionId: { type: "string", minLength: 1 },
          slot: { enum: SLOTS },
        },
      },
    },
  },
};
