import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getChallengePlayers, getWeekScores, parseFantasyNerdsDateTime } from "./provider";

describe("Fantasy Nerds timestamps", () => {
  it("interprets timezone-less provider values as Eastern time", () => {
    expect(new Date(parseFantasyNerdsDateTime("2026-09-09T20:20:00")).toISOString())
      .toBe("2026-09-10T00:20:00.000Z");
    expect(new Date(parseFantasyNerdsDateTime("2026-12-10 20:20:00")).toISOString())
      .toBe("2026-12-11T01:20:00.000Z");
  });

  it("preserves timestamps that already include an offset", () => {
    expect(new Date(parseFantasyNerdsDateTime("2026-09-10T00:20:00Z")).toISOString())
      .toBe("2026-09-10T00:20:00.000Z");
  });
});

describe("Fantasy Nerds scoring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests standard leaders and reads the players envelope", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/leaders")) {
        return Response.json({
          season: 2026,
          week: 1,
          format: "std",
          players: [
            { playerId: 1205, position: "QB", points: "38.76" },
            { playerId: 9000, position: "LB", points: "12.00" },
          ],
        });
      }
      return Response.json({
        schedule: [
          { season: 2026, week: 1, winner: "SEA" },
          { season: 2026, week: 1, winner: "BUF" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeekScores({
      FANTASYNERDS_API_KEY: "test-key",
      FANTASYNERDS_BASE_URL: "https://api.fantasynerds.test",
    } as Env, 2026, 1);

    const leadersUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(leadersUrl.searchParams.get("format")).toBe("std");
    expect(leadersUrl.searchParams.get("position")).toBe("ALL");
    expect(leadersUrl.searchParams.get("week")).toBe("1");
    expect(result.points.get("fantasynerds_1205")).toBe(38.76);
    expect(result.points.has("fantasynerds_9000")).toBe(false);
    expect(result.allFinal).toBe(true);
  });

  it("does not publish an incomplete DFS slate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/dfs-slates")) {
        return Response.json({ platforms: { yahoo: [{ season: 2026, week: 1, slateId: "slate_1" }] } });
      }
      if (path.endsWith("/dfs")) return Response.json({ players: [] });
      return Response.json({ schedule: [] });
    }));

    await expect(getChallengePlayers({
      FANTASYNERDS_API_KEY: "test-key",
      FANTASYNERDS_BASE_URL: "https://api.fantasynerds.test",
    } as Env, 2026, 1, "challenge_2026_1", "2026-09-10T00:00:00Z"))
      .rejects.toThrow("incomplete Yahoo DFS slate");
  });
});
