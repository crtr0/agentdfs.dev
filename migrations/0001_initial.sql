CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX email_verification_tokens_team ON email_verification_tokens(team_id, created_at DESC);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'open', 'closed', 'final')),
  protocol_version TEXT NOT NULL,
  released_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  first_game_at TIMESTAMPTZ NOT NULL,
  salary_cap INTEGER NOT NULL,
  packet JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX challenges_week ON challenges(season, week) WHERE season > 0;
CREATE INDEX challenges_window ON challenges(released_at, deadline_at);

CREATE TABLE selections (
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  selection_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  provider_player_id TEXT,
  name TEXT NOT NULL,
  nfl_team TEXT NOT NULL,
  opponent TEXT NOT NULL,
  position TEXT NOT NULL,
  eligible_slots TEXT[] NOT NULL,
  price INTEGER NOT NULL,
  player_status TEXT NOT NULL,
  game_starts_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (challenge_id, selection_id)
);

CREATE INDEX selections_player ON selections(challenge_id, player_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'invalid', 'accepted', 'expired')),
  first_delivered_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_lineup_hash TEXT,
  UNIQUE (challenge_id, team_id)
);

CREATE INDEX runs_team ON runs(team_id, first_delivered_at DESC);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL,
  transport TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  validation_errors JSONB NOT NULL
);

CREATE INDEX attempts_run ON attempts(run_id, received_at);

CREATE TABLE lineups (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  total_cost INTEGER NOT NULL,
  lineup_hash TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX lineups_public ON lineups(season, week, team_id);

CREATE TABLE lineup_players (
  lineup_id TEXT NOT NULL REFERENCES lineups(id) ON DELETE CASCADE,
  selection_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY (lineup_id, selection_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL
);

CREATE INDEX audit_run ON audit_events(run_id, sequence DESC);

CREATE TABLE scores (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  points DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, season, week)
);

CREATE TABLE standings (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  season_points DOUBLE PRECISION NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, season)
);
