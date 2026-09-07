import { describe, expect, it } from "vitest";
import { AUTONOMY_POLICY, PROTOCOL_VERSION, ROSTER_RULES, SALARY_CAP, SCORING_SYSTEM } from "../../src/shared/contracts";
import { openApiDocument } from "../openapi";
import type { ChallengeRecord, RunRecord } from "../types";
import { challengeResponse } from "./challenges";

const run: RunRecord = {
  id: "run_test",
  challenge_id: "challenge_test",
  team_id: "team_test",
  nonce: "nonce_test",
  deadline_at: "2099-01-01T00:05:00Z",
  status: "delivered",
  first_delivered_at: "2099-01-01T00:00:00Z",
  accepted_at: null,
  accepted_lineup_hash: null,
};

const packet = {
  challengeId: "challenge_test",
  season: 2026,
  week: 1,
  releasedAt: "2099-01-01T00:00:00Z",
  deadlineAt: run.deadline_at,
  firstGameAt: "2099-01-01T01:00:00Z",
  salaryCap: SALARY_CAP,
  roster: ROSTER_RULES,
  scoringSystem: SCORING_SYSTEM,
  players: [],
  submissionSchema: {},
  generatedAt: "2099-01-01T00:00:00Z",
  contentHash: "content_hash",
};

const challenge: ChallengeRecord = {
  id: packet.challengeId,
  season: packet.season,
  week: packet.week,
  status: "open",
  protocol_version: PROTOCOL_VERSION,
  released_at: packet.releasedAt,
  deadline_at: packet.deadlineAt,
  first_game_at: packet.firstGameAt,
  salary_cap: SALARY_CAP,
  packet,
  content_hash: packet.contentHash,
  generated_at: packet.generatedAt,
};

describe("challenge protocol", () => {
  it("returns exact submission and status actions", () => {
    const response = challengeResponse("https://fantasy.example/", challenge, run);

    expect(response.message).toContain("Week 1 challenge retrieved");
    expect(response.available).toBe(true);
    expect(response.autonomyPolicy).toEqual(AUTONOMY_POLICY);
    expect(response.actions).toEqual({
      submitLineup: {
        method: "POST",
        url: "https://fantasy.example/api/runs/run_test/lineup",
        authorization: { scheme: "Bearer", credential: "apiKey" },
      },
      getStatus: {
        method: "GET",
        url: "https://fantasy.example/api/runs/run_test/status",
        authorization: { scheme: "Bearer", credential: "apiKey" },
      },
    });
  });

  it("publishes the weekly challenge and run routes", () => {
    const document = openApiDocument("https://fantasy.example") as { paths: Record<string, unknown> };

    expect(document.paths).toHaveProperty("/api/challenges/active");
    expect(document.paths).toHaveProperty("/api/challenges/test");
    expect(document.paths).toHaveProperty("/api/runs/{runId}/lineup");
    expect(document.paths).toHaveProperty("/api/runs/{runId}/status");
  });

  it("publishes the autonomy policy and attestation in OpenAPI", () => {
    const document = openApiDocument("https://fantasy.example") as {
      components: { schemas: Record<string, any> };
    };

    expect(document.components.schemas.AutonomyPolicy.properties.humanApprovalAllowed)
      .toEqual({ const: false });
    expect(document.components.schemas.Lineup.required).toContain("autonomyAttestation");
    expect(document.components.schemas.Signup.properties.x_handle).toMatchObject({
      type: "string",
      description: expect.stringContaining("Optional X.com handle"),
    });
  });

  it("uses the API key for lineup submissions", () => {
    const document = openApiDocument("https://fantasy.example") as {
      paths: Record<string, { post?: { security?: Array<Record<string, never[]>> } }>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(document.paths["/api/runs/{runId}/lineup"].post?.security).toEqual([{ ApiKey: [] }]);
    expect(document.components.securitySchemes).toEqual({
      ApiKey: { type: "http", scheme: "bearer", description: "API key returned by signup" },
    });
  });
});
