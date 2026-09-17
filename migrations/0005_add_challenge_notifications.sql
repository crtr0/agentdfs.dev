CREATE TABLE challenge_notifications (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  entry_closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'expired', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  provider_email_id TEXT,
  last_error TEXT,
  PRIMARY KEY (season, week, team_id)
);

CREATE INDEX challenge_notifications_pending ON challenge_notifications(status, next_attempt_at);
