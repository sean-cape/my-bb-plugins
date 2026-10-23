import type { Ticket } from "../../shared/board";
import type { FindingAnswer } from "../../shared/loop";
import type { PrReviewSubject, Review, ReviewDepth, ReviewSubject, SeverityFloor } from "../../shared/review";
import { finishSteps } from "../apply-steps";
import { earlierFindings, earlierNotCovered } from "./findings";

/** How a review prompt names its subject, gets the subject's code into the worktree, and what a full review covers. */
interface ReviewSetup {
  /** Completes "Run a full code review of …" and "Re-review …". */
  description: string;
  preamble: string;
  /** Unnumbered; the prompt numbers them, and a re-review's steps continue the count. */
  steps: string[];
  fullRange: string;
  /** Completes "so it reviews exactly …". */
  changesPhrase: string;
}

/** A review thread's whole final message when the skill the board parses isn't installed where it runs. */
export const REVIEW_SKILL_MISSING = "Review skill missing.";

/**
 * Claude Code ships a plugin skill also named code-review, whose report the board can't parse, so without this guard
 * a machine missing the user's skill reviews with that one and every round fails after spending a full review.
 */
const SKILL_GUARD = `This review needs the \`code-review\` skill installed at \`~/.claude/skills/code-review\`, whose report ends with a \`\`\`json review-findings block. Before anything else, check that \`~/.claude/skills/code-review/SKILL.md\` exists. If it doesn't, don't review with another skill or by hand: make your final message exactly \`${REVIEW_SKILL_MISSING}\` and stop.`;

const DISPOSABLE_WORKTREE = "Setup (this worktree is disposable; do not touch any other checkout).";
const LOCAL_SETUP = `${DISPOSABLE_WORKTREE} Worktrees of this project share one repository, so the commit is already here and nothing needs fetching.`;

/** Steps that check one commit of a card's work out detached in a fresh worktree: fetched from the PR, or already in the shared repository. */
export function commitCheckout(ticket: Ticket, commit: string): { preamble: string; steps: string[] } {
  if (ticket.pr === null) return { preamble: LOCAL_SETUP, steps: [`\`git checkout --detach ${commit}\``] };
  return {
    preamble: `${DISPOSABLE_WORKTREE} \`git fetch\` needs your GitHub credentials, which the sandbox hides; running it with the sandbox disabled is expected and authorized here, so do that rather than stopping to ask.`,
    steps: [`\`git fetch origin "pull/${ticket.pr.number}/head"\``, `\`git checkout --detach ${commit}\``],
  };
}

function reviewSetup(subject: ReviewSubject, ticket: Ticket): ReviewSetup {
  if (subject.kind === "pr") {
    const { repo, number, url } = subject;
    return {
      description: `pull request ${repo}#${number}: "${ticket.title}" (${url})`,
      preamble: `${DISPOSABLE_WORKTREE} The \`gh\` and \`git fetch\` steps need your GitHub credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here, so do that rather than stopping to ask.`,
      steps: [
        `\`BASE=$(gh pr view ${number} --repo ${repo} --json baseRefName --jq .baseRefName)\` and \`HEAD_REF=$(gh pr view ${number} --repo ${repo} --json headRefName --jq .headRefName)\``,
        `\`git fetch origin "$BASE" "pull/${number}/head"\``,
        "`git checkout --detach FETCH_HEAD`",
        '`bb kanban review-record --commit "$(git rev-parse HEAD)" --base "$BASE" --head "$HEAD_REF"` so the board knows which commit this review covers.',
      ],
      fullRange: "origin/$BASE...HEAD",
      changesPhrase: "the PR's changes",
    };
  }
  const { commit, defaultBranch } = subject;
  return {
    description: `the local work on "${ticket.title}" at commit ${commit}`,
    preamble: LOCAL_SETUP,
    steps: [
      `\`git checkout --detach ${commit}\``,
      `\`bb kanban review-record --commit "$(git rev-parse HEAD)" --base "${defaultBranch}"\` so the board knows which commit this review covers.`,
    ],
    fullRange: `${defaultBranch}...HEAD`,
    changesPhrase: `the commits since its merge base with \`${defaultBranch}\``,
  };
}

/** What the card asked for beyond its title and description; the review's scope finder holds the change to all of it. */
export interface CardIntent {
  /** The plan approved at the loop's plan gate; null while the card has none. */
  plan: string | null;
  /** The card thread's branch, which names the change's spec directory; a PR review matches the PR's head branch instead. */
  branch: string | null;
}

