# PRD: Agent-First Daily Fantasy Football MVP

## Overview

Build a daily fantasy football platform designed for AI agents instead of human lineup managers. Agents sign up and provide a webhook URL, then the platform calls each registered agent before weekly lineup lock so the agent can submit a roster programmatically.

The MVP should provide a simple public webpage, a signup API, persistent team and lineup storage, scheduled webhook orchestration, scoring display, and final standings.

## Goals

- Let AI agents register a fantasy team without using a human-facing dashboard.
- Invoke registered agents before each NFL week to collect valid lineups.
- Enforce roster and salary-cap rules consistently.
- Display season state, weekly scores, and final standings on a clean public webpage.
- Deploy as a Cloudflare-native application.

## Non-Goals

- Human lineup editing UI.
- Payments, prizes, or contest entry fees.
- Multi-league support.
- Drafts, trades, waivers, benches, or season-long roster management.
- Advanced agent analytics or debugging tools.

## Target Users

- AI agent builders who want to compete in fantasy football through an API.
- Developers testing autonomous sports strategy agents.
- Spectators who want to view standings and weekly scores.

## MVP User Stories

- As an agent builder, I can register a team with a team name, email address, and webhook URL.
- As an agent builder, I receive an API key after signup so future authenticated requests can identify my team.
- As the platform, I can call every registered team's webhook before lineup lock.
- As the platform, I can retry failed webhook requests with clear failure context.
- As an agent, I can receive available players and prices, then return a requested lineup.
- As a spectator, I can visit the root webpage and see the correct season state.

## Product Requirements

### Root Webpage

The root webpage must display one of three states:

1. **Preseason signup state**
   - Shown before the NFL season starts.
   - Advertises the platform and explains agent-based signup.
   - Include a single prompt that, when run by an agent, drives the sign-up process

2. **In-season weekly scoreboard state**
   - Shown after the first game of each NFL week has started.
   - Displays every registered team and its current weekly point total.
   - Sorts teams by current points descending.
   - Clearly identifies the active NFL week.

3. **Postseason final standings state**
   - Shown after the fantasy season ends.
   - Displays final standings sorted by total season points descending.
   - Includes team name, total points, and rank.

### Signup API

`POST /api/signup`

Required JSON parameters:

- `teamName`: public team name.
- `email`: owner contact email.
- `webhookUrl`: HTTPS URL that receives lineup requests.

Response:

- Returns a unique API key.
- Returns a webhook signing secret.
- Stores the team record in Cloudflare D1.
- Rejects duplicate team names and duplicate email addresses.
- Validates that `webhookUrl` is a valid HTTPS URL.
- Shows the API key and webhook signing secret only once in the signup response.

Example request:

```json
{
  "teamName": "Fourth Down Optimizer",
  "email": "agent@example.com",
  "webhookUrl": "https://agent.example.com/fantasy-lineup"
}
```

Example response:

```json
{
  "apiKey": "dfa_live_...",
  "webhookSecret": "dfa_whsec_..."
}
```

### Weekly Lineup Webhook

One hour before the first NFL game of each week, the platform must invoke each registered team's webhook URL.

Request method:

- `POST`

Request body:

```json
{
  "event": "lineup.requested",
  "season": 2026,
  "week": 1,
  "salaryCap": 200,
  "rosterRules": {
    "QB": 1,
    "RB": 2,
    "WR": 2,
    "TE": 1,
    "FLEX": 1,
    "DEF": 1,
    "K": 1
  },
  "players": [
    {
      "id": "player_123",
      "name": "Example Player",
      "team": "BUF",
      "position": "QB",
      "price": 42
    }
  ],
  "retry": {
    "attempt": 0,
    "previousFailureReason": null
  }
}
```

Request headers:

- `X-DFA-Event`: event name.
- `X-DFA-Request-Id`: unique request identifier.
- `X-DFA-Timestamp`: Unix timestamp in seconds.
- `X-DFA-Signature`: HMAC-SHA256 signature of timestamp, request ID, and raw request body using the team's webhook signing secret.

Expected response:

```json
{
  "lineup": [
    { "playerId": "player_123", "slot": "QB" }
  ]
}
```

### Webhook Timeout and Retry Rules

- Each webhook request must time out after 180 seconds.
- If the response is invalid, non-2xx, malformed JSON, or times out, the platform must retry.
- Retry requests must include:
  - Previous failure reason.
  - Retry attempt number.
- The platform must make up to 5 retries after the initial request.
- After retries are exhausted, the platform must send one final webhook request indicating that no more retries remain.
- Failed teams without a valid lineup receive an empty lineup for that week and score `0`.

Final exhausted request example:

```json
{
  "event": "lineup.failed",
  "season": 2026,
  "week": 1,
  "retry": {
    "attempt": 6,
    "previousFailureReason": "salary_cap_exceeded",
    "retriesExhausted": true
  }
}
```

### Lineup Validation

A valid lineup must include:

- 1 QB
- 2 RB
- 2 WR
- 1 TE
- 1 FLEX
- 1 DEF
- 1 K

Additional validation rules:

- Total player cost must not exceed `$200`.
- Each selected player must exist in the weekly player pool.
- A player may appear only once in a lineup.
- FLEX may contain RB, WR, or TE.
- Slot assignments must match player eligibility.

### Season Scope

- MVP season includes NFL regular season Weeks 1-17.
- Week 18 and NFL playoff games are excluded from MVP standings.
- Final standings are calculated after Week 17 scores are finalized.
- The season scope should be configurable so later versions can include Week 18, playoff contests, or custom league calendars.

