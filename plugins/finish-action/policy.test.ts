import { describe, expect, it } from "vitest";
import { cycleAction } from "./actions.js";
import { finishSteps, resolveAction, settingApplies } from "./policy.js";

describe("resolveAction", () => {
  it("prefers the thread's own pick", () => {
    expect(resolveAction("commit", "land")).toEqual({ action: "commit", source: "thread" });
  });

  it("falls back to the project's default, then to leaving changes uncommitted", () => {
    expect(resolveAction(undefined, "land")).toEqual({ action: "land", source: "project" });
    expect(resolveAction(undefined, null)).toEqual({ action: "none", source: "default" });
  });

  it("ignores a malformed pick, since anything can write thread metadata", () => {
    expect(resolveAction("ship-it", "commit")).toEqual({ action: "commit", source: "project" });
    expect(resolveAction({ action: "land" }, null)).toEqual({ action: "none", source: "default" });
  });
});

describe("settingApplies", () => {
  it("covers threads the user started in a repository project", () => {
    expect(settingApplies({ originPluginId: null }, { kind: "standard" })).toBe(true);
  });

  it("leaves plugin-started threads and Personal threads to their own instructions", () => {
    expect(settingApplies({ originPluginId: "kanban" }, { kind: "standard" })).toBe(false);
    expect(settingApplies({ originPluginId: null }, { kind: "personal" })).toBe(false);
  });
});

describe("cycleAction", () => {
  it("steps through merge, commit and leave, wrapping both ways", () => {
    expect(cycleAction("land", 1)).toBe("commit");
    expect(cycleAction("none", 1)).toBe("land");
    expect(cycleAction("land", -1)).toBe("none");
  });
});

describe("finishSteps", () => {
  const base = { source: "thread" as const, base: "main", hasLandScript: false };

  it("points a merge at the repository's land script when it has one", () => {
    const steps = finishSteps({ ...base, action: "land", hasLandScript: true });
    expect(steps).toContain('"Merge to main" (picked for this thread)');
    expect(steps).toContain("`node scripts/land.mjs`");
    expect(steps).toContain("sandbox disabled");
  });

  it("falls back to the repository's own instructions, then a local merge into the base", () => {
    const steps = finishSteps({ ...base, action: "land", base: "develop" });
    expect(steps).not.toContain("land.mjs");
    expect(steps).toContain("merge the branch into develop");
    expect(steps).toContain("Don't push unless the user asks");
  });

  it("keeps a commit on the branch and leaves uncommitted work alone", () => {
    expect(finishSteps({ ...base, action: "commit" })).toContain("Don't merge, cherry-pick or push");
    expect(finishSteps({ ...base, action: "none", source: "default" })).toMatch(/\(the default\)[\s\S]*Leave your changes uncommitted/);
  });

  it("lets a message from the user override the setting", () => {
    expect(finishSteps({ ...base, action: "commit" })).toContain("A message from the user that asks for something else wins");
  });
});
