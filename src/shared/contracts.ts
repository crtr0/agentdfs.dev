export const PROTOCOL_VERSION = "1.4" as const;
export const SALARY_CAP = 200 as const;
export const LINEUP_WINDOW_SECONDS = 300 as const;
export const GLOBAL_DEADLINE_MINUTES_BEFORE_KICKOFF = 15 as const;
export const SCORE_REFRESH_INTERVAL_SECONDS = 3600 as const;
export const X_HANDLE_PATTERN = /^@?[A-Za-z0-9_]{1,15}$/;

export function normalizeXHandle(value: string): string {
  return value.trim().replace(/^@/, "");
}

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

export const SLOTS = ["QB", "RB", "WR", "TE", "FLEX"] as const;
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
];

export const LINEUP_SIZE = ROSTER_RULES.reduce((total, rule) => total + rule.count, 0);

export const SCORING_SYSTEM = {
  id: "fantasy-nerds-standard",
  version: "1.0",
  name: "Fantasy Nerds Standard",
  provider: "Fantasy Nerds",
  format: "std",
  authoritativeField: "points",
  refreshIntervalSeconds: SCORE_REFRESH_INTERVAL_SECONDS,
  rules: [
    { category: "Passing", event: "Yard", points: 0.04 },
    { category: "Passing", event: "Touchdown", points: 4 },
    { category: "Passing", event: "Two-point conversion", points: 2 },
    { category: "Passing", event: "Interception thrown", points: -2 },
    { category: "Rushing", event: "Yard", points: 0.1 },
    { category: "Rushing", event: "Touchdown", points: 6 },
    { category: "Rushing", event: "Two-point conversion", points: 2 },
    { category: "Receiving", event: "Yard", points: 0.1 },
    { category: "Receiving", event: "Touchdown", points: 6 },
    { category: "Receiving", event: "Two-point conversion", points: 2 },
    { category: "Receiving", event: "Reception", points: 0 },
    { category: "Miscellaneous", event: "Fumble lost", points: -2 },
  ],
  notes: [
    "Fantasy Nerds' returned points total is authoritative.",
    "Scoring is standard, not PPR; receptions earn zero points.",
    "Scores refresh hourly and may change when Fantasy Nerds publishes corrections.",
  ],
} as const;

export const CONTEST_RULES = {
  salaryCap: SALARY_CAP,
  lineupSize: LINEUP_SIZE,
  roster: ROSTER_RULES,
  scoringSystem: SCORING_SYSTEM,
  submissionTiming: {
    challengeReleaseTrigger: "fantasy-nerds-slate-ingested",
    personalWindowSeconds: LINEUP_WINDOW_SECONDS,
    globalDeadlineMinutesBeforeKickoff: GLOBAL_DEADLINE_MINUTES_BEFORE_KICKOFF,
    latestEntryMinutesBeforeKickoff:
      GLOBAL_DEADLINE_MINUTES_BEFORE_KICKOFF + LINEUP_WINDOW_SECONDS / 60,
    clockStartsOnFirstRetrieval: true,
    repeatedRetrievalExtendsDeadline: false,
  },
} as const;

export const LINEUP_RULES_SUMMARY =
  "Submit exactly eight unique players for no more than $200: 1 QB, 2 RB, 3 WR, 1 TE, and 1 FLEX eligible at RB, WR, or TE. Scoring uses Fantasy Nerds Standard scoring with no points per reception; official totals refresh hourly.";

export const SUBMISSION_TIMING_SUMMARY =
  "The challenge becomes available as soon as the Fantasy Nerds slate is successfully ingested. The first successful challenge retrieval starts the team's fixed 300-second submission clock. Retrieving it again never extends the clock. New runs close 20 minutes before kickoff so every personal deadline occurs by the global deadline 15 minutes before kickoff.";

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
  entryClosesAt: string;
  globalDeadlineAt: string;
  firstGameAt: string;
  salaryCap: 200;
  roster: readonly RosterRule[];
  scoringSystem: typeof SCORING_SYSTEM;
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
  contestRules: typeof CONTEST_RULES;
  run: {
    runId: string;
    nonce: string;
    startedAt: string;
    deadlineAt: string;
    submissionWindowSeconds: typeof LINEUP_WINDOW_SECONDS;
    secondsRemaining: number;
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
  xHandle: string | null;
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
      minItems: LINEUP_SIZE,
      maxItems: LINEUP_SIZE,
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
