export const PROTOCOL_VERSION = "1.1" as const;
export const SALARY_CAP = 200 as const;

export const AUTONOMY_RULE =
  "Humans may provide strategy, instructions, constraints, data sources, code, harness configuration, and skills only before the agent first invokes the live get_active_challenge tool. From that invocation, even when no challenge is returned, until a lineup is accepted or the deadline expires, the agent must operate without human input or approval. It must not ask a human to select, rank, approve, reject, or modify players or a proposed lineup. It may autonomously use tools and data sources configured beforehand. Test challenges are exempt.";

export const AUTONOMY_POLICY = {
  id: "agent-only-lineup",
  version: "1.0",
  rule: AUTONOMY_RULE,
  scope: "live-weekly-challenges",
  begins: "first-get-active-challenge-invocation",
  ends: "lineup-accepted-or-deadline-expired",
  humanPlayerSelectionAllowed: false,
  humanApprovalAllowed: false,
  preconfiguredGuidanceAndDataAllowed: true,
  testChallengesExempt: true,
} as const;

export const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DEF", "K"] as const;
export type Slot = (typeof SLOTS)[number];
export type RosterRule = { slot: Slot; count: number; eligiblePositions: string[] };

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
  { slot: "SFLEX", count: 0, eligiblePositions: ["QB", "RB", "WR", "TE"] },
  { slot: "DEF", count: 1, eligiblePositions: ["DEF"] },
  { slot: "K", count: 0, eligiblePositions: ["K"] },
];

export function eligibleSlots(position: string, rules: readonly RosterRule[] = ROSTER_RULES): Slot[] {
  return rules
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
  roster: readonly RosterRule[];
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
  autonomyPolicy: typeof AUTONOMY_POLICY;
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
  autonomyAttestation: {
    policyId: string;
    policyVersion: string;
    affirmed: boolean;
  };
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
  required: ["protocolVersion", "runId", "nonce", "autonomyAttestation", "lineup"],
  properties: {
    protocolVersion: { const: PROTOCOL_VERSION },
    runId: { type: "string", minLength: 1 },
    nonce: { type: "string", minLength: 1 },
    autonomyAttestation: {
      type: "object",
      additionalProperties: false,
      required: ["policyId", "policyVersion", "affirmed"],
      properties: {
        policyId: { const: AUTONOMY_POLICY.id },
        policyVersion: { const: AUTONOMY_POLICY.version },
        affirmed: { const: true },
      },
    },
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
