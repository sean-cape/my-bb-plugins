import { describe, expect, it } from "vitest";
import { runModeFlags } from "./run-mode-flags";

const gates = { plan: true, findings: false, autoAccept: false };

describe("runModeFlags", () => {
  it("leaves a card alone, starts a thread outside the loop, or starts one the loop drives with the gates", () => {
    expect(runModeFlags("card", gates)).toEqual({ startThread: false });
    expect(runModeFlags("thread", gates)).toEqual({ startThread: true, monitored: false });
    expect(runModeFlags("loop", gates)).toEqual({ startThread: true, monitored: true, gates });
  });
});