/**
 * The card's intent, for the scope finder and triage. The review checks its commit out detached, so the skill can't
 * find the spec from the checked-out branch; the prompt names the branch to match and the fallbacks.
 */
function intentSection(subject: ReviewSubject, ticket: Ticket, intent: CardIntent): string[] {
  const block = (label: string, text: string | null) =>
    text === null || text.trim() === "" ? [`**${label}:** none`, ""] : [`**${label}:**`, "", text.trim(), ""];
  const branch = subject.kind === "pr" ? "$HEAD_REF" : intent.branch;
  const candidates = [
    ...(branch === null ? [] : [`the one whose name matches the branch \`${branch}\` (ignoring prefixes such as \`bb/\`, \`feature/\` or \`fix/\`)`]),
    "one the title or description names",
    "the one whose files the change edits",
  ];
  return [
    "## Card intent",
    "",
    "What the card asked for. The `code-review` skill's scope finder flags any part of the change beyond it, and its triage defers findings whose proper fix falls outside it.",
    "",
    `**Title:** ${ticket.title}`,
    "",
    ...block("Description", ticket.description),
    ...block("Approved plan", intent.plan),
    `**Spec:** look under \`.claude/features/\` at HEAD for this work's feature directory: ${candidates.join(", else ")}. If one fits, pass its path to the skill as the spec; its \`spec.md\` and \`tickets/\` are part of the intent. If none fits, there is no spec.`,
  ];
}

/**
 * The code-review skill diffs `<default-branch>...HEAD` and its reviewers read whole files, so the subject's head has
 * to be checked out locally. The review runs in its own worktree and checks the head out detached, so it never
 * touches the branch checked out in the main project directory or the card's own environment.
 */
export function reviewPrompt(
  subject: ReviewSubject,
  ticket: Ticket,
  since: Review | null,
  standing: Review[],
  intent: CardIntent,
  depth: ReviewDepth,
  answers: Record<string, FindingAnswer> = {},
  severityFloor: SeverityFloor = null,
): string {
  const setup = reviewSetup(subject, ticket);
  const sinceSha = since?.commitSha ?? null;
  const range = sinceSha === null ? setup.fullRange : `${sinceSha}..HEAD`;
  return [
    sinceSha === null
      ? `Run a full code review of ${setup.description}.`
      : `Re-review ${setup.description}. The previous review covered commit ${sinceSha}. Review what changed since then, and re-check the earlier findings listed at the end of this prompt so every one still unaddressed carries forward into this review.`,
    "",
    SKILL_GUARD,
    "",
    setup.preamble,
    ...setup.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    ...(sinceSha === null
      ? [
          `Then invoke the \`code-review\` skill at depth \`${depth}\` with the range \`${range}\` (three-dot) and the card's intent below, so it reviews exactly ${setup.changesPhrase} and holds them to what the card asked for. Let it spawn every applicable reviewer in parallel, verify and triage their findings, and compile them in its standard format.`,
          "",
          "Your final message must be the code-review skill's compiled report verbatim, including its `Reviewed commit:` line and the trailing ```json review-findings block; it is persisted on the card and rendered from that JSON.",
        ]
      : incrementalSteps(range, setup.fullRange, setup.steps.length + 1, depth, severityFloor)),
    "Rules: do not change code, and do not post comments or reviews on GitHub; the compiled findings in this thread are the deliverable.",
    `This review belongs to kanban ticket ${ticket.id}.`,
    "",
    ...intentSection(subject, ticket, intent),
    ...(sinceSha === null ? [] : ["", ...earlierFindingsSection(standing, answers)]),
  ].join("\n");
}

/**
 * A re-review is only complete when it also says which earlier findings are still open, so the latest review alone
 * stands for the subject. Its findings are tagged pre-existing against the whole change, since lines an earlier commit
 * of the same change touched are outside the delta but still the change's own. The loop's later re-reviews set a
 * severity floor: a minor can't start a round there on its own, so they don't pay to find and verify one.
 */
