---
name: code-review
description: "Run a strict code quality review of a change: one reviewer agent audits it for maintainability, abstraction quality, spaghetti growth, file sprawl, boundary and type cleanliness, and ambitious structural simplifications (code-judo moves), while holding it to its intent and the project's CLAUDE.md; one verifier agent then scores every finding for being real, and the findings are triaged apply, defer or drop before they are reported in the board's format. A depth of quick, standard or deep sets how hard the agents reason. Use when finishing an implementation or when the user asks for a code review."
allowed-tools: Agent, Bash, Read
---

You orchestrate a strict code quality review. You gather the diff, hand it to one reviewer agent, have one verifier agent check its findings, triage the verified ones, and compile the report. You do not review or verify code yourself, and neither you nor the agents change any code.

## Step 1: Gather the inputs

**The diff.** If the caller specified branches or a commit range, use that. Otherwise find the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, stripping `origin/`; fall back to `main` or `master`) and use `git diff <default-branch>...HEAD` (three-dot). If that is empty, try `git diff` for uncommitted changes; if both are empty and the intended diff is unclear, ask the user. Also get the file list (`git diff --name-only` on the same range) and the commit list (`git log --format='%h %s' <range>`).

**Generated files** (a `Code generated … DO NOT EDIT` or `@generated` header, `*.pb.go`, `*.gen.go`, mocks, lockfiles, `vendor/`, `dist/`, `build/`, minified bundles) are not reviewed: re-run the diff with `-- ':(exclude)<path>'` for each, and list them as `skippedFiles`. Read a file's first lines when unsure. Skip this if the user asks to include them.

**The pre-existing range**: the range findings are checked against to tell the change's own problems from ones that were already there. It is the review range unless the caller names a separate one (a re-review of the newest commits on a longer change passes the whole change's range).

**The intent**: what the change was asked to do. When the caller gives it (a Kanban card's title, description, approved plan and spec), use it as given. Otherwise take it from the conversation and the commit messages. A spec is part of the intent: the caller names its directory, or a branch (the caller's, else `git rev-parse --abbrev-ref HEAD`) matches a directory under `.claude/features/` in kebab-case ignoring prefixes such as `bb/`, `feature/`, `fix/`, or the diff edits files under exactly one `.claude/features/<feature>/`. Note its path when found.

**The depth**: `quick`, `standard` or `deep` (the capitalized words mean the same); `standard` when none is named. It sets the reasoning effort of both agents and nothing else:

| Depth | Agent effort |
| --- | --- |
| `quick` | `medium` |
| `standard` | `high` |
| `deep` | `xhigh` |

**The severity floor**, when the caller names one. Floor `important` means only critical and important findings are reported: a caller sets it on a re-review of fix commits, where a new minor finding would not start another fix round.

**The fix findings**, when the caller names them: earlier findings the new commits in the range were made to fix. The reviewer checks each fix commit stays within the findings it answers. A finding the fixing agent disputed instead of fixing is not a fix finding.

Put flags at the end of git commands per project conventions.

## Step 2: Spawn the reviewer

Spawn one `general-purpose` agent (not a fork: a fork ignores effort) with `effort` set from the depth table. Its prompt holds:

