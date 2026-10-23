import { describe, expect, it } from "vitest";
import type { Ticket } from "../../shared/board";
import type { Review } from "../../shared/review";
import { REVIEW_SKILL_MISSING, localApplyPrompt, prApplyPrompt, reviewPrompt, type CardIntent } from "./prompts";
import { localSubject, prSubject, subjectLabel } from "./subject";

const commit = "0123456789abcdef0123456789abcdef01234567";
const since = "fedcba9876543210fedcba9876543210fedcba98";
const noIntent: CardIntent = { plan: null, branch: null };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    title: "Cache lookups",
    description: "",
    columnId: "in-progress",
    kind: "adhoc",
    tags: [],
    sourceId: null,
    threadId: "thr_card",
    reviewThreadId: null,
    latestReview: null,
    comments: null,
    parentId: null,
    dueDate: null,
    children: { total: 0, done: 0, withThread: 0 },
    pendingDiffComments: 0,
    canPostToGithub: false,
    defaultCommentTarget: "local",
    projectId: "proj_1",
    pr: null,
    jira: null,
    position: 0,
    columnEnteredAt: 0,
    loop: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function prTicket(): Ticket {
  return ticket({
    kind: "pr",
    pr: {
      repo: "acme-co/widgets",
      number: 7,
      url: "https://github.com/acme-co/widgets/pull/7",
      role: "authored",
      state: "open",
      author: "me",
      updatedAt: "",
      headRef: null,
      checks: null,
      checksUrl: null,
      body: null,
    },
  });
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1",
    ticketId: "t1",
    threadId: "thr_review",
    subjectKind: "local",
    status: "completed",
    commitSha: since,
    baseRef: "main",
    headRef: null,
    sinceCommitSha: null,
    depth: "standard",
    body: "## Review Findings\n- a.ts:1 fix me",
    report: null,
    selection: {},
    selectionOverrides: {},
    findingEdits: {},
    appliedFindingIds: [],
    createdAt: 0,
    completedAt: 0,
    apply: null,
    ...overrides,
  };
}

describe("review subjects", () => {
  it("takes a PR card's pull request and refuses a card without one", () => {
    expect(prSubject(prTicket())).toEqual({ kind: "pr", repo: "acme-co/widgets", number: 7, url: "https://github.com/acme-co/widgets/pull/7" });
    expect(subjectLabel(prSubject(prTicket()))).toBe("widgets#7");
    expect(() => prSubject(ticket())).toThrow(/Not a PR card/u);
  });

  it("names a local commit by its short sha and rejects anything that is not a sha and a ref", () => {
    expect(subjectLabel(localSubject(commit, "main"))).toBe("0123456");
    expect(localSubject("abc1234", "origin/release-1.2")).toEqual({ kind: "local", commit: "abc1234", defaultBranch: "origin/release-1.2" });
    expect(() => localSubject("HEAD", "main")).toThrow();
    expect(() => localSubject(commit, "main; rm -rf ~")).toThrow();
    expect(() => localSubject(commit, "-main")).toThrow();
  });
});

