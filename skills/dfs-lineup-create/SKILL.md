---
name: dfs-lineup-create
description: Create a strong, valid daily fantasy sports lineup from caller-supplied players, prices, salary cap, and lineup requirements. Use for service-neutral DFS lineup construction, optimization, validation, and concise selection explanations; never assume a sport's roster, scoring, IDs, or cap rules when the caller has not provided them.
---

# DFS Lineup Create

Create one lineup from the caller's data. This skill is service- and sport-neutral: it does not retrieve players, submit requests, or assume a particular DFS platform.

## Required caller input

Require all four inputs before selecting:

1. Available players, including the identifier that must be returned, position/eligibility, and any supplied projections, status, team, game, or role data.
2. Price for each player.
3. Salary cap.
4. Exact valid-lineup requirements: slot names, counts, eligibility, duplicate rules, and any other constraints.

If any input is missing or ambiguous, ask for it. Never invent a player, price, projection, slot, or eligibility rule.

## Editable selection rules

The caller may override these preferences:

```text
Goal: Prefer a simple balanced lineup.
Risk: Balanced; avoid boom-only players and extreme punts.
Player preference: Prefer the best available salary-adjusted expected production.
Correlation: Mildly prefer compatible teammates when it does not materially weaken the lineup.
Late news: Avoid players marked out, doubtful, or not expected to play.
Tie-breaker: Higher expected production, then lower price, then stable role, then deterministic ID order.
```

Treat custom preferences as soft rules. Hard validity requirements always win.

## Construction workflow

1. Normalize the supplied data and identify every required slot.
2. Exclude unavailable players and players ineligible for every open slot.
3. Rank candidates using supplied projections first; otherwise use supplied recent production, role, matchup/game context, and price. Treat weak signals as uncertain and do not fabricate missing values.
4. Fill constrained slots first, preserving enough eligible players for later slots. For flexible slots, compare all eligible positions rather than filling greedily by position.
5. Search or improve combinations until the lineup is valid and fits the cap. If over budget, replace the lowest-value player with the best eligible cheaper alternative while protecting roster feasibility.
6. Apply soft correlation or risk preferences only after hard constraints are satisfied.
7. Validate every rule: exact slot counts, eligibility, unique players, known IDs, salary cap, and any caller-supplied restrictions.

## Output contract

Return:

```text
Lineup: [slot -> caller-provided player ID]
Salary: $X / $CAP
Remaining: $Y
Rules used: [brief summary]
Notes: [uncertainties or tradeoffs]
```

Return the lineup in the caller's requested structure when one is specified. Keep explanations separate from any machine-readable lineup payload. Do not claim mathematical optimality unless exhaustive optimization and a defined objective actually establish it; call it the best lineup under the supplied data and rules.

## Guardrails

- Use only caller-supplied facts for player data.
- Do not submit, retrieve, or modify credentials.
- Do not silently relax a validity rule to make a lineup fit.
- If no valid lineup exists, report the conflicting constraints and the smallest apparent relaxation; do not emit an invalid lineup.
