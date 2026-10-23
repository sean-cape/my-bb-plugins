---
name: apply-review
description: "Take the compiled output of the code-review skill (or an equivalent findings list) and apply the fixes. Applies a pre-selected set (such as the Kanban board's) as given, without re-triage or confirmation; otherwise triages findings and confirms scope with the user. Decides whether parallelization is actually worthwhile, and either dispatches parallel agents in file-disjoint waves or runs the work serially. Use after /code-review when the user wants the findings acted on."
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob
---

You are orchestrating the *application* of a code review. The review has already been produced (usually by the `code-review` skill). Your job is to triage the findings with the user, decide how to execute the work, dispatch agents (or a single agent) to implement, and report back. You do NOT fix code yourself — you orchestrate.

## Step 1: Gather the findings

Locate the review to act on, in priority order:

1. Findings the user pasted into this turn. If the pasted report says which findings were selected (for example a "Selected findings" heading, or a JSON block containing only a subset), the user has already triaged: the selected findings are the scope, and the unselected ones are out of it. Do not propose or re-open the unselected ones unless the user asks, and follow **Pre-selected findings** below instead of Step 2.
2. The most recent compiled review output in the conversation (the `## Review Findings` block from the `code-review` skill).
3. If nothing is available, ask the user to paste the review or re-run `/code-review` first. Do not guess.

If the review ends with a fenced ```` ```json review-findings ```` block (the `code-review` skill's machine-readable report), parse that JSON and use its `findings` as the records — their `id`s (`F1`, `F2`, …) are the handles to use when talking to the user. Otherwise parse each finding into a structured record: `{severity, file, location, description, recommended_fix, flagged_by}`. If a finding spans multiple files, record *all* files it touches — this matters for partitioning later.

**Pre-existing findings are never applied.** A finding with `"preExisting": true` (or whose markdown line ends with `(pre-existing)`) was already in the code before the change under review, so it is not this change's to fix. Leave it out of the work set on every path, pre-selected ones included, and list it under Follow-ups as left alone because it is pre-existing, recommending a card of its own.

### Pre-selected findings

When the findings arrive pre-selected (the Kanban board's apply button hands them over this way), skip Step 2 entirely and go straight to Step 3. Do not present a triage, do not ask for a go-ahead, and do not recommend skipping or ask the user to decide anything. Apply every selected finding as written:

- **Do not narrow scope.** Do not drop a finding because you judge it a false positive, speculative, low value, or out of scope, or because the review's triage deferred or dropped it. The user read it and chose it.
- **Do not reshape findings.** Implement each one's recommended fix as stated. When findings overlap (two touch the same code, or one restructures what another changes), implement all of them together in a way that satisfies each; do not fold one into another's design or swap in an alternative you prefer.
- **Investigation findings get investigated.** A finding that asks you to check or confirm something ("confirm the backend returns X, and if not, fetch it another way") is applied by doing the check, then making the change it calls for if the check fails. Report what you found either way.
- **Only reality can stop a finding.** If the cited code no longer exists, the fix contradicts another selected finding, or an agent cannot make it work, apply everything else and report that finding under Follow-ups with the concrete reason. Never stop to ask mid-run.

## Step 2: Triage the findings holistically and confirm scope with the user

Before planning anything, read the findings as a set and form an opinion. You are not a rubber stamp for the reviewers — some findings deserve to be dropped.

Read `~/.claude/skills/triage-criteria.md` first. It is the written reference for "wrong scope", "low value vs. churn" and "conflicts with project conventions" below, shared with the `code-review` skill's triage step so the two judge scope the same way. Where this step and the criteria differ, the criteria win.

When findings carry a `triage` decision (from the `code-review` skill), start from it: `apply` goes under "Proposed to apply"; `defer` and `drop` go under "Recommend skipping", with the triage reason as the why (a deferred one is separate work, so suggest it as a follow-up). Your spot-checks can still move one when the criteria point elsewhere; say why.

When findings carry `importance` and `scopeFit` scores (1–5, from the `code-review` skill), use them as inputs: low `scopeFit` (≤ 2) is the signal for "wrong scope" below, and `importance` is weighed against the size of the fix for "low value vs. churn", never on its own: low priority alone is no reason to skip. They are inputs, not verdicts.

Consider every finding regardless of severity. **Do not filter by severity by default** — a well-argued Minor finding can be worth applying, and a weak Critical finding can be worth skipping. Severity is an input to your judgment, not a gate.

Flag for the user any finding that matches one of these:

- **Disagrees with another finding.** Two reviewers contradict each other (e.g., style says "extract helper", correctness says "inline it for clarity") — the user has to pick.
- **Wrong scope.** Asks for a refactor, abstraction, or feature that goes beyond the change under review (the criteria's defer).
- **Speculative.** "This might be a problem if…" without a concrete failure mode.
- **Likely false positive.** Reviewer misread the code, missed context (e.g., flagged a test helper as production-critical), or cites behavior that doesn't match the actual file.
- **Low value vs. churn.** The fix is large and the benefit is marginal — worth asking before spending the edits (the criteria's first drop reason).
- **Conflicts with project conventions** you can see in CLAUDE.md, nearby code, or memory (the criteria's second drop reason).

Spot-check the suspicious ones by reading the cited file/lines yourself (Read/Grep) so your recommendation is grounded, not guessed.

Then present a **scope confirmation** to the user in this shape, and stop for their reply:

```
## Apply Review — Triage

