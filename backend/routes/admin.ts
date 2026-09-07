import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { normalizeXHandle, X_HANDLE_PATTERN } from "../../src/shared/contracts";
import type { Env } from "../types";
import { refreshChallenge } from "../services/challenges";
import { one } from "../db/postgres";
import { normalizeIdentity } from "../lib/http";

export const adminRoutes = new Hono<{ Bindings: Env }>();
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const shell = (title: string, content: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Daily Fantasy AI</title><style>body{max-width:1200px;margin:32px auto;padding:0 20px;font:14px system-ui;color:#172016;background:#f3f4ee}h1{font-size:30px}h2{margin-top:32px}h3{margin-top:24px}a{color:#315f3b}.nav{display:flex;gap:16px;margin:12px 0 28px}.cards{display:flex;flex-wrap:wrap;gap:10px}.card{background:#fff;border:1px solid #d5d8ce;border-radius:6px;padding:14px 18px;min-width:130px}.card strong,.card span{display:block}.card strong{font-size:24px}.card span{color:#687064;font-size:12px;margin-top:4px}table{width:100%;border-collapse:collapse;background:#fff;margin:12px 0 20px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e8e9e3;white-space:nowrap}th{background:#eef0e8;text-transform:uppercase;font-size:11px}.muted{color:#687064}.editor{max-width:520px;padding:18px;background:#fff;border:1px solid #d5d8ce;border-radius:6px}.editor label{display:block;margin-bottom:14px;font-weight:650}.editor input{box-sizing:border-box;width:100%;margin-top:6px;padding:9px 10px;border:1px solid #b9beb3;border-radius:4px;font:inherit}.editor button,form button{padding:9px 12px;border:1px solid #315f3b;border-radius:4px;background:#315f3b;color:#fff;font:inherit;font-weight:700;cursor:pointer}.notice{max-width:520px;padding:10px 12px;border-left:3px solid #528b5c;background:#e7f3e7}.error{max-width:520px;padding:10px 12px;border-left:3px solid #a12622;background:#f8e7e4;color:#7f1d1d}</style></head><body><h1>Admin</h1><nav class="nav"><a href="/admin">Dashboard</a><a href="/admin/challenges">Challenges</a><a href="/admin/teams">Teams</a></nav>${content}</body></html>`;
const table = (headers: string[], rows: unknown[][]) => `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${String(x ?? "").startsWith("<a ") ? x : esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const xProfile = (handle: unknown) => handle ? `<a href="https://x.com/${encodeURIComponent(String(handle))}" target="_blank" rel="noreferrer">@${esc(handle)}</a>` : "";
const teamUpdateSchema = z.object({
  teamName: z.string().trim().min(2).max(60),
  x_handle: z.string().trim().refine((value) => value === "" || X_HANDLE_PATTERN.test(value)),
}).strict();
function unauthorized(c: Context<{ Bindings: Env }>) { return c.body("Authentication required.", 401, { "WWW-Authenticate": 'Basic realm="Admin", charset="UTF-8"' }); }
adminRoutes.use("/admin", async (c, next) => { const header = c.req.header("Authorization"); if (!c.env.ADMIN_SECRET || !header?.startsWith("Basic ")) return unauthorized(c); try { const decoded = atob(header.slice(6)); if (decoded.slice(decoded.indexOf(":") + 1) !== c.env.ADMIN_SECRET) return unauthorized(c); } catch { return unauthorized(c); } await next(); });

adminRoutes.get("/admin", async (c) => {
  const names = ["teams", "challenges", "selections", "runs", "attempts", "lineups", "lineup_players", "audit_events", "scores", "standings"];
  const counts = await Promise.all(names.map(async (name) => [name, (await c.env.DB.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`)).rows[0]?.count ?? 0]));
  return c.html(shell("Dashboard", `<p class="muted">Application overview and administration.</p><div class="cards">${counts.map(([name, count]) => `<div class="card"><strong>${count}</strong><span>${esc(name)}</span></div>`).join("")}</div><h2>Browse</h2><p><a href="/admin/challenges">Browse challenges and submitted lineups →</a></p><p><a href="/admin/teams">Browse registered teams and lineups →</a></p>`));
});

