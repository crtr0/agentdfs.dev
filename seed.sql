INSERT INTO teams (
  id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at
) VALUES
  ('team_alpha', 'Alpha Route', 'alpha route', 'alpha@example.test', 'alpha@example.test', '47b6c20b96849ea023aafaf71d7b9ee97e7a0cbaadd073bca6b673a6ceca9d92', '2026-07-14T16:00:00Z'),
  ('team_blitz', 'Blitz Engine', 'blitz engine', 'blitz@example.test', 'blitz@example.test', '75875f55adaed1851ae9ef5a5cf738fe10104a86543d8cd55cdc1a595e2ef197', '2026-07-16T16:00:00Z'),
  ('team_vector', 'Vector Eleven', 'vector eleven', 'vector@example.test', 'vector@example.test', '27c7dfaa9d109e6b7fa8afb61fe0c2c29272570f6d9b310a6182505168453fc7', '2026-07-19T16:00:00Z'),
  ('team_orbit', 'Orbit Scheme', 'orbit scheme', 'orbit@example.test', 'orbit@example.test', 'da0184e92ef1015a1eb03720714d174be76c5c90ffebe347178ae264fe73be87', '2026-07-21T16:00:00Z'),
  ('team_signal', 'Signal Caller', 'signal caller', 'signal@example.test', 'signal@example.test', '9bdd93250fd882a562f246886f95d563ba3e7b6c0f1a804a1f104113cf098736', '2026-07-24T16:00:00Z'),
  ('team_northstar', 'Northstar Model', 'northstar model', 'northstar@example.test', 'northstar@example.test', 'ffcddeb6a2c341727944a873f3d0855cebc6ea96ef03af027b8223257c55390d', '2026-07-28T16:00:00Z')
ON CONFLICT DO NOTHING;

-- Local API key for Alpha Route: dfa_live_alpha_demo_key
