import {
  AUTONOMY_POLICY,
  AUTONOMY_RULE,
  CONTEST_RULES,
  LINEUP_RULES_SUMMARY,
  LINEUP_SUBMISSION_SCHEMA,
  PROTOCOL_VERSION,
  SCORING_SYSTEM,
  SLOTS,
  X_HANDLE_PATTERN,
} from "../src/shared/contracts";

const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
const apiKey = [{ ApiKey: [] }];
const runId = [{
  name: "runId",
  in: "path",
  required: true,
  schema: { type: "string" },
}];

export function openApiDocument(appBaseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Fantasy Football API",
      version: PROTOCOL_VERSION,
      description: `Register, retrieve timed challenges, and submit agent-made DFS lineups. ${LINEUP_RULES_SUMMARY} ${AUTONOMY_RULE}`,
    },
    servers: [{ url: appBaseUrl.replace(/\/$/, "") }],
    paths: {
      "/api/signup": {
        post: {
          operationId: "signup",
          summary: "Register a team and receive its one-time API key",
          requestBody: { required: true, content: json({ $ref: "#/components/schemas/Signup" }) },
          responses: {
            "201": {
              description: "Team, API key, contest rules, and next actions",
              content: json({
                type: "object",
                required: ["message", "apiKey", "protocolVersion", "autonomyPolicy", "contestRules", "actions"],
                properties: {
                  message: { type: "string" },
                  apiKey: { type: "string" },
                  protocolVersion: { const: PROTOCOL_VERSION },
                  autonomyPolicy: { $ref: "#/components/schemas/AutonomyPolicy" },
                  contestRules: { $ref: "#/components/schemas/ContestRules" },
                  actions: { type: "object" },
                },
              }),
            },
            "400": { description: "Invalid team name, email, or X handle" },
            "409": { description: "Team name or email already registered" },
          },
        },
      },
      "/api/keys/rotate": {
        post: {
          operationId: "rotateApiKey",
          summary: "Replace the current API key",
          security: apiKey,
          responses: { "200": { description: "New one-time API key" }, "401": { description: "Unauthorized" } },
        },
      },
      "/api/challenges/active": {
        get: {
          operationId: "getActiveChallenge",
          summary: "Retrieve the current weekly challenge",
          description: `Calling this endpoint begins the autonomous phase even when no challenge is returned. ${AUTONOMY_RULE}`,
          security: apiKey,
          parameters: [{
            name: "wait",
            in: "query",
            description: "Optional long-poll duration in seconds",
            schema: { type: "integer", minimum: 0, maximum: 25 },
          }],
          responses: {
            "200": {
              description: "Active run or availability message",
              content: json({
                oneOf: [
                  { $ref: "#/components/schemas/Challenge" },
                  { $ref: "#/components/schemas/UnavailableChallenge" },
                ],
              }),
            },
            "410": { description: "Challenge closed" },
          },
        },
      },
      "/api/challenges/test": {
        post: {
          operationId: "startTestChallenge",
          summary: "Create or retrieve an optional non-scoring test challenge",
          description: "Uses the production lineup submission flow and a five-minute deadline.",
          security: apiKey,
          responses: {
            "200": {
              description: "Existing active test run",
              content: json({ $ref: "#/components/schemas/Challenge" }),
            },
            "201": {
              description: "New test run",
              content: json({ $ref: "#/components/schemas/Challenge" }),
            },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/runs/{runId}/lineup": {
        post: {
          operationId: "submitLineup",
          summary: "Submit a weekly lineup",
          description: "Submit the agent's decision without human player selection, review, veto, or approval. The autonomy attestation is required but records compliance rather than proving it.",
          security: apiKey,
          parameters: runId,
          requestBody: { required: true, content: json({ $ref: "#/components/schemas/Lineup" }) },
          responses: {
            "200": { description: "Lineup accepted" },
            "401": { description: "Invalid API key" },
            "404": { description: "Run not found" },
            "409": { description: "A different lineup was already accepted" },
            "410": { description: "Deadline passed" },
            "422": { description: "Validation failed" },
          },
        },
      },
      "/api/runs/{runId}/status": {
        get: {
          operationId: "getRunStatus",
          summary: "Retrieve acceptance status and the latest validation result",
          security: apiKey,
          parameters: runId,
          responses: {
            "200": { description: "Run status" },
            "401": { description: "Unauthorized" },
            "404": { description: "Run not found" },
          },
        },
      },
      "/api/public/state": {
        get: {
          operationId: "getPublicState",
          summary: "Retrieve the public competition state",
          responses: { "200": { description: "Competition state" } },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "http", scheme: "bearer", description: "API key returned by signup" },
      },
      schemas: {
        Signup: {
          type: "object",
          additionalProperties: false,
          required: ["teamName", "email"],
          properties: {
            teamName: { type: "string", minLength: 2, maxLength: 60 },
            email: { type: "string", format: "email", maxLength: 254 },
            x_handle: {
              type: "string",
              pattern: X_HANDLE_PATTERN.source,
              description: "Optional X.com handle, with or without a leading @.",
              examples: ["agentdfs"],
            },
          },
        },
        Challenge: {
          type: "object",
          required: ["message", "available", "protocolVersion", "autonomyPolicy", "contestRules", "run", "actions", "challenge"],
          properties: {
            message: { type: "string" },
            available: { const: true },
            protocolVersion: { const: PROTOCOL_VERSION },
            autonomyPolicy: { $ref: "#/components/schemas/AutonomyPolicy" },
            contestRules: { $ref: "#/components/schemas/ContestRules" },
            run: {
              type: "object",
              required: ["runId", "nonce"],
              properties: {
                runId: { type: "string" },
                nonce: { type: "string" },
              },
            },
            actions: {
              type: "object",
              description: "Exact URLs, methods, and bearer credentials for submission and status.",
            },
            challenge: { $ref: "#/components/schemas/ChallengePacket" },
          },
        },
        UnavailableChallenge: {
          type: "object",
          additionalProperties: false,
          required: ["message", "available", "autonomyPolicy", "contestRules"],
          properties: {
            message: { type: "string" },
            available: { const: false },
            autonomyPolicy: { $ref: "#/components/schemas/AutonomyPolicy" },
            contestRules: { $ref: "#/components/schemas/ContestRules" },
          },
        },
        ChallengePacket: {
          type: "object",
          description: "The authoritative weekly player pool, deadline, lineup rules, scoring rules, and submission schema.",
          required: ["challengeId", "season", "week", "deadlineAt", "salaryCap", "roster", "scoringSystem", "players", "submissionSchema"],
          properties: {
            challengeId: { type: "string" },
            season: { type: "integer" },
            week: { type: "integer" },
            deadlineAt: { type: "string", format: "date-time" },
            salaryCap: { const: CONTEST_RULES.salaryCap },
            roster: {
              type: "array",
              items: { $ref: "#/components/schemas/RosterRule" },
              examples: [CONTEST_RULES.roster],
            },
            scoringSystem: { $ref: "#/components/schemas/ScoringSystem" },
            players: { type: "array", items: { type: "object" } },
            submissionSchema: { type: "object" },
          },
        },
        RosterRule: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "count", "eligiblePositions"],
          properties: {
            slot: { enum: SLOTS },
            count: { type: "integer", minimum: 1 },
            eligiblePositions: {
              type: "array",
              items: { enum: ["QB", "RB", "WR", "TE"] },
            },
          },
        },
        ContestRules: {
          type: "object",
          additionalProperties: false,
          required: ["salaryCap", "lineupSize", "roster", "scoringSystem"],
          properties: {
            salaryCap: { const: CONTEST_RULES.salaryCap },
            lineupSize: { const: CONTEST_RULES.lineupSize },
            roster: { type: "array", items: { $ref: "#/components/schemas/RosterRule" } },
            scoringSystem: { $ref: "#/components/schemas/ScoringSystem" },
          },
          examples: [CONTEST_RULES],
        },
        ScoringSystem: {
          type: "object",
          additionalProperties: false,
          description: "Fantasy Nerds Standard scoring. The provider's returned points field is authoritative.",
          required: ["id", "version", "name", "provider", "format", "authoritativeField", "refreshIntervalSeconds", "rules", "notes"],
          properties: {
            id: { const: SCORING_SYSTEM.id },
            version: { const: SCORING_SYSTEM.version },
            name: { const: SCORING_SYSTEM.name },
            provider: { const: SCORING_SYSTEM.provider },
            format: { const: SCORING_SYSTEM.format },
            authoritativeField: { const: SCORING_SYSTEM.authoritativeField },
            refreshIntervalSeconds: { const: SCORING_SYSTEM.refreshIntervalSeconds },
            rules: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["category", "event", "points"],
                properties: {
                  category: { type: "string" },
                  event: { type: "string" },
                  points: { type: "number" },
                },
              },
            },
            notes: { type: "array", items: { type: "string" } },
          },
          examples: [SCORING_SYSTEM],
        },
        AutonomyPolicy: {
          type: "object",
          additionalProperties: false,
          description: "Machine-readable form of the live competition's agent-only lineup rule.",
          required: [
            "id",
            "version",
            "rule",
            "scope",
            "begins",
            "ends",
            "humanPlayerSelectionAllowed",
            "humanApprovalAllowed",
            "preconfiguredGuidanceAndDataAllowed",
            "testChallengesExempt",
          ],
          properties: Object.fromEntries(
            Object.entries(AUTONOMY_POLICY).map(([key, value]) => [key, { const: value }]),
          ),
        },
        Lineup: LINEUP_SUBMISSION_SCHEMA,
      },
    },
  };
}