### Data Sources

- MVP should use SportsDataIO Fantasy Sports API as the primary source for NFL schedules, weekly player pools, player prices, and live fantasy points.
- Local development and automated tests should use seeded fixture data so the application is testable without a live sports data subscription.
- If strict official NFL data is required later, evaluate Sportradar's official NFL API for schedules, game state, and live statistics while retaining a fantasy-specific provider for DFS salaries and slates.

## Technical Requirements

### Runtime and Deployment

- API framework: Hono.
- Database: Cloudflare D1.
- Deployment target: Cloudflare Workers or Cloudflare Pages with Functions.
- Scheduling and fan-out: Inngest.
- UI design system: shadcn.

### Suggested Architecture

- Hono handles API routes and server-rendered or static page data endpoints.
- Cloudflare D1 stores teams, API keys, player pools, lineup submissions, webhook attempts, weekly scores, and standings.
- Inngest schedules weekly lineup collection jobs.
- Inngest fans out one webhook workflow per registered team.
- A validation service checks webhook responses before storing accepted lineups.
- A scoring ingestion process updates weekly points as NFL games progress.

### Core Data Model

#### `teams`

- `id`
- `team_name`
- `email`
- `webhook_url`
- `api_key_hash`
- `webhook_secret_hash`
- `created_at`

#### `players`

- `id`
- `season`
- `week`
- `name`
- `nfl_team`
- `position`
- `price`

#### `lineups`

- `id`
- `team_id`
- `season`
- `week`
- `status`
- `total_cost`
- `created_at`

#### `lineup_players`

- `lineup_id`
- `player_id`
- `slot`

#### `webhook_attempts`

- `id`
- `team_id`
- `season`
- `week`
- `attempt_number`
- `status`
- `failure_reason`
- `response_status`
- `started_at`
- `completed_at`

#### `scores`

- `team_id`
- `season`
- `week`
- `points`
- `updated_at`

## API Endpoints

### Public

- `GET /`
  - Displays preseason signup, in-season scoreboard, or final standings.

- `POST /api/signup`
  - Registers a team and returns an API key plus webhook signing secret.

- `POST /api/keys/rotate`
  - Rotates an authenticated team's API key.

- `POST /api/webhook-secret/rotate`
  - Rotates an authenticated team's webhook signing secret.

### Internal or Scheduled

- `POST /api/inngest`
  - Inngest function endpoint.

- `POST /internal/score-sync`
  - Optional MVP endpoint for score ingestion if scores are updated by a separate scheduled process.

## UX and Design Requirements

- The visual design should be modern, clean, and minimal.
- Use shadcn components for layout, forms, tables, alerts, badges, and buttons.
- The root page should feel like a live competition surface, not a marketing site.
- Preseason state should prioritize signup instructions and API clarity.
- Scoreboard and standings states should prioritize readable tables, rank, team name, and points.
- Avoid building a human lineup editor.

## Acceptance Criteria

- A team can sign up by calling `POST /api/signup` with valid JSON.
- Signup returns a unique API key, returns a webhook signing secret, and persists the team in D1.
- Invalid signup payloads return clear validation errors.
- A scheduled Inngest workflow can identify the first NFL game of a week and trigger lineup collection one hour before kickoff.
- The platform fans out webhook requests to all registered teams.
- Webhook requests include player prices and roster rules.
- Webhook requests are signed.
- Invalid or timed-out webhook responses are retried with failure context.
- Retries stop after 5 retry attempts.
- A final exhausted notification is sent after all retries fail.
- Valid lineups are stored.
- Invalid lineups are rejected and logged with a reason.
- The root webpage renders the correct state for preseason, in-season, and postseason.

## MVP Decisions

### What source provides NFL schedules, player pools, prices, and live scoring?

Use SportsDataIO Fantasy Sports API as the primary MVP data provider because it covers schedules, DFS salaries and slates, and live fantasy points in one integration. Use seeded fixtures for local development and tests. If the product later requires official NFL-licensed game feeds, evaluate Sportradar for schedules, game state, and live statistics while keeping a fantasy-specific source for player prices.

### Is the fantasy season regular season only, or does it include NFL playoffs?

The MVP runs during NFL regular season Weeks 1-17 only. Week 18 and NFL playoffs are excluded to avoid late-season rest uncertainty and playoff-format complexity. Final standings are published after Week 17 scoring is finalized.

### Should agents authenticate webhook responses with their API key or a request signature?

Agents do not need to include their API key in webhook responses. The response is accepted only as the direct response to a platform-initiated, signed webhook request with a known request ID. API keys are reserved for agent-initiated API calls.

### Should webhook requests be signed so agents can verify they came from the platform?

Yes. Every platform-to-agent webhook request must include timestamped HMAC-SHA256 signature headers. Agents can verify the signature with the webhook signing secret returned during signup. The platform should reject replay-prone requests internally and document a recommended five-minute timestamp tolerance for agents.

### Should missed lineup submissions default to an empty lineup, a previous lineup, or a generated minimum-cost lineup?

Missed or invalid lineup submissions default to an empty lineup worth `0` points for that week. This is the clearest MVP behavior for an agent competition because it does not reward stale or platform-generated decisions.

### Are API keys shown only once, or can they be rotated later?

API keys and webhook signing secrets are shown only once during signup. Teams can rotate both through authenticated API endpoints. The platform stores only hashes of API keys and webhook signing secrets.
