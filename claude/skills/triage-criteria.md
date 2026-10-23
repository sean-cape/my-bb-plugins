# Review triage criteria

The one written reference for deciding what to do with a code-review finding. Two places read it, so they judge scope the same way:

- the `code-review` skill's triage step, which decides every verified, introduced finding before the report is compiled;
- the `apply-review` skill's interactive triage (its Step 2), which proposes a scope to the user.

Every finding triaged gets exactly one decision, **apply**, **defer** or **drop**, and a one-sentence reason.

## What triage takes as given

- **Whether the finding is real.** In `code-review` the verifier has already scored it and filtered out false positives and speculation; triage never re-litigates that. (An `apply-review` run on a report that was not verified still does its own false-positive and speculation checks; those are not triage criteria.)
- **Pre-existing findings.** A problem that was already in the code before the change is not the change's to fix. It is never triaged and never applied; it can become a card of its own.

## Inputs

- The finding: severity, description, recommended fix, bug class and every instance.
- Its two 1–5 scores: **importance** (how much fixing it matters) and **scope fit** (how well the recommended fix stays inside what the change is already doing).
- The change's **intent**: what it was asked to do. For a board card, its title, description, approved plan and spec; otherwise what the user asked for, the commit messages, and the spec when there is one.
- The project's **conventions**: CLAUDE.md and AGENTS.md files, documented standards, and the established patterns in the code around the change.

## The decisions

### apply: fix it in this change

The default. A real finding whose fix belongs in this change is applied **whatever its severity**: nits, style issues and code smells included. Low importance alone never moves a finding off apply.

A scope finding (part of the change goes beyond its intent) is applied by removing the extra work or splitting it out, not by polishing it.

Reason: say briefly why the fix belongs here, e.g. "one-line guard in code the change adds".

### defer: real, but the wrong scope

The proper fix is a separate piece of work: a new feature, a new abstraction, a refactor beyond the change's purpose, or changes to code the change has no reason to touch. It becomes a follow-up card instead.

- **Low scope fit is the main signal.** Scope fit 1 almost always defers; 2 usually does. At 3, look closer: a small fix to nearby code is still apply.
- **Severity never blocks a deferral.** A critical finding whose proper fix is separate work is deferred. Its reason says that it is critical and names the separate work, so a person decides whether the change can land without it.
- Defer only when the problem can't be fixed properly inside the change. When a contained fix in code the change touches removes the problem, apply it, even if the same class of mistake also exists elsewhere.

Reason: name the separate work, e.g. "needs an idempotency layer for every writer; separate work".

### drop: not worth fixing, or against the project's way

Only two reasons justify a drop:

1. **Churn far out of proportion to the benefit.** The fix rewrites or reshapes much more code than the problem warrants: a large rewrite for a small gain. Importance is weighed here, against the size of the fix, and only here.
2. **A conflict with the project's conventions.** The fix asks for something the CLAUDE.md, AGENTS.md, documented standards or the established pattern in the surrounding code goes against. Name the convention.

When two findings contradict each other, apply the one that fits the change and its conventions, and drop the other as a conflict, naming the finding it conflicts with. (Interactive `apply-review` flags the pair for the user instead.)

Reason: state the churn against the benefit ("rewrites the 600-line parser to save one branch"), or quote the convention.

## Never a reason to drop

- Low priority, low importance, minor severity.
- Being a nit, a style issue or a code smell.
- "Could be done later", "unlikely to matter", "the author probably meant it".

An in-scope finding with a small fix is applied, however minor it is.
