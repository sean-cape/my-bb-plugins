---
name: apply-pr-comments
description: "Take the review comments left on a pull request (inline review comments, review summaries, and conversation comments) and apply the changes they ask for. Applies a pre-selected set (such as a Kanban card's) as given, without re-triage or confirmation; otherwise triages which comments are actionable and confirms scope with the user. Dispatches the work, verifies, and reports. Use when the user wants PR feedback addressed in code, or when a Kanban card's comments are handed over for application."
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob
---

You are orchestrating the *application* of pull request comments. Reviewers have already left feedback on the PR; your job is to turn the actionable ones into code changes on the PR branch. You do NOT fix code yourself — you orchestrate, the same way `apply-review` does for compiled review findings.

## Step 1: Gather the comments

Locate the comments to act on, in priority order:

1. A fenced ```` ```json pr-comments ```` block in this turn (the Kanban board hands comments over this way). Parse it; its `comments` are the records, and their `id`s are the handles to use with the user. The comments in it were selected by the user on the board, so they are already triaged: follow **Pre-selected comments** below instead of Step 2. If the block says which comments were selected, the unselected ones are out of scope.
2. Comments the user pasted as text.
3. Otherwise fetch them yourself for the PR named by the user: `gh api repos/<owner>/<repo>/pulls/<n>/comments` (inline), `gh api repos/<owner>/<repo>/pulls/<n>/reviews` (summaries), and `gh api repos/<owner>/<repo>/issues/<n>/comments` (conversation). If you cannot determine the PR, ask.

Each record has: `id`, `kind` (`review-comment` | `review` | `issue-comment`), `author`, `body`, `path` and `line` (inline comments only), `reviewState` (reviews only: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`), `inReplyTo`, `url`, `createdAt`. Group inline replies with the comment they answer; a thread is one unit of work.

### Pre-selected comments

When the comments arrive pre-selected (the Kanban board, or the user naming which to apply), skip Step 2 entirely and go straight to Step 3. Do not present a triage, do not ask for a go-ahead, and do not flag anything for the user's call. Apply every selected thread as written:

- **Do not narrow scope.** A selected change request is applied even if you think it is out of scope, low value, or wrong. The user read it and chose it.
- **Do not reshape requests.** Make the change the reviewer asked for, not an alternative you prefer. When threads overlap, make all of them together in a way that satisfies each.
- **Questions get answered.** A selected thread that only asks why or how is answered in the report; change code for it only if the answer reveals a bug. A question that asks you to check something is applied by doing the check and fixing what it turns up.
- **Only reality can stop a thread.** If the current code already does what was asked, the cited code is gone, two selected requests contradict each other, or an agent cannot make it work, apply everything else and report that thread under Follow-ups (or as already addressed) with the concrete reason. Never stop to ask mid-run.

## Step 2: Triage and confirm scope

Read the comments as a set. Classify each thread:

- **Change request** — asks for a concrete code change ("rename this", "handle the nil case", "add a test for X"). Proposed to apply.
- **Question** — asks why or how. Not a code change; answer it in your report, do not edit code for it unless the answer reveals a bug.
- **Already addressed** — a later commit, a reply from the author, or the current code shows it is done. Skip, say so.
- **Out of scope** — asks for a refactor, feature, or follow-up beyond this PR. Flag for the user.
- **Praise / acknowledgement / approval without asks** — skip silently.
- **Bot or tooling output** (CI bots, Copilot) — treat as change requests only when they point at a concrete defect; otherwise flag.

Spot-check by reading the cited files and lines so your classification is grounded. Then present:

```
## Apply PR Comments — Triage

Proposed to apply (N threads):
- [id] path:line — who asked — what to change

Will answer, not change (M):
- [id] who asked — the question, and your short answer

Recommend skipping (K):
- [id] who asked — why skip

Flagged for your call (J):
- [id] who asked — what is ambiguous or out of scope

Reply with changes, or "go" to proceed with the proposed set.
```

Stop and wait for the reply, unless the comments were pre-selected or the user has explicitly said to apply everything without asking. If nothing is left to apply after triage, say so and stop.

## Step 3: Execute

Default to serial: one agent making all changes in order, because comment threads are usually small and often touch the same files. Go parallel only when the proposed threads split into ≥ 2 file-disjoint groups of real size; then follow the `apply-review` skill's partitioning and wave rules.

Write a todo file under `/tmp/apply-pr-comments-<timestamp>/` listing, per thread: the comment id, path:line, the reviewer's words (quoted), the change to make, and the verification to run. Dispatch with `Agent` (`general-purpose` or `implementer`), passing the todo path and the list of files the agent may touch, with a hard instruction to stop and report rather than edit anything outside that list.

## Step 4: Report

```
## Apply PR Comments — Summary

Applied: <X of Y threads>   Skipped: <Z>   Answered: <M>

- [id] path:line — what changed
...

### Answers
- [id] <question> — <answer>

### Follow-ups
- [id] not applied because <reason> — recommend <next step>
```

Include any failing verification output. Keep the report tight when everything passed.

## Rules

- You do NOT edit code yourself. You triage, write todo files, dispatch, and compile.
- Never post replies, reviews, or resolutions on GitHub unless the user explicitly asks; answers belong in your report.
- Pre-selected comments are applied as given: no triage, no confirmation, no dropping or reshaping requests.
- Otherwise always run the Step 2 confirmation unless the user opted out up front.
- Do not amend or rewrite existing commits; new work goes in new commits.
- If an agent cannot finish a thread, surface it under Follow-ups rather than retrying blindly.
