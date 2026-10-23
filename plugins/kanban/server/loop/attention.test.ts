import { describe, expect, it } from "vitest";
import { parsePathRules } from "../../shared/loop";
import { attentionLevel, globMatches, type AttentionSignals } from "./attention";

const quiet: AttentionSignals = {
  files: [
    { path: "README.md", risk: 1, role: "mechanical", lines: 4, note: "" },
    { path: "src/list.ts", risk: 2, role: "key", lines: 30, note: "sort order" },
  ],
  pathRules: [],
  rounds: 0,
  disputes: 0,
  checkFailures: 0,
  notCovered: 0,
  openScopeFindings: 0,
  deferredCritical: 0,
};

describe("attention level", () => {
  it("is Glance for a small low-risk change, naming its riskiest file", () => {
    expect(attentionLevel(quiet)).toEqual({ level: "glance", reasons: ["risk 2: sort order (src/list.ts)"] });
  });

  it("follows the highest file risk and the diff size", () => {
    expect(attentionLevel({ ...quiet, files: [{ path: "src/auth/token.ts", risk: 5, role: "key", lines: 12, note: "token refresh" }] }).level).toBe("scrutinize");
    expect(attentionLevel({ ...quiet, files: [{ path: "src/list.ts", risk: 2, role: "key", lines: 1200, note: "" }] })).toMatchObject({ level: "scrutinize", reasons: expect.arrayContaining(["1200 lines changed"]) });
  });

  it("reads ordinary logic under 100 lines at a glance, and longer or riskier changes closer", () => {
    const logic = (lines: number, risk = 3) => ({ ...quiet, files: [{ path: "src/cache.ts", risk, role: "key" as const, lines, note: "lookup cache" }] });
    expect(attentionLevel(logic(99))).toEqual({ level: "glance", reasons: ["risk 3 in 99 lines: lookup cache (src/cache.ts)"] });
    expect(attentionLevel(logic(100))).toEqual({ level: "read", reasons: ["risk 3: lookup cache (src/cache.ts)"] });
    expect(attentionLevel(logic(20, 4)).level).toBe("read");
  });

  it("is raised by a path rule matching a changed file", () => {
    expect(attentionLevel({ ...quiet, pathRules: [{ glob: "src/**", level: "scrutinize" }] })).toMatchObject({
      level: "scrutinize",
      reasons: expect.arrayContaining(["src/list.ts matches the path rule src/**"]),
    });
    expect(attentionLevel({ ...quiet, pathRules: [{ glob: "billing/**", level: "scrutinize" }] }).level).toBe("glance");
  });

  it("is raised to Read by loop and scope signals, a deferred critical finding included", () => {
    expect(attentionLevel({ ...quiet, rounds: 3 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["took 3 rounds"]) });
    expect(attentionLevel({ ...quiet, disputes: 1 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["1 disputed finding"]) });
    expect(attentionLevel({ ...quiet, checkFailures: 2 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["checks failed 2 times"]) });
    expect(attentionLevel({ ...quiet, notCovered: 2 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["2 things the checks don't cover"]) });
    expect(attentionLevel({ ...quiet, openScopeFindings: 1 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["1 open scope finding"]) });
    expect(attentionLevel({ ...quiet, deferredCritical: 1 })).toMatchObject({ level: "read", reasons: expect.arrayContaining(["1 deferred critical finding"]) });
    // Signals only raise: a Scrutinize path rule stays Scrutinize.
    expect(attentionLevel({ ...quiet, deferredCritical: 1, pathRules: [{ glob: "*.md", level: "scrutinize" }] }).level).toBe("scrutinize");
  });

  it("is at least Read when the files weren't classified", () => {
    expect(attentionLevel({ ...quiet, files: null })).toEqual({ level: "read", reasons: ["the files' risk wasn't classified"] });
  });
});

describe("globMatches", () => {
  it("lets ** cross directories, keeps * within one, and matches a bare name in any directory", () => {
    expect(globMatches("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatches("src/**/auth.ts", "src/auth.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatches(".github/workflows/*.yml", ".github/workflows/ci.yml")).toBe(true);
    expect(globMatches("*.sql", "db/migrations/001.sql")).toBe(true);
    expect(globMatches("install.sh", "scripts/install.sh")).toBe(true);
    expect(globMatches("src/a.ts", "src/axts")).toBe(false);
  });
});

describe("parsePathRules", () => {
  it("reads comma-separated glob and level pairs, and names the first entry that isn't one", () => {
    expect(parsePathRules("src/auth/** Scrutinize, .github/** read,")).toEqual({ rules: [{ glob: "src/auth/**", level: "scrutinize" }, { glob: ".github/**", level: "read" }] });
    expect(parsePathRules("src/** deep")).toEqual({ invalid: "src/** deep" });
  });
});