describe("review prompt", () => {
  it("checks a local commit out detached and reviews it against its merge base with the default branch, with nothing fetched", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), null, [], noIntent, "standard");
    expect(prompt).toContain(`1. \`git checkout --detach ${commit}\``);
    expect(prompt).toContain('2. `bb kanban review-record --commit "$(git rev-parse HEAD)" --base "main"` so');
    expect(prompt).not.toContain("--head");
    expect(prompt).toContain("with the range `main...HEAD` (three-dot) and the card's intent below, so it reviews exactly the commits since its merge base with `main`");
    expect(prompt).not.toMatch(/gh pr|git fetch|pull\/|FETCH_HEAD|origin\/\$BASE/u);
  });

  it("numbers a local re-review's steps after its two setup steps", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "standard");
    expect(prompt).toContain(`3. Review the new commits. If \`git log ${since}..HEAD\` is empty nothing changed`);
    expect(prompt).toContain("4. Re-check the earlier findings at HEAD.");
    expect(prompt).toContain("When step 3 found nothing changed");
    expect(prompt).toContain("5. Compile one merged report");
    expect(prompt).toContain("the new findings from step 3 plus every open earlier finding");
    expect(prompt).toContain("lists only the reviewers step 3 ran");
    expect(prompt).not.toMatch(/step [45]\b|with the range `main\.\.\.HEAD`/u);
  });

  it("judges a re-review's new findings pre-existing against the whole change, and keeps carried findings' verification", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "standard");
    expect(prompt).toContain(`invoke the \`code-review\` skill at depth \`standard\` with the range \`${since}..HEAD\`, the pre-existing range \`main...HEAD\` and the card's intent below`);
    expect(prompt).toContain("A carried finding keeps its earlier title, description, fix, severity, scores, confidence, verification, preExisting, flaggedBy, category, class, triage and dispute");
    expect(prompt).toContain('`"filtered"` holds only the findings step 3 filtered out');
    const pr = reviewPrompt(prSubject(prTicket()), prTicket(), review(), [review()], noIntent, "standard");
    expect(pr).toContain(`with the range \`${since}..HEAD\`, the pre-existing range \`origin/$BASE...HEAD\``);
  });

  it("carries a finding forward while any instance of its bug class is left, and keeps what the checks still do not cover", () => {
    const earlier = review({
      body: "x",
      report: {
        version: 3,
        summary: "",
        commit: null,
        range: null,
        depth: null,
        reviewers: [],
        skippedReviewers: [],
        skippedFiles: [],
        findings: [],
        filtered: [],
        notCovered: ["UI only: the drag preview"],
        carriesForward: false,
        resolved: [],
      },
    });
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), earlier, [earlier], noIntent, "standard");
    expect(prompt).toContain("addressed (the problem is gone at every instance)");
    expect(prompt).toContain("takes every instance still present at HEAD as its locations");
    expect(prompt).toContain('`"notCovered"` holds step 3\'s list plus each earlier entry below that still holds at HEAD');
    expect(prompt).toContain("### Not covered by the earlier reviews\n\n- UI only: the drag preview");
    expect(reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "standard")).not.toContain("Not covered by the earlier reviews");
  });

  it("numbers a PR re-review's steps after its four setup steps", () => {
    const prompt = reviewPrompt(prSubject(prTicket()), prTicket(), review(), [review()], noIntent, "standard");
    expect(prompt).toContain('4. `bb kanban review-record --commit "$(git rev-parse HEAD)" --base "$BASE" --head "$HEAD_REF"`');
    expect(prompt).toContain(`5. Review the new commits. If \`git log ${since}..HEAD\` is empty nothing changed`);
    expect(prompt).toContain("6. Re-check the earlier findings at HEAD.");
    expect(prompt).toContain("When step 5 found nothing changed");
    expect(prompt).toContain("7. Compile one merged report");
    expect(prompt).toContain("the new findings from step 5 plus every open earlier finding");
    expect(prompt).toContain("lists only the reviewers step 5 ran");
    expect(prompt).not.toMatch(/step [367]\b/u);
  });
});

describe("review depth", () => {
  it("hands the skill the depth chosen for a full review of either subject", () => {
    expect(reviewPrompt(localSubject(commit, "main"), ticket(), null, [], noIntent, "quick")).toContain("invoke the `code-review` skill at depth `quick` with the range `main...HEAD`");
    expect(reviewPrompt(prSubject(prTicket()), prTicket(), null, [], noIntent, "deep")).toContain("invoke the `code-review` skill at depth `deep` with the range `origin/$BASE...HEAD`");
  });

  it("reviews a re-review's new commits at the depth chosen and records it in the merged report", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "deep");
    expect(prompt).toContain(`invoke the \`code-review\` skill at depth \`deep\` with the range \`${since}..HEAD\``);
    expect(prompt).toContain('`"depth"` is `deep`');
  });

  it("hands a re-review's severity floor to the skill", () => {
    expect(reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "standard", {}, "important")).toContain(
      `invoke the \`code-review\` skill at depth \`standard\` with the severity floor \`important\`, the range \`${since}..HEAD\`, the pre-existing range`,
    );
  });
});

