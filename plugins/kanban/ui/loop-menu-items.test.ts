import { describe, expect, it } from "vitest";
import type { Ticket } from "../shared/board";
import { loopStateSchema, type LoopState } from "../shared/loop";
import { composerMode, handOffDirective, loopMenuItems, type LoopMenuItemId } from "./loop-menu-items";

const loop = (overrides: Partial<LoopState>): LoopState => loopStateSchema.parse({ monitored: true, phase: "building", ...overrides });
const ticket = (state: LoopState | null, threadId: string | null = "thr_1"): Ticket => ({ id: "t1", threadId, loop: state }) as Ticket;

const items = (state: LoopState | null, threadId?: string | null) => loopMenuItems(ticket(state, threadId));
const item = (list: ReturnType<typeof loopMenuItems>, id: LoopMenuItemId) => list.find((entry) => entry.id === id)!;
const enabled = (list: ReturnType<typeof loopMenuItems>) => list.filter((entry) => entry.disabled === null).map((entry) => entry.id);

describe("loopMenuItems", () => {
  it("while the thread builds, offers steer, hand off at ready, skip review, the gates and loop off", () => {
    const list = items(loop({ phase: "building" }));
    expect(enabled(list)).toEqual(["steer", "hand-off", "skip-review", "gate:plan", "gate:findings", "gate:autoAccept", "monitor"]);
    expect(item(list, "hand-off").label).toBe("Hand to me at the next ready");
    expect(item(list, "stop").disabled).toBe("The board isn't running a step");
    expect(item(list, "monitor").label).toBe("Loop off");
  });

  it("while the board reviews, hand off waits for the step, stop is live and skip review says to hand off instead", () => {
    const list = items(loop({ phase: "reviewing" }));
    expect(enabled(list)).toContain("stop");
    expect(item(list, "hand-off").label).toBe("Hand to me after this step");
    expect(item(list, "skip-review").disabled).toBe("The board is reviewing the card; hand off after this step instead");
    expect(item(list, "steer").hint).toContain("supersedes");
  });

  it("at a loop error, retry and resume are live and carry the manual count, and hand off says the card is with you", () => {
    const list = items(loop({ phase: "needs-you", reason: "loop-error", manualRetries: 2, failedStep: "review", commit: "abc1234" }));
    expect(enabled(list)).toEqual(expect.arrayContaining(["retry", "resume", "steer"]));
    expect(item(list, "retry").label).toBe("Retry (2 so far)");
    expect(item(list, "retry").hint).toBe("Runs the review again at the same commit");
    expect(item(list, "hand-off").disabled).toBe("The card is already with you");
    expect(item(list, "skip-review").disabled).toBe("The card is already with you");
  });

  it("greys retry when the failed step can't be started again, as the server refuses it", () => {
    expect(item(items(loop({ phase: "needs-you", reason: "loop-error", failedStep: null })), "retry").disabled).toContain("can't be started again");
    expect(item(items(loop({ phase: "needs-you", reason: "loop-error", failedStep: "checks", commit: "abc1234", checkCommand: null })), "retry").disabled).toContain("can't be started again");
    expect(item(items(loop({ phase: "needs-you", reason: "clean" })), "retry").disabled).toBe("Only after a loop error stopped the loop");
  });

  it("without a thread, steer and resume say so; paused on a question, steer sends you to the thread", () => {
    const noThread = items(loop({ phase: "needs-you", reason: "clean" }), null);
    expect(item(noThread, "steer").disabled).toBe("The card has no thread to steer");
    expect(item(noThread, "resume").disabled).toBe("The card has no thread to resume");
    expect(item(items(loop({ phase: "paused", pausedPhase: "fixing" })), "steer").disabled).toBe("The thread is waiting on a question; answer it in the thread");
  });

  it("with the loop off, every intervention is greyed as off", () => {
    const list = items(null);
    expect(enabled(list)).toEqual(["monitor"]);
    expect(item(list, "steer").disabled).toBe("The loop is off; turn it on first");
  });

  it("hints the next Rethink only for an unticked plan gate past planning", () => {
    expect(item(items(loop({ phase: "fixing" })), "gate:plan").hint).toBe("Takes effect at the next Rethink");
    expect(item(items(loop({ phase: "fixing", gates: { plan: true, findings: false, autoAccept: true } })), "gate:plan").hint).not.toContain("Rethink");
    expect(item(items(loop({ phase: "planning" })), "gate:plan").hint).not.toContain("Rethink");
  });
});

describe("handOffDirective", () => {
  it("hands off at the ready while the thread works, after the step while the board does, and not at Needs you", () => {
    expect(handOffDirective(loop({ phase: "paused", pausedPhase: "fixing" }))).toBe("hand-off-at-ready");
    expect(handOffDirective(loop({ phase: "checking" }))).toBe("hand-off-after-step");
    expect(handOffDirective(loop({ phase: "needs-you" }))).toBeNull();
  });
});

describe("composerMode", () => {
  it("resumes at Needs you, waits while paused, and is gone once the change is accepted", () => {
    expect(composerMode(loop({ phase: "building" }))).toBe("steer");
    expect(composerMode(loop({ phase: "needs-you" }))).toBe("resume");
    expect(composerMode(loop({ phase: "paused" }))).toBe("paused");
    expect(composerMode(loop({ phase: "accepted" }))).toBeNull();
  });
});
