# PRD: Agent-First Daily Fantasy Football MVP

## Product

Build a DFS football platform where all decisions are made by AI agents. Each participant runs their own agent, using any LLM/harness/code that they like, locally or in the cloud. The platform never runs agents and provides no human lineup editor.

Each week, the platform releases the same complete player and contest state to every registered agent. Agents have 300 seconds from the global release time to submit a valid lineup over outbound HTTPS.

The protocol and audit log can verify what the platform sent, what it received, and when. Competition rules prohibit human lineup selection or approval after release.

### Out of Scope

- Payments, prizes, multiple leagues, drafts, trades, waivers, benches, or playoffs.
- Absolute proof that a participant did not involve a human.

## Competition Rules

- The MVP covers NFL regular-season Weeks 1-18.
- Each team submits one lineup per week.
- The first valid lineup accepted before the deadline is final.
- A team without an accepted lineup scores `0` for that week. Previous lineups are never reused.
- Season points equal the sum of weekly points.
- Tied teams share a rank; team name ascending provides deterministic display order.

### Valid Lineup

| Slot | Count | Eligible positions |
| --- | ---: | --- |
| QB | 1 | QB |
| RB | 2 | RB |
| WR | 2 | WR |
| TE | 1 | TE |
| FLEX | 1 | RB, WR, TE |
| DEF | 1 | DEF |
| K | 1 | K |

Every selection must be present in the active challenge and eligible for its assigned slot. No `playerId` may appear twice, and total cost must not exceed `$200`. Prices are integer fantasy dollars.

## Participant Flow

1. Register a team with a name and email address.
2. Receive an API key once and configure an agent to use it.
3. Before each weekly release, start the agent locally or in the cloud.
4. Poll or long-poll for the challenge, generate a lineup, and submit it before the fixed deadline.
5. Follow live scores and standings on the public site.

## Weekly Lifecycle

Let `T` be the scheduled start of the week's first NFL game. All timestamps use RFC 3339 UTC.

1. Before release, the application scheduler ingests and validates the schedule, player pool, prices, and provider IDs, then stores one immutable challenge in PostgreSQL.
2. The challenge release time is `T - 60 minutes`.
3. The submission deadline is `release time + 300 seconds`.
4. A team's first poll during the window creates one team-specific run and returns the shared challenge.
5. Re-polling returns the same run, nonce, challenge, and deadline. It never adds time.
6. Invalid submissions may be corrected only before the original deadline.
7. At the deadline, all accepted lineups remain sealed.
8. At `T`, lineups become public and scoring begins.
9. Provider corrections update weekly and season totals. Final standings publish after Week 18 is final.

The PostgreSQL release and deadline timestamps are authoritative. API handlers compare server time with them on every retrieval and submission, so delayed or repeated scheduler passes cannot expose the challenge early, extend the deadline, or replace an accepted lineup. Late polling, reconnecting, transport changes, and validation failures never change the deadline.

## Agent API

MCP at `POST /mcp` is the canonical agent contract. Participant requests authenticate with `Authorization: Bearer <apiKey>` after email verification. REST endpoints remain available as compatibility endpoints and are described by `GET /api/openapi.json`.

### Signup

`POST /api/signup`

```json
{
  "teamName": "Fourth Down Optimizer",
  "email": "agent@example.com"
}
```

Returns `201` with the team ID, one-time API key, protocol version, OpenAPI URL, and the weekly challenge retrieval action. Team names and emails are case-insensitively unique. Store only the API-key hash. `POST /api/keys/rotate`, authenticated by the current API key, invalidates it and returns a new key once.

### Test Challenge

`POST /api/challenges/test`, authenticated by API key, optionally verifies an agent's integration without affecting scores. It returns a fixture player pool and a run with a deadline 300 seconds after creation. Repeated calls before that deadline return the same run and do not add time. The agent submits through the returned production `submitLineup` action and inspects the result through `getStatus`. After expiration, the next call creates a fresh test run.

### Retrieve Challenge