Proposed to apply (N findings):
- [sev] file:loc — short description
- ...

Recommend skipping (M findings):
- [sev] file:loc — short description
  Why skip: <one-line reason>
- ...

Flagged for your call (K findings):
- [sev] file:loc — short description
  Concern: <what's ambiguous or contested>
- ...

Reply with any to add back, drop, or edit. Say "go" to proceed with the proposed set.
```

Do not move to Step 3 until the user responds. If they say "go" with no changes, use the proposed set. If they edit the list, apply their edits and re-show only if the changes are substantial.

Skip this confirmation when the findings were pre-selected (see Step 1) or the user has explicitly said "just apply all of it, don't ask" up front; in both cases apply every finding without dropping any. Otherwise always ask.

If after triage there is nothing left to do, say so and stop.

## Step 3: Decide the execution shape — serial or parallel

Parallelization only pays off when the orchestration overhead is smaller than the wall-time savings. Default to **serial** (one agent doing everything in order) unless parallel is clearly worth it.

Go **serial** when any of these hold:

- ≤3 findings total, or total estimated work is small.
- All findings touch the same file or a tight cluster of files (file-disjoint partitioning would yield one group anyway).
- Findings are interleaved in ways that make clean wave ordering awkward — one agent making the full set of changes in sequence will be faster and safer than multi-wave choreography.
- Findings require global reasoning (e.g., a subtle refactor whose shape depends on understanding all the call sites together) — splitting across agents loses context.

Go **parallel** when:

- Findings naturally partition into ≥2 file-disjoint groups of non-trivial size.
- The groups don't meaningfully depend on each other's outputs.
- Wall time matters to the user (long builds/tests per group, large diff).

State your decision in one line — "Going serial: all findings cluster in 2 files" or "Going parallel: 3 disjoint groups across storage, handlers, and tests" — then proceed. Do not ask; scope is already settled.

## Step 4 (parallel only): Partition into file-disjoint groups

Skip this step if you chose serial.

The hard constraint: **within a single wave, no two agents may touch the same file**. Concurrent edits to the same file corrupt each other.

Build groups with a union-find over findings: two findings belong to the same group if they share any file. The result is a set of groups where each group's file set is disjoint from every other group's.

Heuristics on top of the base algorithm:

- **Keep groups reasonably sized.** If one group balloons to >8 findings or spans many files, consider whether it can be broken into sequential waves rather than run as one giant task.
- **Keep groups reasonably few.** If you end up with >6 tiny single-finding groups, merge small adjacent groups (still respecting file disjointness) so you don't spawn excessive agents.
- **Co-locate tightly coupled fixes.** If two findings touch *different* files but are obviously the same change (e.g., "rename symbol X" across files A and B), they must go in the same group — splitting would have one agent break the build for the other.

If partitioning collapses to a single group, reconsider — serial execution may be cleaner. Don't spawn one agent in parallel mode.

## Step 5 (parallel only): Decide waves

Most reviews can be done in a single wave. Use multiple waves when fixes have an ordering dependency:

- **Signature/API changes before callers.** If one finding changes a function signature or type, and others update its callers, do the signature change in wave 1 and caller updates in wave 2.
- **Schema/migration before code.** Storage-layer fixes (new column, renamed query) must land before code that uses them.
- **Shared-helper introductions.** If one finding is "extract helper Y" and others are "use helper Y", split across waves.

If no such dependency exists, use one wave. Prefer fewer waves — imaginary dependencies waste wall time.

Show the plan (groups × waves) to the user as a short preview — one sentence per group — then proceed. No second confirmation unless partitioning is genuinely ambiguous.

## Step 6: Write a todo file per unit of work

Write markdown todo files to a fresh working directory:

```
/tmp/apply-review-<timestamp>/<filename>.md
```

- Serial: one file, e.g. `serial.md`.
- Parallel: one per group, e.g. `wave-<N>-group-<M>.md`.

Each file contains:

- Scope: the exact files this agent is allowed to modify, with a warning to touch nothing else. (Serial: all in-scope files.)
- Wave number (parallel only), so the agent knows what state to expect.
- An ordered checklist of findings: severity, file:location, description, recommended fix, flagged-by source.
- A "When done" section: run the relevant build/test/lint for the touched files and report back whether it passed.

Keep the file self-contained — the dispatched agent will not see this conversation.

## Step 7: Dispatch

**Serial mode:** one `Agent` call with `subagent_type: "general-purpose"` (or `implementer` if preferred), pointing at the todo file.

**Parallel mode:** for each wave, send a **single message** containing one `Agent` tool call per group in that wave so they run concurrently. Pass each agent:

- The absolute path to its todo file.
- The list of files it is permitted to modify.
- A hard instruction: *do not modify files outside the allowed list; if a fix seems to require it, stop and report back instead of editing.*
- Instruction to run the appropriate verification (build, targeted tests, LSP diagnostics) for the files touched before reporting done.

In parallel mode, wait for every agent in a wave to finish before starting the next. If any failed or bailed out, surface that to the user before launching the next wave — do not paper over it.

## Step 8: Compile the outcome

```
## Apply Review — Summary

Mode: <serial | parallel, N waves>
Findings addressed: <X of Y>   (skipped per triage: <Z>)

<Per-group or single-agent status lines>

### Follow-ups
- [file:location] Finding not applied because <reason> — recommend <next step>
```

Surface verification output worth knowing about (failing tests, lint errors an agent couldn't resolve). If everything succeeded cleanly, keep it tight — the user can read the diff.

## Rules

- You do NOT edit code yourself. You triage, partition, write todo files, dispatch, and compile.
- Pre-selected findings are applied as given: no triage, no confirmation, no dropping or reshaping findings.
- Pre-existing findings are never applied, on any path; they are listed under Follow-ups.
- Interactive triage follows `~/.claude/skills/triage-criteria.md`, the same criteria the `code-review` skill triages by.
- Otherwise always run Step 2 triage and wait for user confirmation before planning, unless the user explicitly opted out.
- Default to serial; choose parallel only when it clearly pays off.
- In parallel mode: file disjointness within a wave is a hard invariant, groups run in one message per wave, waves run strictly sequentially.
- If an agent reports it could not finish a finding (ambiguous fix, needed to touch a disallowed file, unresolved test failure), surface it in the final report rather than retrying blindly.
