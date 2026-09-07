# Database schema

The application uses PostgreSQL. The canonical schema is defined by the ordered
SQL files in [`migrations`](migrations). Migrations are
applied by `scripts/migrate.ts`; the runner records each applied file and its
SHA-256 checksum in `schema_migrations`.

## Relationship overview

```text
teams ───────────────┬──────────────< runs >────────────── challenges
  │                  │                  │                     │
  │                  ├──────────────< lineups >───────────────┘
  │                  │                  │
  ├──────────────< scores              └──────────────< attempts
  │
  └──────────────< standings                         lineups >──< lineup_players

runs ──────────────< audit_events                 challenges >──< selections
```

`<` means “one-to-many.” A team can participate in many runs, lineups, scores,
and standings records. A challenge contains its immutable player pool, while a
team’s run records that team’s delivery and submission state for the challenge.

## Tables

### `teams`

Registered competitors.

- `id` — application-generated primary key.
- `team_name`, `email` — display and contact values.
- `x_handle` — optional normalized X.com handle shown in public standings.
- `normalized_name`, `normalized_email` — normalized values used for uniqueness.
- `api_key_hash` — unique hash of the team API key; the raw key is not stored.
- `created_at` — registration timestamp.

### `challenges`

One released fantasy contest packet for a season and week.

- `id` — primary key.
- `season`, `week` — contest period. For positive seasons, the pair is unique.
- `status` — `ready`, `open`, `closed`, or `final`.
- `protocol_version` — submission protocol version.
- `released_at`, `deadline_at`, `first_game_at` — release, submission cutoff,
  and first-game timestamps.
- `salary_cap` — integer salary limit.
- `packet` — JSONB packet containing the challenge’s published rules/data.
- `content_hash` — hash of the released content.
- `generated_at` — packet generation timestamp.

### `selections`

The player choices available in a challenge. This is a challenge-specific
snapshot, so later provider changes do not alter an already released packet.

- Composite primary key: `challenge_id`, `selection_id`.
- `challenge_id` references `challenges`.
- Player identity and presentation: `player_id`, optional `provider_player_id`,
  `name`, `nfl_team`, `opponent`, and `position`.
- Eligibility and pricing: `eligible_slots`, `price`, and `player_status`.
- `game_starts_at` — scheduled game time.

### `runs`

A team-specific delivery/submission session for a challenge.

- `id` — primary key.
- `challenge_id` and `team_id` reference `challenges` and `teams`.
- `nonce` — run-specific submission nonce.
- `deadline_at` — deadline captured for this run.
- `status` — `delivered`, `invalid`, `accepted`, or `expired`.
- `first_delivered_at`, optional `accepted_at` — lifecycle timestamps.
- `accepted_lineup_hash` — hash of the accepted lineup, when one exists.
- `(challenge_id, team_id)` is unique: a team gets at most one run per challenge.

### `attempts`

Every lineup submission received for a run, including invalid submissions.

- `id` — primary key.
- `run_id` references `runs`.
- `received_at`, `transport`, and `payload_hash` — receipt metadata.
- `status` — validation/processing result.
- `validation_errors` — JSONB list/object describing validation failures.

### `lineups`

The accepted lineup materialized from a run.

- `id` — primary key.
- `run_id` references `runs` and is unique, enforcing at most one accepted
  lineup per run.
- `team_id` and `challenge_id` reference the owning team and challenge.
- `season`, `week`, `total_cost`, `lineup_hash`, and `accepted_at` — public and
  integrity/scoring data captured at acceptance time.

### `lineup_players`

The selections and roster slots in a lineup.

- `lineup_id` references `lineups`.
- `selection_id`, `player_id`, and `slot` identify the selected player and the
  roster slot assigned to it.
- Composite primary key: `lineup_id`, `selection_id`.

There is intentionally no foreign key from `lineup_players.selection_id` to
`selections`: the application validates that the player belongs to the lineup’s
challenge before accepting it.

### `audit_events`

Append-only, hash-linked events for a run’s protocol history.

- `id` — primary key.
- `sequence` — globally generated, unique ordering value.
- `run_id` references `runs`.
- `event_type`, `occurred_at`, and `metadata` — event contents.
- `previous_hash` and `event_hash` — hash-chain integrity fields.

### `scores`

Weekly fantasy points for each team.

- `team_id` references `teams`.
- `season`, `week`, `points`, and `updated_at` — score data.
- Composite primary key: `team_id`, `season`, `week`.

### `standings`

Season-to-date leaderboard rows for each team.

- `team_id` references `teams`.
- `season`, `season_points`, `rank`, and `updated_at` — leaderboard data.
- Composite primary key: `team_id`, `season`.

## Delete behavior and important indexes

All declared foreign keys use `ON DELETE CASCADE`. Deleting a team or challenge
therefore removes its dependent runs and related records; deleting a run removes
its attempts, lineup, and audit events; deleting a lineup removes its lineup
players.

Indexes support challenge lookup by release/deadline window, selection lookup by
challenge/player, team run history, attempt history, audit history, and public
lineup listing by season/week/team. The partial unique index on
`challenges(season, week)` excludes non-positive seasons, allowing special or
local challenge records outside the normal season namespace.