adminRoutes.post("/admin/challenges/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const challenge = await one<any>(c.env.DB, "SELECT * FROM challenges WHERE id = $1", [id]);
  if (!challenge) return c.json({ message: "Challenge not found." }, 404);
  try {
    const result = await refreshChallenge(c.env.DB, c.env, challenge);
    if (c.req.query("redirect") === "1") {
      return c.redirect(`/admin/challenges?id=${encodeURIComponent(id)}&refreshed=${result.players}`);
    }
    return c.json({ message: "Challenge deleted and re-created from Fantasy Nerds.", ...result });
  } catch (error) {
    if (c.req.query("redirect") === "1") {
      const message = error instanceof Error ? error.message : "Challenge refresh failed.";
      return c.redirect(`/admin/challenges?id=${encodeURIComponent(id)}&refresh_error=${encodeURIComponent(message)}`);
    }
    return c.json({ message: error instanceof Error ? error.message : "Challenge refresh failed." }, 409);
  }
});

adminRoutes.get("/admin/challenges", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  const challenges = await c.env.DB.query("SELECT id, season, week, status, protocol_version, released_at, deadline_at, first_game_at, salary_cap, content_hash FROM challenges ORDER BY season DESC, week DESC");
  const selected = challenges.rows.find((r) => String(r.id) === id);
  const teams = selected ? await c.env.DB.query("SELECT l.team_id, t.team_name, l.total_cost, l.accepted_at, l.lineup_hash FROM lineups l JOIN teams t ON t.id = l.team_id WHERE l.challenge_id = $1 ORDER BY l.accepted_at DESC", [id]) : { rows: [] };
  const selections = selected ? await c.env.DB.query("SELECT selection_id, player_id, name, nfl_team, opponent, position, eligible_slots, price, player_status, game_starts_at FROM selections WHERE challenge_id = $1 ORDER BY game_starts_at, position, name", [id]) : { rows: [] };
  const rows = challenges.rows.map((r) => [`<a href="/admin/challenges?id=${encodeURIComponent(String(r.id))}">Season ${esc(r.season)}, week ${esc(r.week)}</a>`, r.id, r.status, r.released_at, r.deadline_at, r.salary_cap]);
  const refreshed = c.req.query("refreshed");
  const refreshError = c.req.query("refresh_error");
  const refreshNotice = refreshed
    ? `<p>Challenge deleted and re-created from Fantasy Nerds (${esc(refreshed)} selections).</p>`
    : refreshError ? `<p style="color:#a12622">Refresh failed: ${esc(refreshError)}</p>` : "";
  const detail = selected ? `<h2>Challenge details</h2><p>Status: ${esc(selected.status)} · Protocol: ${esc(selected.protocol_version)} · Salary cap: ${esc(selected.salary_cap)}<br>Released: ${esc(selected.released_at)} · Deadline: ${esc(selected.deadline_at)} · First game: ${esc(selected.first_game_at)}<br>Content hash: ${esc(selected.content_hash)}</p><h3>Submitted lineups</h3>${teams.rows.length ? table(["Team", "Team ID", "Total cost", "Accepted", "Lineup hash"], teams.rows.map((r) => [`<a href="/admin/teams?id=${encodeURIComponent(String(r.team_id))}">${esc(r.team_name)}</a>`, r.team_id, r.total_cost, r.accepted_at, r.lineup_hash])) : "<p class=\"muted\">No accepted lineups.</p>"}` : "<p class=\"muted\">Select a challenge to inspect it.</p>";
  const refreshControl = selected ? `${refreshNotice}<form method="post" action="/admin/challenges/${encodeURIComponent(String(selected.id))}/refresh?redirect=1" onsubmit="return confirm('This will permanently delete the challenge and all associated runs, attempts, audits, and lineups, then re-create it from Fantasy Nerds. Continue?');"><button type="submit">Delete and re-create from Fantasy Nerds</button></form>` : "";
  const selectionView = selected ? `${refreshControl}<h3>Available selections (${selections.rows.length})</h3>${table(["Selection", "Player ID", "Name", "NFL team", "Opponent", "Position", "Eligible slots", "Price", "Status", "Game starts"], selections.rows.map((r) => [r.selection_id, r.player_id, r.name, r.nfl_team, r.opponent, r.position, r.eligible_slots, r.price, r.player_status, r.game_starts_at]))}` : "";
  return c.html(shell("Challenges", `<h2>Challenges</h2>${table(["Challenge", "ID", "Status", "Released", "Deadline", "Salary cap"], rows)}${selectionView}${detail}`));
});

