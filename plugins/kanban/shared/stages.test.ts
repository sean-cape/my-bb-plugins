import { describe, expect, it } from "vitest";
import { loopStateSchema, needsYouReasonSchema, type LoopState } from "./loop";
import { chipFor, formatDuration, loopStages } from "./stages";

const NOW = 1_700_000_000_000;
const loop = (overrides: Partial<LoopState>): LoopState => loopStateSchema.parse({ monitored: true, phase: "building", ...overrides });
const statuses = (state: LoopState) => Object.fromEntries(loopStages(state, NOW).steps.map((step) => [step.id, step.status]));

describe("loopStages", () => {
  it("skips Plan with the gate off and marks each phase's step current with the rest in order", () => {
    expect(statuses(loop({ phase: "building" }))).toEqual({ plan: "skipped", build: "current", checks: "upcoming", review: "upcoming", fix: "upcoming", "needs-you": "upcoming", land: "upcoming" });
    expect(loopStages(loop({ phase: "building" }), NOW).steps[0]).toMatchObject({ id: "plan", status: "skipped", detail: "gate off" });
    expect(statuses(loop({ phase: "planning", gates: { plan: true, findings: false, autoAccept: true } }))).toMatchObject({ plan: "current", build: "upcoming" });
    expect(statuses(loop({ phase: "checking", gates: { plan: true, findings: false, autoAccept: true }, plan: "Do it" }))).toMatchObject({ plan: "done", build: "done", checks: "current", review: "upcoming" });
    // A gate turned on past planning held nothing, so no plan ran.
    expect(statuses(loop({ phase: "checking", gates: { plan: true, findings: false, autoAccept: true } }))).toMatchObject({ plan: "skipped", build: "done", checks: "current" });
    expect(statuses(loop({ phase: "classifying" }))).toMatchObject({ checks: "done", review: "current" });
    expect(statuses(loop({ phase: "reviewing" }))).toMatchObject({ checks: "done", review: "current", fix: "upcoming" });
    expect(statuses(loop({ phase: "fixing", round: 1 }))).toMatchObject({ review: "done", fix: "current", "needs-you": "upcoming" });
    expect(statuses(loop({ phase: "needs-you", reason: "clean", commit: "abc1234", checks: [{ commit: "abc1234", exitCode: 0, passed: true }] }))).toMatchObject({ checks: "done", review: "done", fix: "skipped", "needs-you": "current", land: "upcoming" });
    expect(statuses(loop({ phase: "landed" }))).toMatchObject({ "needs-you": "done", land: "done" });
  });

  it("says who holds the ball and which thread runs the step, with a question handing it to the user", () => {
    expect(loopStages(loop({ phase: "building" }), NOW)).toMatchObject({ holder: "agent", current: { threadRole: "card" } });
    expect(loopStages(loop({ phase: "checking" }), NOW)).toMatchObject({ holder: "board", current: { threadRole: "checks" } });
    expect(loopStages(loop({ phase: "reviewing" }), NOW)).toMatchObject({ holder: "board", current: { threadRole: "review" } });
    expect(loopStages(loop({ phase: "paused", pausedPhase: "fixing", reason: "question" }), NOW)).toMatchObject({ holder: "you", steps: expect.arrayContaining([expect.objectContaining({ id: "fix", status: "current" })]) });
    expect(loopStages(loop({ phase: "needs-you", reason: "cap" }), NOW).holder).toBe("you");
  });

  it("marks what a handed-off or stopped commit did and did not get", () => {
    const handed = loop({ phase: "needs-you", reason: "handed-off", commit: "abc1234", checks: [{ commit: "abc1234", exitCode: 0, passed: true }] });
    expect(loopStages(handed, NOW).steps.filter((step) => step.id === "checks" || step.id === "review")).toEqual([
      { id: "checks", label: "Checks", status: "done" },
      { id: "review", label: "Review", status: "skipped", detail: "not run" },
    ]);
    const atReady = loop({ phase: "needs-you", reason: "handed-off", commit: "def5678", reviewId: "r1", checks: [{ commit: "abc1234", exitCode: 0, passed: true }] });
    expect(loopStages(atReady, NOW).steps.filter((step) => step.id === "checks" || step.id === "review").map((step) => step.status)).toEqual(["skipped", "skipped"]);
    const afterReview = loop({ phase: "needs-you", reason: "handed-off", commit: "abc1234", reviewId: "r1", attention: { level: "read", reasons: [] }, checks: [{ commit: "abc1234", exitCode: 0, passed: true }] });
    expect(loopStages(afterReview, NOW).steps.find((step) => step.id === "review")).toMatchObject({ status: "done" });
    const stopped = loop({ phase: "needs-you", reason: "stopped", commit: "abc1234", checks: [{ commit: "abc1234", exitCode: 0, passed: true }] });
    expect(loopStages(stopped, NOW).steps.find((step) => step.id === "review")).toMatchObject({ status: "skipped", detail: "stopped" });
    // Accepting a hand-off keeps its reason, so the strip still says what did not run.
    expect(loopStages({ ...atReady, phase: "accepted" }, NOW).steps.filter((step) => step.id === "checks" || step.id === "review").map((step) => step.status)).toEqual(["skipped", "skipped"]);
  });

  it("counts the check failures that stopped the loop, and reads a failed check as no review whatever review id is left", () => {
    const failed = (count: number) => loop({ phase: "needs-you", reason: "checks", commit: "abc1234", checks: Array.from({ length: count }, () => ({ commit: "abc1234", exitCode: 1, passed: false })) });
    expect(loopStages(failed(1), NOW).steps.find((step) => step.id === "checks")).toMatchObject({ status: "done", detail: "failed" });
    expect(loopStages(failed(2), NOW).steps.find((step) => step.id === "checks")).toMatchObject({ status: "done", detail: "failed twice in a row" });
    const error = loop({ phase: "needs-you", reason: "loop-error", failedStep: "checks", failedThreadId: "thr_9", reviewId: "r1", commit: "def5678" });
    expect(loopStages(error, NOW).steps.filter((step) => step.id === "checks" || step.id === "review")).toEqual([
      { id: "checks", label: "Checks", status: "done", detail: "failed" },
      { id: "review", label: "Review", status: "skipped", detail: "not run" },
    ]);
  });

  it("gives a pill per round, the loop's numbered and the user's as yours, with the cap and manual retries", () => {
    const state = loop({
      phase: "reviewing",
      round: 2,
      manualRetries: 1,
      rounds: [
        { reviewId: "r1", handed: ["F1", "F2", "F3", "F4"], answers: { F1: { answer: "fixed" }, F2: { answer: "fixed" }, F3: { answer: "fixed" }, F4: { answer: "disputed", reason: "by design" } } },
        { reviewId: "r2", handed: [], owner: "user", comments: 2 },
        { reviewId: "r2", handed: ["F5"], answers: { F5: { answer: "fixed" } } },
      ],
    });
    const stages = loopStages(state, NOW);
    expect(stages.rounds.map((pill) => pill.label)).toEqual(["r1 · 3 fixed, 1 disputed", "yours · 2 comments", "r2 · 1 fixed", "r3 · reviewing"]);
    expect(stages.rounds[0]!.tone).toBe("warning");
    expect(stages).toMatchObject({ cap: { used: 2, max: 3 }, manualRetries: 1 });
    const fixing = loop({ phase: "fixing", round: 1, reviewId: "r1", rounds: [{ reviewId: "r1", handed: ["F1"], answers: {} }] });
    expect(loopStages(fixing, NOW).rounds.map((pill) => pill.label)).toEqual(["r1 · fixing"]);
  });

  it("reports the last checks result, the pending directive and the time since the phase began", () => {
    const state = loop({
      phase: "checking",
      commit: "abc1234def",
      phaseSince: NOW - 5 * 60_000,
      directive: "hand-off-after-step",
      checkCommand: { command: "pnpm test", source: "project" },
      checks: [{ commit: "0000000", exitCode: 1, passed: false, command: "pnpm test" }],
    });
    expect(loopStages(state, NOW)).toMatchObject({
      checks: { passed: false, command: "pnpm test", exitCode: 1, commit: "0000000" },
      directive: { kind: "hand-off-after-step", text: expect.stringContaining("after this step") },
      current: { commit: "abc1234def", elapsedMs: 5 * 60_000, text: expect.stringContaining("pnpm test") },
    });
    expect(loopStages(loop({ phase: "building" }), NOW)).toMatchObject({ checks: null, directive: null, current: { elapsedMs: null } });
  });
});

