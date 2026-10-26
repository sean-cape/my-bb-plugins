import { describe, expect, it } from "vitest";
import { INITIAL_LOOP_STATE, parseLoopState } from "./loop";

describe("loop state", () => {
  it("parses state stored before directives, the phase's start time and manual retries, with their defaults", () => {
    const { directive, phaseSince, manualRetries, failedStep, ...stored } = INITIAL_LOOP_STATE;
    expect(parseLoopState(JSON.stringify({ ...stored, monitored: true, phase: "needs-you", reason: "handed-off" }))).toMatchObject({
      monitored: true,
      phase: "needs-you",
      reason: "handed-off",
      directive: null,
      phaseSince: null,
      manualRetries: 0,
      failedStep: null,
    });
  });
});