adminRoutes.post("/admin/teams", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  const team = id ? await one<{ id: string }>(c.env.DB, "SELECT id FROM teams WHERE id = $1", [id]) : null;
  if (!team) return c.html(shell("Team not found", "<p>Team not found.</p>"), 404);

  const body = await c.req.parseBody();
  const parsed = teamUpdateSchema.safeParse({ teamName: body.teamName, x_handle: body.x_handle });
  const location = (key: "updated" | "error", value: string) =>
    `/admin/teams?${new URLSearchParams({ id, [key]: value })}`;
  if (!parsed.success) {
    return c.redirect(location("error", "Enter a 2-60 character team name and a valid X handle."), 303);
  }

  const teamName = parsed.data.teamName.replace(/\s+/g, " ");
  const normalizedName = normalizeIdentity(teamName);
  const conflict = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM teams WHERE normalized_name = $1 AND id != $2",
    [normalizedName, id],
  );
  if (conflict) return c.redirect(location("error", "Another team already uses that name."), 303);

  const xHandle = parsed.data.x_handle ? normalizeXHandle(parsed.data.x_handle) : null;
  await c.env.DB.query(
    "UPDATE teams SET team_name = $1, normalized_name = $2, x_handle = $3 WHERE id = $4",
    [teamName, normalizedName, xHandle, id],
  );
  return c.redirect(location("updated", "1"), 303);
});

adminRoutes.get("/admin/teams", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  const lineupId = c.req.query("lineup_id")?.trim() ?? "";
  const teams = await c.env.DB.query("SELECT id, team_name, x_handle, email, created_at FROM teams ORDER BY created_at DESC");
  const selected = teams.rows.find((r) => String(r.id) === id);
  const lineups = selected ? await c.env.DB.query("SELECT l.id, l.challenge_id, l.season, l.week, l.total_cost, l.accepted_at, l.lineup_hash FROM lineups l WHERE l.team_id = $1 ORDER BY l.accepted_at DESC", [id]) : { rows: [] };
  const players = lineupId ? await c.env.DB.query("SELECT lp.slot, lp.player_id, s.name, s.nfl_team, s.position, s.price FROM lineup_players lp JOIN lineups l ON l.id = lp.lineup_id JOIN selections s ON s.challenge_id = l.challenge_id AND s.selection_id = lp.selection_id WHERE l.id = $1 AND l.team_id = $2 ORDER BY lp.slot", [lineupId, id]) : { rows: [] };
  const rows = teams.rows.map((r) => [`<a href="/admin/teams?id=${encodeURIComponent(String(r.id))}">${esc(r.team_name)}</a>`, xProfile(r.x_handle), r.id, r.email, r.created_at]);
  const notice = c.req.query("updated") === "1"
    ? '<p class="notice">Team updated.</p>'
    : c.req.query("error") ? `<p class="error">${esc(c.req.query("error"))}</p>` : "";
  const editor = selected ? `<h3>Edit team</h3>${notice}<form class="editor" method="post" action="/admin/teams?id=${encodeURIComponent(id)}"><label>Team name<input name="teamName" value="${esc(selected.team_name)}" minlength="2" maxlength="60" required></label><label>X handle <span class="muted">(optional)</span><input name="x_handle" value="${esc(selected.x_handle)}" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" placeholder="@handle"></label><button type="submit">Save changes</button></form>` : "";
  const detail = selected ? `<h2>Team details</h2><p>${esc(selected.team_name)} · ${xProfile(selected.x_handle) || "No X handle"} · ${esc(selected.email)} · Registered ${esc(selected.created_at)}</p>${editor}<h3>Accepted lineups</h3>${lineups.rows.length ? table(["Challenge", "Season", "Week", "Total cost", "Accepted", "Lineup hash"], lineups.rows.map((r) => [`<a href="/admin/teams?id=${encodeURIComponent(id)}&lineup_id=${encodeURIComponent(String(r.id))}">${esc(r.challenge_id)}</a>`, r.season, r.week, r.total_cost, r.accepted_at, r.lineup_hash])) : "<p class=\"muted\">No accepted lineups.</p>"}${lineupId && players.rows.length ? `<h3>Lineup players</h3>${table(["Slot", "Player", "Player ID", "NFL team", "Position", "Price"], players.rows.map((r) => [r.slot, r.name, r.player_id, r.nfl_team, r.position, r.price]))}` : ""}` : "<p class=\"muted\">Select a team to inspect it.</p>";
  return c.html(shell("Teams", `<h2>Teams</h2>${table(["Team", "X handle", "ID", "Email", "Created"], rows)}${detail}`));
});