describe("review skill guard", () => {
  it("has every review stop with a fixed line, before any setup, when the skill the board parses is missing", () => {
    for (const prompt of [reviewPrompt(localSubject(commit, "main"), ticket(), null, [], noIntent, "standard"), reviewPrompt(prSubject(prTicket()), prTicket(), review(), [review()], noIntent, "standard")]) {
      expect(prompt).toContain(`check that \`~/.claude/skills/code-review/SKILL.md\` exists. If it doesn't, don't review with another skill or by hand: make your final message exactly \`${REVIEW_SKILL_MISSING}\``);
      expect(prompt.indexOf(REVIEW_SKILL_MISSING)).toBeLessThan(prompt.indexOf("Setup ("));
    }
  });
});

describe("card intent", () => {
  const described = { title: "Cache lookups", description: "Memoize `lookup` per request.\n\nNo eviction yet." };

  it("hands a full review of either subject the card's title, description and plan, and how to find its spec", () => {
    for (const prompt of [
      reviewPrompt(localSubject(commit, "main"), ticket(described), null, [], { plan: "1. Add a per-request map.", branch: "bb/cache-lookups" }, "standard"),
      reviewPrompt(prSubject(prTicket()), { ...prTicket(), ...described }, null, [], { plan: "1. Add a per-request map.", branch: null }, "standard"),
    ]) {
      expect(prompt).toContain("and the card's intent below");
      expect(prompt).toContain("## Card intent");
      expect(prompt).toContain("**Title:** Cache lookups");
      expect(prompt).toContain("Memoize `lookup` per request.\n\nNo eviction yet.");
      expect(prompt).toContain("**Approved plan:**\n\n1. Add a per-request map.");
      expect(prompt).toContain(".claude/features/");
    }
  });

  it("names the branch a spec directory would match: the card thread's, or the PR's head", () => {
    expect(reviewPrompt(localSubject(commit, "main"), ticket(), null, [], { plan: null, branch: "bb/cache-lookups" }, "standard")).toContain("matches the branch `bb/cache-lookups`");
    expect(reviewPrompt(prSubject(prTicket()), prTicket(), null, [], noIntent, "standard")).toContain("matches the branch `$HEAD_REF`");
    expect(reviewPrompt(localSubject(commit, "main"), ticket(), null, [], noIntent, "standard")).not.toContain("matches the branch");
  });

  it("says so when the card has no description or approved plan", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), null, [], noIntent, "standard");
    expect(prompt).toContain("**Description:** none");
    expect(prompt).toContain("**Approved plan:** none");
  });

  it("has a re-review hold fix commits to the findings they answer, and keeps a carried finding's triage", () => {
    const prompt = reviewPrompt(localSubject(commit, "main"), ticket(), review(), [review()], noIntent, "standard");
    expect(prompt).toContain("the card's intent below");
    expect(prompt).toContain("## Card intent");
    expect(prompt).toContain("each fix commit stays within the findings it answers");
    expect(prompt).toMatch(/category, class, triage and dispute unless/u);
  });
});

describe("apply prompt", () => {
  it("applies a local review as a new commit, records it by review id, and never pushes", () => {
    const prompt = localApplyPrompt(ticket(), review(), "- a.ts:1 fix me");
    expect(prompt).toContain("as a new commit on top of it.");
    expect(prompt).toContain("Do not amend or rewrite existing commits.");
    expect(prompt).toContain('`bb kanban review-applied --review r1 --commit "$(git rev-parse HEAD)"`');
    expect(prompt).toContain("Rules: do not push");
    expect(prompt).not.toMatch(/disposable|git fetch|git push|gh pr|--pushed|FETCH_HEAD/u);
  });

  it("fetches the PR head and pushes or stops at a local commit as asked", () => {
    const subject = prSubject(prTicket());
    const pushed = prApplyPrompt(subject, prTicket(), review({ subjectKind: "pr", headRef: "feature" }), true, "- a.ts:1 fix me");
    expect(pushed).toContain('git fetch origin "pull/7/head"');
    expect(pushed).toContain("git push origin HEAD:refs/heads/feature");
    const local = prApplyPrompt(subject, prTicket(), review({ subjectKind: "pr", headRef: "feature" }), false, "- a.ts:1 fix me");
    expect(local).toContain("Do NOT push.");
  });
});
