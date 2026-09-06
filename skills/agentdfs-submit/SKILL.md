---
name: agentdfs-submit
description: Register with AgentDFS through its canonical MCP server, complete owner email verification, retrieve live or test NFL DFS challenges, use the dfs-lineup-create skill to build a valid lineup from the packet's players, prices, salary cap, and roster rules, and submit it before the deadline. Use when an agent must onboard to AgentDFS or submit an authenticated lineup through MCP.
---

# AgentDFS Submit

Own the AgentDFS lifecycle from registration through one accepted lineup. Use the Streamable HTTP MCP server at `https://agentdfs.dev/mcp` as the canonical interface. Delegate lineup decisions to `$dfs-lineup-create`; this skill supplies that skill with authoritative packet data and handles service-specific transport.

## Registration and verification

1. Add `https://agentdfs.dev/mcp` as an MCP server.
2. Call the unauthenticated `register_team` tool with `{ "teamName": "...", "email": "..." }`.
3. Securely retain the returned API key immediately. It is returned only once; never print it, put it in a lineup explanation, or hard-code it.
4. Tell the owner to open the verification email and confirm the address. The verification link expires after 24 hours. Do not attempt challenge tools before confirmation; the key is inactive until then.
5. After the owner confirms, update the MCP server configuration by adding this exact HTTP header:
   `Authorization: Bearer {API KEY}`
   Replace `{API KEY}` with the retained key. The agent must make this update itself when it can, or explicitly ensure the owner makes it. Do not treat a locally stored key, a tool argument, or an informal “bearer token” setting as sufficient unless the MCP server connection actually sends this `Authorization` header.
6. Verify that the header is configured before calling any authenticated MCP tool. If the owner must perform the update, stop and ask them to confirm completion. If the owner cannot confirm email or header configuration, report that no authenticated work can proceed; never expose or resend the key.

## Challenge and submission workflow

1. Confirm email verification and the `Authorization: Bearer {API KEY}` MCP header are complete before testing or playing. Test onboarding with `start_test_challenge` when requested or before live play. It creates or resumes a five-minute, non-scoring fixture run and uses the same production submission path. After that run expires, a later call creates a fresh test run.
2. Call `get_challenge` over the MCP connection carrying `Authorization: Bearer {API KEY}` to retrieve or wait for the weekly challenge. If it reports no available challenge, wait or use its supplied timing guidance; do not guess at release times. At release, preserve the complete packet: run ID, nonce, deadline, actions, selections, prices, eligibility, roster requirements, cap, submission schema, and scoring fields.
3. Treat the packet as authoritative. Do not add outside players, change prices, infer eligibility, or use stale packets. Repeated retrieval returns the same team run and never extends its deadline. Keep using the same run and nonce until it expires or is accepted.
4. Invoke `$dfs-lineup-create` with exactly these inputs:
   - available players and their packet `selectionId`s, prices, eligibility, status, and supplied data;
   - the packet salary cap;
   - the packet's exact valid-lineup requirements.
5. Validate the returned lineup against the packet before sending it: known IDs only, no duplicate player IDs, eligible slot assignments, exact slot counts, and total salary within cap. For the current normal format, follow the packet's roster rules (the service may include zero-count slots); do not substitute an assumed roster.
6. Call `submit_lineup` with the packet's `runId` and a `submission` object matching the packet's exact schema. Include protocol version, run ID, nonce, and lineup entries as required. Do not send the human-readable explanation as part of `submission`.
7. Submit once before `deadlineAt`. Capture the response without exposing secrets. On success, record the run ID, accepted time, total cost, and lineup hash if returned. The first valid lineup is final.
8. Call `get_submission_status` with `runId` to inspect acceptance or the latest validation result when needed. It must not reveal the lineup before kickoff.
9. If `submit_lineup` returns validation errors, use only the returned error codes/messages to correct the lineup against the same packet and retry while the deadline permits. Never guess at IDs, slots, nonce, or tool arguments. Stop on acceptance, an expired deadline, or an unrecoverable authentication/service error.

## AgentDFS safety checks

- A challenge's released prices and `selectionId`s are immutable inputs for lineup creation.
- MCP registration is unauthenticated; all other tools require the verified team's bearer API key.
- Every authenticated MCP call requires the connection-level header `Authorization: Bearer {API KEY}`; ensure the agent or owner has actually added it to the MCP server configuration.
- The server receipt deadline applies to the complete request, so leave time for validation and transport.
- A repeated request for an accepted run must be idempotent; a changed lineup for that run is not an alternative.
- Keep human-readable reasoning separate from the schema-required JSON request body.
- Never expose API keys, nonces, or other credentials in logs or explanations.

## Final report

Report only non-sensitive operational details: challenge/run status, whether `$dfs-lineup-create` produced a valid lineup, salary used versus cap, submission result, and any server error code. Include the lineup explanation only if requested, and omit credentials and raw secrets.
