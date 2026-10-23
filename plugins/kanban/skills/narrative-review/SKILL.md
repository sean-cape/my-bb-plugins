---
name: narrative-review
description: Write a narrative code review of a diff. This is an ordered walk through the change in steps. Each step explains a group of lines and why they exist, with mermaid diagrams where structure or flow needs a picture. Every changed line appears in at least one step. When the code has moved on since an earlier narrative, the review adds a revision chapter that explains the delta and why it was made. Use when a kanban narrative thread asks for a narrative review or tour, or when the user asks for a narrative, guided, or story-style walkthrough of a change.
---

# Narrative code review

A narrative review is read one step at a time, like a guided tour. Each step pairs
your explanation with the exact lines it talks about. The reader sees only those
lines and your words, so the steps must tell the change as a story: they say what
the change is for and how its parts fit, then cover the details.

## The contract

1. **Exhaustive.** Every added line (new side) and every deleted line (old side) of
   the diff is in at least one step's `refs`. The board checks this and shows the
   reader any line you missed in a step marked "Not narrated", so gaps are visible.
2. **Lines may repeat.** If a line matters to two parts of the story, reference it
   in both. For example, a call site can appear in the API step and again in the
   error-handling step. Repeating lines is encouraged when it helps the reader.
3. **Read-only.** Never change code, commit, push, or post to GitHub.

## Process

1. Read the whole diff and the code around it before writing anything. Use
   `git grep` to find call sites and read the tests. Know what the change is for
   before you decide how to tell it.
2. Plan the story arc. A good order is usually:
   - **Why**: the entry point or the user-visible behavior.
   - **Shape**: new types, schemas, data model or interfaces.
   - **Flow**: the main path through the new logic, in call order.
   - **Edges**: error paths, concurrency, migrations, security-sensitive code.
   - **Tests**: what they prove and what they leave out.
   - **Mechanical**: renames, wiring, generated files and lockfiles, grouped into
     one or two short steps at the end.
3. Write the steps (see the step sections below).
4. Simplify the narration with the `asd-ste100` skill (see Plain English below).
5. Check coverage: `bb kanban narrative-check --report-file narrative.json`.
   It lists every uncovered range with its lines, and any path that isn't in the
   diff. Fix them and re-run until it passes. Write the file in your scratch
   space, not in the repository.
6. End your final message with the JSON in the fenced block your prompt names.

## Writing a step

- **One idea per step.** A step usually covers 5–60 changed lines. Split a large
  hunk across several steps when it does several things. Merge tiny related
  edits across files into one step when they make one point: "the three call
  sites switch to the new signature."
- **`title`**: a short claim, not a file name. Write "The retry delay
  doubles up to a 30s cap", not "client.go".
- **`body`**: Markdown, as short as it can be while saying everything a
  reviewer needs: usually 30–120 words plus any diagram. Say what the lines do
  and why they're there, how they connect to earlier steps, and what to check
  closely: invariants, failure modes, anything surprising. Don't paraphrase the
  code line by line, and don't restate what the title or an earlier step
  already said. The reader sees the lines next to your text.
- **Shape the body for scanning**, not as one block of prose. Open with one
  sentence on what the step does and how it follows from the earlier steps.
  Then put the details in bullets, one point per bullet, each a single sentence
  with a bold lead-in: `- **Idempotent:** \`ON CONFLICT DO NOTHING\` targets the primary key.`
  Use a numbered list when order matters (a call sequence, a lock order). When
  the step has something a reviewer should check, end with a `**Check:**`
  bullet naming it; a mechanical step needs none. Put identifiers, paths and
  literals in inline code. The step title is
  already the heading, so don't start the body with one; use a `###` only when a
  long body has two distinct parts.
- **Prefer a diagram to prose** whenever the step describes structure or flow:
  a call sequence, branching, states, or how types relate. Draw it, then keep
  only the prose the diagram can't carry (why, and what to check). See
  Diagrams below.
- **`refs`**: `{ "path", "side": "new"|"old", "startLine", "endLine" }`. Use new-side
  numbers for added and context lines. Use old-side numbers for deleted lines,
  taken from the `-a,b` half of the hunk header. A hunk that replaces lines needs
  two refs, one per side. A ref may include unchanged lines inside a hunk when
  the step discusses them. Lines outside the diff's hunks can't be shown.
  `"startLine": null` refers to the whole file. Use it for binary files,
  lockfiles and generated files.
- **`id`**: a short slug that is stable for the same idea, e.g. `retry-backoff`. A
  later revision reuses the id when it re-tells the same step.

## Plain English

After you draft the steps, use the `asd-ste100` skill (Simplified Technical
English) to rewrite the narration. A reviewer decides what is safe from these
words, so a sentence they can misread costs more than a long one.

- **Mode:** STE-flavored, because the narration is explanatory prose. Apply the
  structural rules in full. Use active voice and one idea per sentence, at most
  25 words each. Use no semicolons, phrasal verbs ("back off", "set up"), nouns
  made from verbs ("perform validation of"), marketing adjectives or stacked
  hedges. Cut filler such as "note that", "it's worth", "in order
  to", and sentences that only announce the next sentence.