- The instruction to read `~/.claude/skills/code-review/reviewer.md` first and review by it, making no changes.
- The review range and the pre-existing range as literal refs or shas (the agent's shell has none of your variables), the changed files, and the complete diff.
- The intent in full, the spec directory's path if any, and the fix findings if any (each with its handle, title, fix and locations).
- The paths of the CLAUDE.md and AGENTS.md files that apply: the repository root's and any in a directory holding a changed file.
- The severity floor, when set.

It reports its findings in the shape `reviewer.md` describes, ending with a `Not covered` list.

## Step 3: Spawn the verifier

Number the reviewer's findings `C1`, `C2`, … as candidates. Keep every one, nits, smells and hedged "possibly" items included: the verifier decides what holds up, and what does not lands in the filtered list. With the severity floor `important`, drop minor candidates here instead; they are neither verified nor reported, and the Change Summary says how many the floor left out.

Spawn one `general-purpose` agent with the same `effort`, whose prompt holds:

- The instruction to read `~/.claude/skills/code-review/verifier.md` first and judge by it, making no changes, ending with only the JSON verdict.
- Every candidate in full with its `C` number.
- The review range, the pre-existing range, and the **base**: `git merge-base` of the pre-existing range, as a literal sha.
- The applicable CLAUDE.md and AGENTS.md paths, and for `scope` candidates the intent, spec path and fix findings.

More than fifteen candidates: split them into groups of at most fifteen by the file of their first location and spawn one verifier per group in one message.

Then sort: confidence ≥ 80 becomes a report finding, with `preExisting` as the verifier decided; below 80 goes to the filtered list, kept so a reader can check the filter. Drop from a finding any location the verifier's sentence says does not hold. You do not override a verdict. If the verifier fails or leaves candidates without one, spawn one more verifier for those; a candidate still without a verdict is **unverified**: it stays in its severity section with `"confidence": null`, `"preExisting": false`, `"verification": null`, the word `unverified` where its line would show the confidence, and a note in the Change Summary.

## Step 4: Score and triage

Give every reported finding two independent 1–5 scores:
- **importance**: how much it matters that this is fixed before merge. 5: data loss, security hole, wrong behavior on a common path, or a structural regression the codebase will pay for in every later change. 4: a real bug on a plausible path, or a blocker-grade quality problem (an unnecessary layer, spaghetti in a shared flow, a file sprawled past 1k lines). 3: worth fixing, limited blast radius. 2: polish with some value. 1: cosmetic or debatable.
- **scope** (scope fit): how well the recommended fix stays inside what this change is already doing. 5: a local edit to code the change touches. 4: a small addition in the same files. 3: nearby code the change did not touch, or a modest new behavior. 2: a new abstraction or refactor beyond the change's purpose. 1: a different piece of work entirely.

Score them independently: a code-judo restructuring can be importance 5 and scope 2. A pre-existing finding's fix is usually scope 1 or 2. Filtered findings may leave both null.

Then **triage** every verified, introduced finding (confidence ≥ 80, `preExisting: false`) by `~/.claude/skills/triage-criteria.md`, read in full: each gets `apply`, `defer` or `drop` with a one-sentence reason. Apply is the default whatever the severity; a `scope` finding is applied by removing or splitting out the extra work; defer is for a fix that is separate work (low scope fit is the signal, and a critical finding is still deferred when its proper fix is separate work, its reason saying so); drop is only for churn far out of proportion to the benefit, or a conflict with the project's conventions. Judge the findings as a set with the intent in mind; when a fix's churn is unclear, read the code it would change. Pre-existing, filtered and unverified findings have `triage: null`.

## Step 5: Compile the report

Compile ONE report in exactly this shape. Tools (the Kanban board, `apply-review`) parse it, so keep the headings, the finding line format, and the trailing JSON block exactly as specified.

```
## Change Summary
[2-3 sentences describing what changed. Name the depth and any severity floor, and mention skipped generated files here.]

## Review Findings

### Critical (Must Fix)
- **F1** (importance 5, scope 2, confidence 90) `path/to/flow.ts:120-134`, `path/to/flow.ts:210-222` — Short title. Description of the problem — recommended fix (class: special case in shared flow) (triage: defer — critical, but the proper fix is a policy object every caller shares; separate work) (flagged by: quality)
- **F2** (importance 4, scope 5, confidence 100) `path/to/panel.tsx` — Short title. Description — recommended fix (class: file past 1k lines) (triage: apply — split the new section into its own module) (flagged by: quality)

### Important (Should Fix)
- **F3** (importance 4, scope 4, confidence 85) `path/to/api.ts:42` — Short title. Description — recommended fix (class: pass-through wrapper) (triage: apply — delete the wrapper in code the change adds) (flagged by: quality)
- **F4** (importance 3, scope 5, confidence 90) `path/to/cache.go:10-80` — Short title. Hunks beyond the intent — remove them, or split them into a separate change (class: unrequested refactor) (triage: apply — remove the extra work) (flagged by: quality)
- **F5** (importance 4, scope 1, confidence 90) `path/to/old.go:88` — Short title. Description — recommended fix (class: missing nil check) (flagged by: quality) (pre-existing)

### Minor (Nice to Fix)
- **F6** (importance 2, scope 5, confidence 95) `path/to/other.go` — Short title. Description — recommended fix (class: magic number) (triage: apply — named constant in touched code) (flagged by: quality)

### Filtered (Confidence Below 80)
- **X1** (confidence 25) `path/to/file.go:60` — Short title. Verifier: what it checked and found (class: off-by-one) (flagged by: quality)

## Not Covered
- Untested: the retry branch in `path/to/client.go` when the server times out
- UI only: the new empty state in `path/to/panel.tsx`

Reviewed commit: <full 40-char sha of HEAD, from `git rev-parse HEAD`>
Range: <the diff range reviewed, e.g. origin/main...HEAD>
Depth: <quick, standard or deep, from Step 1>

```json review-findings
{ ...the same report as JSON, schema below... }
```
```

Rules for the markdown part:
- Finding ids are `F1`, `F2`, … in order of appearance; they are stable handles for `apply-review` and the board. Filtered findings are numbered apart, `X1`, `X2`, …, so the `F` ids stay dense.
- `file:location` is a repo-relative path, optionally with `:line` or `:start-end`. One finding may list several locations separated by `, `: each is an instance of its class, and the first is the primary one.
- Every finding's line names its class as `(class: <name>)`, then a triaged finding's decision and reason as `(triage: <apply|defer|drop> — <reason>)`, just before `(flagged by: quality)`. Pre-existing, filtered and unverified findings have no triage part.
- Omit empty severity sections, and the Filtered section when nothing was filtered. If no finding passed verification, write `No findings.` under `## Review Findings` (before any Filtered section).
- A pre-existing finding sits in its severity section like any other, and its line ends with `(pre-existing)`.
- Findings of category `style` always sit under Minor; the reviewer's severity decides the rest.
- `## Not Covered` always appears, after the findings and before `Reviewed commit:`, with the reviewer's not-covered list, one entry per line. When the list is empty, write `Nothing: the checks and the review covered the whole change.` under it.
- Every verified finding's parentheses carry its `confidence` after importance and scope; an unverified one says `unverified` there instead. A filtered finding's line carries only its confidence, and its verification takes the place of the fix.

The trailing fenced block has the info string `json review-findings` and contains a single JSON object with this schema (no comments, no trailing commas, valid JSON):

```
{
  "version": 6,
  "summary": "<the Change Summary text>",
  "commit": "<full sha or null>",
  "range": "<diff range or null>",
  "depth": "quick" | "standard" | "deep",
  "reviewers": ["quality"],
  "skippedReviewers": [],
  "skippedFiles": ["path/generated.pb.go"],
  "findings": [
    {
      "id": "F1",
      "severity": "critical" | "important" | "minor",
      "title": "<short title, ≤ 80 chars>",
      "description": "<what is wrong and why it matters>",
      "fix": "<recommended fix, or null>",
      "locations": [{ "file": "path/to/file.go", "startLine": 120, "endLine": 134 }],
      "flaggedBy": ["quality"],
      "category": "structure" | "boundary" | "scope" | "claude-md" | "correctness" | "style",
      "importance": 1 | 2 | 3 | 4 | 5,
      "scopeFit": 1 | 2 | 3 | 4 | 5,
      "confidence": 0-100 | null,
      "preExisting": true | false,
      "verification": "<the verifier's one sentence>" | null,
      "class": "<the class's short name>",
      "triage": { "decision": "apply" | "defer" | "drop", "reason": "<one sentence>" } | null,
      "suggestion": { "file": "path/to/file.go", "startLine": 120, "endLine": 122, "replacement": "<exact new text of those lines>" } | null,
      "dispute": null
    }
  ],
  "filtered": [
    { ...the same finding fields, with "id": "X1", "confidence" below 80, "importance"/"scopeFit" possibly null and "triage": null... }
  ],
  "notCovered": ["Untested: the retry branch in `path/to/client.go` when the server times out", "UI only: the new empty state in `path/to/panel.tsx`"]
}
```

`depth` is the depth from Step 1, the same as the `Depth:` line. `importance` and `scopeFit` are Step 4's scores (the markdown writes them as `importance N, scope N`); `triage` is Step 4's decision for every verified, introduced finding and null otherwise. `confidence`, `preExisting` and `verification` are the verifier's verdict, copied as given; only an unverified finding has `"confidence": null`, and it always has `"preExisting": false`. `startLine`/`endLine` are integers, or null for a whole-file finding. `locations` lists every instance of the finding's `class`. `category` is the reviewer's. `suggestion` is the reviewer's exact edit, for the diff view to show as a GitHub-style suggested change and apply in one keystroke: `startLine`/`endLine` are the inclusive 1-based new-side lines replaced and `replacement` their new text, lines joined by `\n`, no trailing newline (an empty string deletes the lines); null when the reviewer gave none, and always null for filtered and pre-existing findings. `notCovered` is the Not Covered section's entries as strings, `[]` when it says nothing. `dispute` is always null in this skill's own report: a caller re-reviewing a fix round sets it. The JSON must list the same findings, in the same order and with the same ids, as the markdown, with `filtered` holding the Filtered section's. Put the JSON block last; nothing follows it.

## Rules

- You do NOT review or verify code yourself. You orchestrate, triage and compile; the reviewer finds, the verifier decides each finding's confidence and whether it is pre-existing.
- Neither you nor the agents make code changes. Report only. (A finding's `suggestion` describes an edit; it is not one.)
- The depth sets only the agents' effort: every depth reviews, verifies and triages the same way.
- Every finding is verified, whatever its severity, and every one is either reported or filtered, never left out; the one exception is a minor candidate under the severity floor `important`. Findings triage defers or drops stay in the report with their decision.
- Triage follows `~/.claude/skills/triage-criteria.md`. Low priority alone is never a reason to drop.
