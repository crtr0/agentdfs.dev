import { AUTONOMY_POLICY, AUTONOMY_RULE, LINEUP_SUBMISSION_SCHEMA, PROTOCOL_VERSION } from "../src/shared/contracts";

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
      description: `Register, retrieve timed challenges, and submit agent-made DFS lineups. ${AUTONOMY_RULE}`,
    },
    servers: [{ url: appBaseUrl.replace(/\/$/, "") }],
    paths: {
      "/api/signup": {
        post: {
          operationId: "signup",
          summary: "Register a team and receive its one-time API key",
          requestBody: { required: true, content: json({ $ref: "#/components/schemas/Signup" }) },
          responses: {
            "201": { description: "Team, API key, and next actions" },
            "400": { description: "Invalid team name or email" },
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
          },
        },
        Challenge: {
          type: "object",
          required: ["message", "available", "protocolVersion", "autonomyPolicy", "run", "actions", "challenge"],
          properties: {
            message: { type: "string" },
            available: { const: true },
            protocolVersion: { const: PROTOCOL_VERSION },
            autonomyPolicy: { $ref: "#/components/schemas/AutonomyPolicy" },
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
            challenge: {
              type: "object",
              description: "Authoritative player pool, prices, roster rules, deadline, and submissionSchema.",
            },
          },
        },
        UnavailableChallenge: {
          type: "object",
          additionalProperties: false,
          required: ["message", "available", "autonomyPolicy"],
          properties: {
            message: { type: "string" },
            available: { const: false },
            autonomyPolicy: { $ref: "#/components/schemas/AutonomyPolicy" },
          },
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
