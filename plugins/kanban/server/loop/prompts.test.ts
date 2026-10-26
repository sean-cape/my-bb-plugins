import { describe, expect, it } from "vitest";
import type { Ticket } from "../../shared/board";
import { cardPromptText, steeringText } from "./prompts";

const ticket = { title: "Fix it", pr: null } as Ticket;

describe("the land prompt", () => {
  it("credits the user's accept only when the user accepted", () => {
    expect(cardPromptText({ kind: "land", auto: false }, ticket, null)).toContain("The user read the board's handoff brief");
    const auto = cardPromptText({ kind: "land", auto: true }, ticket, null);
    expect(auto).toContain("accepted the change for \"Fix it\" without stopping");
    expect(auto).not.toContain("The user read");
  });
});

describe("steering", () => {
  it("ends the user's words with a full stop only when they lack one", () => {
    expect(steeringText(" Use the cache helper ")).toContain("from the board: Use the cache helper. This is steering");
    expect(steeringText("Why not the cache helper?")).toContain("from the board: Why not the cache helper? This is steering");
    expect(steeringText('Call it "done".')).toContain('from the board: Call it "done". This is steering');
  });

  it("resumes the thread with the user's words under the loop's contract", () => {
    const resume = cardPromptText({ kind: "resume", message: "Use the existing cache helper" }, ticket, "pnpm check");
    expect(resume).toContain("from the board: Use the existing cache helper.");
    expect(resume).toContain("bb kanban ready");
  });
});
