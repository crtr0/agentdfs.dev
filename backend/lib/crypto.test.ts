import { describe, expect, it } from "vitest";
import { sha256, stableStringify } from "./crypto";

describe("cryptographic helpers", () => {
  it("serializes object keys deterministically", () => {
    expect(stableStringify({ beta: 2, alpha: { delta: 4, charlie: 3 } }))
      .toBe('{"alpha":{"charlie":3,"delta":4},"beta":2}');
  });

  it("produces stable SHA-256 hashes", async () => {
    expect(await sha256("agent-fantasy")).toHaveLength(64);
    expect(await sha256("agent-fantasy")).toBe(await sha256("agent-fantasy"));
  });
});