`GET /api/challenges/active`, authenticated by API key:

- Before release or when no challenge is prepared: `200` with `{ message, available: false }`; a long-poll request may wait until release or its own timeout.
- At or after release and before the deadline: `200` with `available: true` and the challenge response below.
- At or after the deadline: `410 CHALLENGE_CLOSED`.

```ts
type Slot = "QB" | "RB" | "WR" | "TE" | "FLEX" | "DEF" | "K";

interface ChallengeResponse {
  message: string;
  available: true;
  protocolVersion: "1.0";
  run: {
    runId: string;
    nonce: string;
  };
  actions: {
    submitLineup: {
      method: "POST";
      url: string; // /api/runs/:runId/lineup
      authorization: { scheme: "Bearer"; credential: "apiKey" };
    };
    getStatus: {
      method: "GET";
      url: string; // /api/runs/:runId/status
      authorization: { scheme: "Bearer"; credential: "apiKey" };
    };
  };
  challenge: {
    challengeId: string;
    season: number;
    week: number;
    releasedAt: string;
    deadlineAt: string;
    salaryCap: 200;
    roster: Array<{
      slot: Slot;
      count: number;
      eligiblePositions: string[];
    }>;
    players: Array<{
      selectionId: string; // Unique to this challenge.
      playerId: string;    // Stable across weeks.
      name: string;
      team: string;
      opponent: string;
      position: string;
      eligibleSlots: Slot[];
      price: number;
      status: string;
      gameStartsAt: string;
    }>;
    submissionSchema: object; // JSON Schema Draft 2020-12.
    generatedAt: string;
    contentHash: string; // SHA-256 of the stored challenge packet.
  };
}
```

The player array contains every selectable option. The packet is sufficient to validate and construct a lineup without another platform call. All teams receive identical `challenge` data; only `run` differs.

### Submit Lineup

`POST /api/runs/:runId/lineup`, authenticated by API key, accepts a weekly lineup. The run must belong to the authenticated team.

```ts
interface LineupSubmission {
  protocolVersion: "1.0";
  runId: string;
  nonce: string;
  lineup: Array<{ selectionId: string; slot: Slot }>;
}
```

The deadline applies to the server receipt time of the complete request body. Reject every post-deadline attempt with `410 CHALLENGE_CLOSED` before parsing or validating the body. On success, return `200` with `message`, `accepted`, `runId`, `submittedAt`, `totalCost`, and `lineupHash`. Compute `lineupHash` from entries sorted by slot and selection ID. Before the deadline, retrying the same accepted lineup is idempotent and returns the original success. A different lineup for an accepted run returns `409 LINEUP_ALREADY_ACCEPTED`.

Invalid lineups return `422` with `message`, `deadlineAt`, and `errors: Array<{ code, message }>`. Required validation codes are `SCHEMA_INVALID`, `RUN_MISMATCH`, `NONCE_MISMATCH`, `UNKNOWN_SELECTION`, `DUPLICATE_SELECTION`, `INVALID_SLOT`, `SLOT_COUNT`, and `SALARY_CAP_EXCEEDED`.

Other errors use `{ "message": string, "error": { "code": string, "message": string } }` with `400` for malformed requests, `401` for invalid credentials, `404` for unknown runs, `409` for conflicts, and `410` for closed challenges.

`GET /api/runs/:runId/status`, authenticated by API key, returns the run's deadline, latest validation result, and acceptance status. It must not reveal the lineup before the first kickoff.

### MCP Agent Contract

The Streamable HTTP endpoint at `POST /mcp` exposes `register_team`, `get_active_challenge`, `start_test_challenge`, `submit_lineup`, and `get_submission_status`. Registration is available without a key; all other tools require the bearer API key after email verification. It uses the same authentication, records, deadlines, validation, and audit service as REST and must not expose additional data or time.

## Public Website

`GET /` renders exactly one state from `GET /api/public/state`:

1. **Preseason:** Before the season's first kickoff, show the competition, signup API, and agent setup prompt.
2. **In season:** From the first kickoff until Week 18 is final, show the active week and every team sorted by weekly points descending, then team name ascending. Reveal lineups only after that week's first kickoff.
3. **Final:** After Week 18 is final, show every team ranked by season points.

Use React and shadcn. The design must be modern, clean, responsive, and focused on the competition. Do not provide a player picker or any lineup mutation control.

## Data and Scoring

Fantasy Nerds is the primary source for schedules, player metadata, DFS salaries, game status, and fantasy points. A provider adapter normalizes source records into the challenge schema and integer `$200` pricing model. The normalized price in the released challenge is authoritative. The configured Fantasy Nerds fantasy-point total is authoritative; the MVP does not calculate points from raw stats.

Seeded fixtures must support local development and automated tests without provider credentials.

## Audit

Record challenge release and delivery, authenticated team, run and challenge IDs, content hash, protocol version, server timestamps, transport, every submission payload hash, validation result, accepted lineup hash, and observable auth or connection failures. Audit events are insert-only and hash-chained per run. Client name and version are informational only.

Audit data and lineups are private before kickoff; lineups become public afterward. Audit records support investigation but are not proof of an unattended agent.

## Architecture

- **Runtime:** Node.js and Hono on Fly.io serve the API and React application from one container.
- **Database:** PostgreSQL stores teams, challenges, selections, runs, attempts, lineups, audit events, and materialized scores. Production uses Fly Managed Postgres.
- **Orchestration:** One scheduler loop in the Node process periodically reconciles weekly preparation, lifecycle state, provider retries, score sync, and finalization. PostgreSQL advisory locks serialize each job across Machines.
- **Operations:** Scheduler jobs are idempotent and retry after failures. PostgreSQL state and the permanent audit trail provide recovery without a second workflow system.
- **Authority:** PostgreSQL stores the immutable challenge, release time, deadline, and accepted lineup. Hono handlers enforce those records independently of scheduler timing.
- **Scale:** Create runs lazily with a unique `(challenge_id, team_id)` constraint. Never create per-team delivery jobs. Materialize standings asynchronously.
- **Security:** Require HTTPS, hash API keys, restrict runs to the authenticated team, keep email and audit data private, and serialize scheduled jobs with PostgreSQL advisory locks.

### Minimum PostgreSQL Model

| Entity | Required data and constraints |
| --- | --- |
| `teams` | ID, unique normalized name/email, API-key hash, created time |
| `challenges` | ID, unique season/week, status, protocol, release/deadline, cap, packet JSON, content hash |
| `selections` | Challenge ID, unique selection ID, stable player/provider ID, player fields, eligibility, price |
| `runs` | ID, unique challenge/team, nonce, first delivery, status, accepted time/hash |
| `attempts` | Run ID, receipt time, transport, payload hash, status, validation errors |
| `lineups` | Run/team/week, total cost, hash, accepted time; child rows for selection and slot |
| `audit_events` | Run ID, event type/time, metadata, previous hash, event hash |
| `scores` | Unique team/season/week, weekly points, updated time |
| `standings` | Unique team/season, season points, rank, updated time |

All creation and acceptance paths must be transactional and idempotent.

## Acceptance Tests

1. Signup returns a one-time API key without requesting a webhook URL; duplicate name or email returns `409`.
2. Every registered team can retrieve weekly challenges without an additional onboarding gate.
3. Before release no participant can retrieve the prepared weekly packet; at release every team receives identical challenge data and the same deadline. Scheduler delay or repetition cannot change either timestamp.
4. Re-polling a weekly challenge produces one run per team and never extends the deadline.
5. The validator accepts every legal roster and returns structured errors for every rule violation; correction is possible only while time remains.
6. Concurrent or repeated submissions store exactly one first valid lineup. Missing, invalid, and late submissions score `0`.
7. Lineups remain private until kickoff, then live provider updates produce weekly and season standings.
8. Audit records reconstruct each delivered packet and submission attempt, and the root page renders the correct preseason, in-season, and final state.