function incrementalSteps(range: string, fullRange: string, reviewStep: number, depth: ReviewDepth, severityFloor: SeverityFloor): string[] {
  return [
    `${reviewStep}. Review the new commits. If \`git log ${range}\` is empty nothing changed, so skip this step. Otherwise invoke the \`code-review\` skill at depth \`${depth}\`${severityFloor === null ? " with" : ` with the severity floor \`${severityFloor}\`,`} the range \`${range}\`, the pre-existing range \`${fullRange}\` and the card's intent below, so a finding in lines this change touched in an earlier commit is not tagged pre-existing. Also give it the fix findings: the earlier findings below whose \`applyRound\` says an apply round committed a fix, which the new commits answer, so its scope finder checks each fix commit stays within the findings it answers. Let it spawn its reviewers, verify and triage their findings and compile them; that report is an intermediate result, not your final message.`,
    `${reviewStep + 1}. Re-check the earlier findings at HEAD. Spawn one general-purpose subagent with them and have it read the code at HEAD and classify each as addressed (the problem is gone at every instance) or open (some instance is still present; give the current locations of every one left, since lines may have moved). It also checks each earlier not-covered entry, if any, and says which a check at HEAD now covers. Changed lines or an apply round that targeted a finding do not make it addressed; only the code at HEAD does. When step ${reviewStep} found nothing changed, every earlier finding is open as listed and needs no check. An earlier finding whose \`answer\` is \`disputed\` was left unfixed on purpose: the card's thread gives its reason. Have the subagent judge that reason against the code at HEAD the way the skill's verifier judges a finding, and classify it disputed-accepted when the reason holds (the problem isn't real, or its fix falls outside the card's intent) or disputed-rejected when it doesn't, with a one-sentence note either way.`,
    `${reviewStep + 2}. Compile one merged report in the code-review skill's exact format (the markdown sections, the \`Reviewed commit:\` and \`Range:\` lines, and the trailing \`\`\`json review-findings block), with these additions:`,
    `   - \`findings\` holds the new findings from step ${reviewStep} plus every open earlier finding, merged into one where a new finding is the same problem as an earlier one, ordered by severity and renumbered \`F1\`, \`F2\`, ….`,
    '   - A carried finding keeps its earlier title, description, fix, severity, scores, confidence, verification, preExisting, flaggedBy, category, class, triage and dispute unless the new commits made them inaccurate, takes every instance still present at HEAD as its locations, and sets `"carriedFrom"` to its earlier handle; its markdown line ends with `(carried from <handle>)`. New findings set `"carriedFrom": null`. Points still open from an earlier free-form review become findings with `"carriedFrom"` set to that review\'s id, `"confidence": null`, `"preExisting": false` and `"suggestion": null`.',
    '   - Every finding keeps the `"suggestion"` field of the skill\'s format (`{ "file", "startLine", "endLine", "replacement" }` or null). A carried finding keeps its earlier suggestion only while it is still the right edit at HEAD, with `startLine` and `endLine` moved to where those lines are now; when the lines it replaces changed or the fix no longer fits them, set it to null (or to a new suggestion for the fix at HEAD).',
    '   - A disputed-rejected finding is carried like an open one, with `"dispute": { "reason": "<the thread\'s reason>", "outcome": "rejected", "note": "<why it doesn\'t hold>" }`; its markdown line ends with `(dispute rejected: <note>)`. Every other finding has `"dispute": null` unless it carries one forward.',
    `   - \`"filtered"\` holds only the findings step ${reviewStep} filtered out; earlier reviews' filtered findings are neither re-checked nor carried.`,
    `   - \`"notCovered"\` holds step ${reviewStep}'s list plus each earlier entry below that still holds at HEAD, once each.`,
    '   - Set `"carriesForward": true` and list each addressed earlier finding in `"resolved"` as `{ "id": "<handle>", "title": "<earlier title>", "note": "<how it was addressed>", "dispute": null }`, and each disputed-accepted one the same way with `"dispute": { "reason": "<the thread\'s reason>", "outcome": "accepted", "note": "<why it holds>" }`; in the markdown, list them under a `### Resolved since the last review` heading inside `## Review Findings`, an accepted dispute\'s line ending with `(disputed, accepted)`.',
    `   - \`"range"\` is \`${range}\`, \`"depth"\` is \`${depth}\`, and \`"reviewers"\` lists only the reviewers step ${reviewStep} ran (none when nothing changed).`,
    "",
    "Your final message must be that merged report, including its `Reviewed commit:` line and the trailing ```json review-findings block; it is persisted on the card, rendered from that JSON, and replaces the earlier reviews' findings on the board.",
  ];
}