describe("chipFor", () => {
  it("uses the strip's words for the steps and the plan gate", () => {
    const label = (overrides: Partial<LoopState>) => chipFor(loop(overrides), NOW)?.label;
    expect(label({ monitored: false })).toBeUndefined();
    expect(label({ phase: "building" })).toBe("build");
    expect(label({ phase: "checking" })).toBe("checks");
    expect(label({ phase: "classifying", round: 1 })).toBe("review 2");
    expect(label({ phase: "reviewing", round: 3 })).toBe("review 3");
    expect(label({ phase: "fixing", round: 2 })).toBe("fix 2");
    expect(label({ phase: "fixing", round: 1, reviewId: "r1", rounds: [{ reviewId: "r1", handed: [], owner: "user" }] })).toBe("fix · yours");
    expect(label({ phase: "planning", gates: { plan: true, findings: false, autoAccept: true } })).toBe("plan");
    expect(label({ phase: "planning", gates: { plan: true, findings: false, autoAccept: true }, proposedPlan: "Do it" })).toBe("plan?");
    expect(label({ phase: "paused", pausedPhase: "building", reason: "question" })).toBe("stuck · question");
    expect(label({ phase: "accepted", autoAccepted: true })).toBe("auto-accepted");
    expect(label({ phase: "landed" })).toBe("landed");
  });

  it("shows the bucket and its detail word for every Needs-you reason", () => {
    const labels = Object.fromEntries(needsYouReasonSchema.options.map((reason) => [reason, chipFor(loop({ phase: "needs-you", reason, round: 1 }), NOW)?.label]));
    expect(labels).toEqual({
      findings: "approve · r2",
      clean: "needs you · clean",
      "handed-off": "needs you · not reviewed",
      stopped: "needs you · stopped",
      checks: "stuck · checks failing",
      cap: "stuck · cap reached",
      "not-converging": "stuck · not converging",
      dispute: "stuck · dispute",
      question: "stuck · question",
      "loop-error": "stuck · loop error",
    });
    expect(chipFor(loop({ phase: "needs-you", reason: "clean" }), NOW)?.tone).toBe("success");
    expect(chipFor(loop({ phase: "needs-you", reason: "cap" }), NOW)?.tone).toBe("danger");
  });

  it("adds the directive suffix and, past an hour at Needs you, the waiting time", () => {
    expect(chipFor(loop({ phase: "building", directive: "hand-off-at-ready" }), NOW)).toMatchObject({ label: "build → you", title: expect.stringContaining("Pending: Hand to you at the next ready") });
    expect(chipFor(loop({ phase: "needs-you", reason: "clean", phaseSince: NOW - 59 * 60_000 }), NOW)?.label).toBe("needs you · clean");
    expect(chipFor(loop({ phase: "needs-you", reason: "clean", phaseSince: NOW - 3 * 60 * 60_000 - 20 * 60_000 }), NOW)?.label).toBe("needs you · clean · 3h 20m");
    expect(chipFor(loop({ phase: "checking", phaseSince: NOW - 3 * 60 * 60_000 }), NOW)?.label).toBe("checks");
  });

  it("formats a duration in the shortest readable units", () => {
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(2 * 60 * 60_000)).toBe("2h");
    expect(formatDuration(26 * 60 * 60_000)).toBe("1d 2h");
  });
});