- **Fields:** the `summary`, each step's `title` and `body`, every
  `readingOrder` `note`, every `watchOut` item, and the revision chapter's
  `summary` and step bodies.
- **One name per thing:** call each type, function and concept by the same name
  in every step. Use "check" for what a reviewer must do, not "verify" or
  "confirm", so the wording matches the `**Check:**` bullet.
- **Keep:** the Markdown shape this skill asks for, inline code, identifiers and
  `mermaid` blocks exactly as written. Keep every hedge at its strength: "may
  race" must not become "races". Keep every fact, and add none.
- **Rewrite in place:** put the simplified text into the JSON. Don't emit the
  asd-ste100 rule table.
- **Lint:** run the asd-ste100 skill's linter over the prose of the same scratch
  file you give `narrative-check`:

  ```sh
  jq -r '[.summary, (.watchOut // [])[], (.readingOrder // [])[].note, (.steps[], (.revision.steps // [])[] | .title, .body), (.revision.summary // empty)] | map(. + "\n") | .[]' narrative.json \
    | python3 <asd-ste100 skill directory>/scripts/ste-lint.py
  ```

  Fix every hard finding and re-run until it passes. Passive voice and compound
  tense findings are advisory. Keep a passive when the actor is unknown or
  irrelevant. Keep a compound tense when the current state is the point ("has
  failed and stays failed").

If the `asd-ste100` skill isn't available, apply the rules above directly and
skip the lint.

## Diagrams

Diagrams are the preferred way to explain structure or flow; prose is the
fallback. Put a fenced `mermaid` block in a step's `body` whenever the step
covers any of these, and cut the prose that would have described the same
thing:

- a call or message sequence across functions, files or services
  (`sequenceDiagram`);
- a state machine or lifecycle (`stateDiagram-v2`);
- a data model or how types relate (`classDiagram`, `erDiagram`);
- a decision flow with two or more branches (`flowchart`);
- before/after shape of a reworked path, as two small subgraphs in one
  `flowchart`.

Keep a diagram under about 15 nodes, and name nodes after the identifiers in the
code. Put the diagram in the step about that structure, usually early in the
arc, not in a separate step. The `summary` may carry one diagram too, when the
whole change is a flow or a data-model change. Mermaid syntax pitfalls:

- Quote any label that contains punctuation: `A["parse(input)"]`.
- Don't put `end` as a bare word in a flowchart label.
- Use `-->` for edges.
- Don't wrap the block in HTML.

A diagram earns its place when it replaces prose. Skip it only for a step with
nothing structural to show: a single straight-line edit, a rename, a constant
change, generated files.

## The summary, reading order and watch-outs

The report's `summary` orients the reader before the first step: what the
change is, and the high-level pieces it is made of, at a glance. It is Markdown
shaped like this:

1. One plain-prose sentence saying what the change does and why. The board
   shows this sentence alone in a collapsed strip, so it carries no markup.
2. A tight bullet list of the high-level changes, 3–7 items, each a short
   clause of at most about 12 words: `- **Backfill** co-grants on every writer
   grant at startup`. One bullet per piece of the change, not per file; each
   should map onto one or more steps. No sub-bullets, no detail a step carries.
3. Optionally one small `mermaid` diagram, when the change as a whole is a flow
   or a data-model change and a picture orients faster than the list.

Nothing else: no second paragraph, no watch-outs (those have their own field).
`readingOrder` lists every changed file once, each with:

- `role`: `key`, `supporting` or `mechanical`;
- `risk`: 1–5, how closely to read it;
- `note`: one sentence;
- `changes`: the semantic labels.

Your prompt gives the exact rules for these. `watchOut` lists anything risky or
easy to miss, one item per risk: a single plain sentence that names the risk and
why it matters, under about 20 words. The board renders `note` and `watchOut`
items as plain text, so they take no Markdown: no backticks, asterisks or
headers. Detail belongs in the step that covers those lines. These feed the
board's tour strip and its review-attention level, so fill them in as carefully
as the steps.

## Revision chapter (when the code moved since an earlier narrative)

Your prompt says so when there is an earlier narrative. Then:

1. Run `bb kanban narrative-context` to print the earlier narrative's steps and
   the **delta**: what changed between the earlier head and the current one.
2. Find out **why** it changed:
   - the commit messages between the two heads;
   - the review findings and comments the prompt lists as addressed;
   - the earlier steps those lines belonged to.
3. Write `revision`: `{ "summary", "steps" }`. The `summary` explains the
   revision as a whole, for example "addresses the two review findings on retry
   handling and renames X". Each revision step explains one part of the delta:
   - what changed, and why, shaped like any step body: a sentence or two of
     prose, then bullets with bold lead-ins;
   - the earlier step it revises, named by title;
   - `affects`: the ids of the new narrative's steps where the result shows up.

   Revision step `refs` point into the **delta's** line numbers, not the full
   diff's. Every line of the delta must be covered, and `narrative-check` checks
   this too. Describe in the body anything the delta deleted that the new code
   no longer has.
4. Then write the full new `steps` for the current diff, as for a first
   narrative. Reuse an earlier step's `id`, title and wording when its lines are
   unchanged, with line numbers updated. Rewrite the steps the delta touched.

The reader steps from the old narrative, through the revision chapter, into the
new narrative.