function earlierFindingsSection(standing: Review[], answers: Record<string, FindingAnswer>): string[] {
  const findings = earlierFindings(standing, answers);
  const freeForm = standing.filter((review) => review.report === null && review.body !== null && review.body.trim() !== "");
  const notCovered = earlierNotCovered(standing);
  const notCoveredLines = notCovered.length === 0 ? [] : ["", "### Not covered by the earlier reviews", "", ...notCovered.map((entry) => `- ${entry}`)];
  const lines = ["## Earlier findings", ""];
  if (findings.length === 0 && freeForm.length === 0) return [...lines, "The earlier reviews left no open findings, so `resolved` is empty and every finding is new.", ...notCoveredLines];
  if (findings.length > 0) {
    lines.push(
      "Each is keyed by its `handle`; `applyRound` says what the board's apply round did with it, and `answer` is what the card's thread said of it in the last fix round (`fixed`, or `disputed` with its reason), when it was handed one.",
      "",
      "```json",
      JSON.stringify(findings, null, 2),
      "```",
    );
  }
  for (const review of freeForm) lines.push("", `### Free-form review ${review.id}`, "", review.body!.trim());
  return [...lines, ...notCoveredLines];
}

const APPLY_AS_GIVEN =
  "invoke the `apply-review` skill with the findings below. The user selected them on the Kanban board, so they are already triaged: apply every one as written, without a triage step, a confirmation, or dropping or reshaping any. Report any you could not apply and why.";
const SKIPPED_NOTE =
  "The board crosses off every finding handed to this round once it is recorded. If you could not apply some, add `--skipped <ids>` (comma-separated finding ids, e.g. `--skipped F2,F5`) to that command so they stay open.";

function applyDrift(review: Review): string {
  return review.commitSha === null
    ? "Note `git rev-parse HEAD`."
    : `The review was made against commit ${review.commitSha}. If \`git rev-parse HEAD\` differs, say so and check each finding still applies before fixing it.`;
}

function applyFooter(ticket: Ticket, review: Review, findingsBody: string): string[] {
  return [`This apply run belongs to kanban ticket ${ticket.id}, review ${review.id}.`, "", "## Review Findings (persisted)", "", findingsBody];
}

/**
 * A local review is applied by the card's own thread, which already has the commit checked out on its branch, so the
 * prompt sets nothing up. It names the review by id because the card's thread outlives any one review's apply round.
 */
export function localApplyPrompt(ticket: Ticket, review: Review, findingsBody: string): string {
  return [
    `Apply the persisted code review of your work on this card, "${ticket.title}", as a new commit on top of it.`,
    "",
    applyDrift(review),
    "",
    `Then ${APPLY_AS_GIVEN}`,
    "",
    "When the skill reports done and verification passed:",
    '1. Commit the fixes with `git commit -m "Apply code review findings"` (use a more specific message if the changes are narrow), leaving out any unrelated uncommitted work. Do not amend or rewrite existing commits.',
    `2. \`bb kanban review-applied --review ${review.id} --commit "$(git rev-parse HEAD)"\` so the board records the commit.`,
    SKIPPED_NOTE,
    "",
    "Rules: do not push, never post comments or reviews on GitHub, and report the result and any findings you could not apply.",
    ...applyFooter(ticket, review, findingsBody),
  ].join("\n");
}

/** A PR review is applied by a fresh thread that fetches the PR head, then pushes the fixes to its branch or stops at a local commit. */
export function prApplyPrompt(subject: PrReviewSubject, ticket: Ticket, review: Review, push: boolean, findingsBody: string): string {
  const { repo, number, url } = subject;
  const headRef = review.headRef ?? `$(gh pr view ${number} --repo ${repo} --json headRefName --jq .headRefName)`;
  return [
    `Apply the persisted code review to pull request ${repo}#${number}: "${ticket.title}" (${url})${push ? " and push the fixes to its branch" : " as a local commit in this worktree"}.`,
    "",
    "Setup (this worktree is disposable; do not touch any other checkout). `git fetch`, `git push`, and `gh` need your credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here.",
    `1. \`git fetch origin "pull/${number}/head"\` then \`git checkout --detach FETCH_HEAD\`.`,
    `2. ${applyDrift(review)}`,
    "",
    `Then ${APPLY_AS_GIVEN}`,
    "",
    ...finishSteps(push, headRef, "bb kanban review-applied", "Apply code review findings"),
    SKIPPED_NOTE,
    "",
    "Rules: never force-push, never post comments or reviews on GitHub, and report the result and any findings you could not apply.",
    ...applyFooter(ticket, review, findingsBody),
  ].join("\n");
}
