import type { Ticket } from "../shared/board";
import { narrativeCoverage, uncoveredText, type NarrativeCoverage } from "bb-diff-view/narrative";
import type { HunkExplanation, Narrative, NarrativeReport, NarrativeStory } from "../shared/tour";
import { narrativeReportSchema } from "../shared/tour";
import { parseNarrative } from "./agent-output";
import type { CardThreads } from "./card-threads";
import type { CodeReviewThreads } from "./code-review-threads";
import type { KanbanContext } from "./context";
import { rowToExplanation, rowToNarrative } from "./db/rows";
import { prShortName } from "./github";
import type { Changes } from "./diff/changes";
import type { Projects } from "./projects";
import { rowToReview } from "./db/rows";
import { createNarrativeSnapshots, samePatches, snapshotFiles } from "./narrative/snapshots";
import { shortId, threadTitle } from "./util";

/** Agent-written reading aids for a diff: the tour of the whole change and explanations of single hunks. */
export function createTour(
  ctx: KanbanContext,
  { changes, threads, projects, codeReviewThreads }: { changes: Changes; threads: CardThreads; projects: Projects; codeReviewThreads: CodeReviewThreads },
) {
  const { bb, stmts, publish } = ctx;
  const { ticketDiff } = changes;
  const { freshWorktree, workerOptions } = threads;
  const { projectForTicket } = projects;
  const { codeReviewThreadVisibility } = codeReviewThreads;

  const snapshots = createNarrativeSnapshots(ctx);

  async function latestNarrative(subject: Ticket): Promise<{ narrative: Narrative | null; stale: boolean }> {
    const row = stmts.latestNarrative.get(subject.id);
    if (row === undefined) return { narrative: null, stale: false };
    const diff = await ticketDiff(subject, false);
    const snapshot = snapshots.get(row.id);
    if (snapshot !== null) return { narrative: rowToNarrative(row), stale: !samePatches(snapshot.files, snapshotFiles(diff)) };
    return { narrative: rowToNarrative(row), stale: diff.headSha !== null && row.head_sha !== null && diff.headSha !== row.head_sha };
  }

  /** Every readable narrative of the subject, oldest first, for stepping from one head's story to the next. */
  async function narrativeStory(subject: Ticket): Promise<NarrativeStory> {
    const revisions = snapshots.revisions(subject.id);
    const latest = stmts.latestNarrative.get(subject.id);
    const running = latest !== undefined && latest.status === "running" ? rowToNarrative(latest) : null;
    const newest = revisions.at(-1);
    const stale = newest === undefined ? false : !samePatches(newest.files, snapshotFiles(await ticketDiff(subject, false)));
    return { revisions, running, stale };
  }

  /** Findings applied and local comments addressed since `since`: the reasons the board knows for a revision. */
  function addressedSince(subject: Ticket, since: number): string[] {
    const lines: string[] = [];
    for (const review of stmts.reviewsForTicket.all(subject.id).map(rowToReview)) {
      if (review.apply?.completedAt == null || review.apply.completedAt < since || review.report === null) continue;
      const applied = new Set(review.appliedFindingIds);
      for (const finding of review.report.findings) if (applied.has(finding.id)) lines.push(`- Review finding (${finding.severity}): ${finding.title}`);
    }
    for (const comment of stmts.diffCommentsForTicket.all(subject.id)) {
      if (comment.author !== null || comment.addressed_at === null || comment.addressed_at < since) continue;
      lines.push(`- Comment on ${comment.path}${comment.line === null ? "" : `:${comment.line}`}: ${comment.body.replace(/\s+/gu, " ").slice(0, 200)}`);
    }
    return lines;
  }

  /** One agent reads the diff and writes the tour; the thread.idle handler parses its final message. */
  // Snapshotting and measuring the delta take a while before the row exists; a second request meanwhile joins the first.
  const starting = new Map<string, Promise<Narrative>>();

  function spawnNarrative(subject: Ticket): Promise<Narrative> {
    const pending = starting.get(subject.id);
    if (pending !== undefined) return pending;
    const started = startNarrative(subject).finally(() => starting.delete(subject.id));
    starting.set(subject.id, started);
    return started;
  }

  async function startNarrative(subject: Ticket): Promise<Narrative> {
    const running = stmts.latestNarrative.get(subject.id);
    if (running !== undefined && running.status === "running") return rowToNarrative(running);
    const diff = await ticketDiff(subject, false);
    if (diff.files.length === 0) throw new Error(diff.message ?? "There are no changes to describe.");
    const paths = diff.files.map((file) => `- ${file.path} (+${file.additions} −${file.deletions}${file.status === "modified" ? "" : `, ${file.status}`})`).join("\n");
    const head = await snapshots.headOf(subject, diff);
    const files = snapshotFiles(diff);
    const previous = snapshots.latestCompleted(subject.id);
    const previousSnapshot = previous === null ? null : snapshots.get(previous.id);
    const revising = previous !== null && previousSnapshot !== null && !samePatches(previousSnapshot.files, files);
    const delta = revising ? await snapshots.computeDelta(subject, previousSnapshot, { ...head, files }) : null;
    const addressed = revising ? addressedSince(subject, previous.createdAt) : [];
    const revisionExample = revising ? ',"revision":{"summary":"what changed since the earlier narrative, and why","steps":[{"id":"retry-cap","title":"The retry cap moved from 10s to 30s for the slow-upstream finding","body":"…","refs":[{"path":"exact/path","side":"new","startLine":12,"endLine":14}],"affects":["retry-backoff"]}]}' : "";
    const revisionBrief = !revising
      ? []
      : [
          "",
          `An earlier narrative of this change exists${previousSnapshot.head === null ? "" : `, written at ${previousSnapshot.head.slice(0, 12)}${previousSnapshot.dirty ? " plus uncommitted changes" : ""}`}, and the code has moved since. Include the \`revision\` chapter the narrative-review skill describes. \`bb kanban narrative-context\` prints the earlier narrative's steps and ${delta === null ? "explains why there is no delta" : "the delta between the two heads; revision step refs use the delta's line numbers"}.`,
          ...(delta === null
            ? ["The board could not measure the delta between the heads. Compare the earlier narrative with the current diff and the commit log yourself, and leave a revision step's refs empty when you cannot point at its lines."]
            : subject.pr !== null && previousSnapshot.head !== null
              ? [`For the commits in between, \`git fetch origin ${previousSnapshot.head}\` (it may be gone after a force-push) and read \`git log ${previousSnapshot.head}..HEAD\`.`]
              : previousSnapshot.head !== null
                ? [`For the commits in between, read \`git log ${previousSnapshot.head}..HEAD\`.`]
                : []),
          ...(addressed.length === 0 ? [] : ["The board recorded these as addressed since the earlier narrative:", ...addressed]),
        ];
    const deliverable = [
      "",
      "Use the narrative-review skill: this is a narrative code review, an ordered walk through the change in which every changed line appears in at least one step.",
      ...revisionBrief,
      "",
      "Your final message must end with a ```json kanban-narrative block shaped like:",
      "```json kanban-narrative",
      `{"version":2,"summary":"One plain sentence on what the change does and why.\\n\\n- **Backfill** co-grants on every writer grant at startup\\n- **Report** roles still missing them\\n- **Tests** for both","readingOrder":[{"path":"exact/path/from/the/list","role":"key|supporting|mechanical","note":"one sentence on what to look at here","lines":[42],"risk":3,"changes":[{"kind":"rename|move|signature|reorder|reformat|extract|inline|logic","label":"renamed loadUser to loadUsers and made it take a slice","oldLines":[170,180],"newLines":[170,178]}]}],"watchOut":["anything risky or easy to miss"],"steps":[{"id":"retry-backoff","title":"The retry delay doubles up to a 30s cap","body":"One sentence of prose, then bullets with bold lead-ins:\\n\\n- **Idempotent:** \`ON CONFLICT DO NOTHING\` targets the primary key, so …\\n- **Check:** what the reviewer should verify. A \`\`\`mermaid fence where a diagram helps.","refs":[{"path":"exact/path/from/the/list","side":"new","startLine":40,"endLine":58},{"path":"exact/path/from/the/list","side":"old","startLine":38,"endLine":41}]}]${revisionExample}}`,
      "```",
      "Rules: list every changed file exactly once in `readingOrder` using the paths above, in the order a reviewer should read them; `key` files carry the behaviour change, `supporting` files follow from them, `mechanical` files are renames, generated code, lockfiles or formatting. `lines` are new-side line numbers.",
      "`risk` is 1–5 for how closely a reviewer must read the file: 5 for behaviour changes in auth, money, concurrency, data migrations or error handling; 3 for ordinary logic; 1 for generated code, lockfiles, pure renames or formatting.",
      "`changes` names blocks of the file's diff that look like big red/green walls but are really one semantic edit, so the viewer can label them instead: a rename (say both names), a moved block, a signature change (say what changed), a reorder, a reformat, an extraction or inlining. Give old-side and new-side line ranges from `git diff`'s hunk headers; omit blocks that are plain new logic. Leave `changes` empty when nothing qualifies.",
      "Be concise: say everything a reviewer needs and nothing twice; cut filler words and anything the title, an earlier step or a diagram already carries. Format for scanning, not as blocks of prose. A step `body` opens with one sentence of prose, then puts the details in Markdown bullets with bold lead-ins, one sentence each (a numbered list when order matters), ending with a **Check:** item when the step has something a reviewer should verify; the step title is its heading, so don't add one. Prefer a ```mermaid diagram to prose wherever a step describes a call sequence, branching, states or how types relate, and keep only the prose the diagram can't carry. `summary` orients the reader: one plain-prose sentence on what the change does and why (the board shows that sentence alone, so no markup in it), then a tight bullet list of the high-level changes, 3–7 items of at most about 12 words each, one per piece of the change rather than per file, optionally followed by one small ```mermaid diagram when the whole change is a flow or data-model change; nothing else. `watchOut` items and `note` render as plain text: one short sentence each, no Markdown.",
      "Then simplify the narration with the asd-ste100 skill in STE-flavored mode, as the narrative-review skill describes: active voice, one idea per sentence of at most 25 words, no semicolons or phrasal verbs, one name per thing, inline code and diagrams untouched, and every hedge kept at its strength.",
      "`steps` must cover every added line (new side) and every deleted line (old side) at least once, and may repeat lines across steps. Before finishing, write the JSON to a scratch file outside the repository and run `bb kanban narrative-check --report-stdin < that-file` until it reports nothing uncovered.",
      "Do not change any code, and do not post anything to GitHub.",
      `This narrative belongs to kanban card ${subject.id}.`,
    ];
    let thread: { id: string };
    if (subject.pr !== null) {
      const projectId = await projectForTicket(subject, null);
      const { repo, number, url } = subject.pr;
      thread = await bb.sdk.threads.spawn({
        projectId,
        environment: await freshWorktree(projectId),
        prompt: [
          `Write a narrative code review of pull request ${repo}#${number}: "${subject.title}" (${url}).`,
          "",
          "Setup (this worktree is disposable). The `gh` and `git fetch` steps need your GitHub credentials, which the sandbox hides; running them with the sandbox disabled is expected and authorized here.",
          `1. \`BASE=$(gh pr view ${number} --repo ${repo} --json baseRefName --jq .baseRefName)\``,
          `2. \`git fetch origin "$BASE" "pull/${number}/head"\` and \`git checkout --detach FETCH_HEAD\``,
          `3. Read \`gh pr view ${number} --repo ${repo}\` for the description, then \`git diff origin/$BASE...HEAD\` and the files it touches:`,
          paths,
          ...deliverable,
        ].join("\n"),
        title: threadTitle(`Narrative ${prShortName(subject.pr)}: ${subject.title}`),
        ...(await workerOptions(subject)),
        visibility: await codeReviewThreadVisibility(),
        pluginMetadata: { ticketId: subject.id, role: "narrative" },
      });
    } else {
      if (subject.threadId === null || subject.projectId === null) throw new Error("This card has no thread to read the changes from.");
      const cardThread = await bb.sdk.threads.get({ threadId: subject.threadId });
      if (cardThread.environmentId === null) throw new Error("The card's thread has no environment yet.");
      thread = await bb.sdk.threads.spawn({
        projectId: subject.projectId,
        environment: { type: "reuse", environmentId: cardThread.environmentId },
        prompt: [
          `Write a narrative code review of the changes on this branch${diff.baseRef === null ? "" : ` relative to ${diff.baseRef}`}: "${subject.title}".`,
          "",
          `Read ${diff.baseRef === null ? "`git diff` and `git status`" : `\`git diff ${diff.baseRef}...HEAD\` plus any uncommitted changes (\`git diff\`, \`git status\`)`} and the files touched:`,
          paths,
          ...deliverable,
        ].join("\n"),
        title: threadTitle(`Narrative: ${subject.title}`),
        ...(await workerOptions(subject)),
        visibility: await codeReviewThreadVisibility(),
        pluginMetadata: { ticketId: subject.id, role: "narrative" },
      });
    }
    const id = shortId();
    ctx.db.transaction(() => {
      stmts.insertNarrative.run({ id, ticket_id: subject.id, thread_id: thread.id, head_sha: diff.headSha, created_at: Date.now() });
      snapshots.record(id, revising ? previous.id : null, head, files, delta);
    })();
    publish();
    return rowToNarrative(stmts.latestNarrative.get(subject.id)!);
  }

  /** Writes a narrative unless the latest one is still current or still being written. */
  async function ensureNarrative(subject: Ticket): Promise<void> {
    const { narrative, stale } = await latestNarrative(subject);
    if (narrative !== null && narrative.status !== "failed" && !stale) return;
    await spawnNarrative(subject);
  }

  /** The narrative a CLI call means: the one named, else the one the calling thread is writing. */
  function narrativeFor(narrativeId: string | undefined, threadId: string | undefined): Narrative {
    const row = narrativeId !== undefined ? snapshots.narrativeRow(narrativeId) : threadId === undefined ? undefined : stmts.narrativeByThread.get(threadId);
    if (row === undefined) throw new Error(narrativeId === undefined ? "No narrative is being written by this thread." : `No narrative ${narrativeId}.`);
    return rowToNarrative(row);
  }

  /** `bb kanban narrative-context`: the earlier narrative's steps and the delta a revision chapter must explain. */
  function narrativeContext(narrativeId: string | undefined, threadId: string | undefined): string {
    const narrative = narrativeFor(narrativeId, threadId);
    const snapshot = snapshots.get(narrative.id);
    if (snapshot === null || snapshot.previousId === null) return "This narrative has no earlier narrative to revise; write it from the current diff alone.";
    const previous = snapshots.narrativeRow(snapshot.previousId);
    const report = previous === undefined ? null : rowToNarrative(previous).report;
    const out = [`# Earlier narrative ${snapshot.previousId}`, "", report === null ? "(no longer available)" : JSON.stringify({ summary: report.summary, steps: report.steps }, null, 2), ""];
    if (snapshot.delta === null) {
      out.push("# Delta", "", "The board could not measure what changed between the two heads (no checkout on this machine, an unknown earlier head, or GitHub refused the compare). Work it out from the commit log and the current diff.");
    } else {
      out.push(`# Delta ${snapshot.delta.fromHead?.slice(0, 12) ?? "?"} → ${snapshot.delta.toHead?.slice(0, 12) ?? "working tree"}`, "");
      if (snapshot.delta.note !== null) out.push(snapshot.delta.note, "");
      if (snapshot.delta.files.length === 0) out.push("No line changed in the files this change touches; the base branch moved under it. Say so in the revision summary and leave the revision steps empty.");
      for (const file of snapshot.delta.files) out.push(`diff --git a/${file.previousPath ?? file.path} b/${file.path}`, file.patch ?? "(binary or too large; cover it with a whole-file ref)", "");
    }
    return out.join("\n");
  }

  /** `bb kanban narrative-check`: whether a draft report parses and covers every changed line of the diff (and of the delta). */
  function checkNarrative(narrativeId: string | undefined, threadId: string | undefined, json: string): { ok: boolean; text: string } {
    const narrative = narrativeFor(narrativeId, threadId);
    const snapshot = snapshots.get(narrative.id);
    let report: NarrativeReport;
    try {
      const parsed = narrativeReportSchema.safeParse(JSON.parse(json));
      if (!parsed.success) return { ok: false, text: `The report does not match the kanban-narrative shape:\n${parsed.error.message}` };
      report = parsed.data;
    } catch (error) {
      return { ok: false, text: `Not JSON: ${String(error)}` };
    }
    if (snapshot === null) return { ok: true, text: "Parsed. This narrative has no saved diff to check coverage against." };
    const lines: string[] = [];
    const describe = (label: string, coverage: NarrativeCoverage, patches: ReadonlyArray<{ path: string; patch: string | null }>) => {
      lines.push(`${label}: ${coverage.coveredLines}/${coverage.changedLines} changed lines covered.`);
      for (const path of coverage.unknownPaths) lines.push(`  ${path} is not in the ${label.toLowerCase()}.`);
      for (const file of coverage.uncovered) {
        if (file.wholeFile) {
          lines.push(`  ${file.path}: not referenced (no text patch; use a whole-file ref).`);
          continue;
        }
        const ranges = [...file.old.map(([a, b]) => `old ${a}–${b}`), ...file.new.map(([a, b]) => `new ${a}–${b}`)];
        lines.push(`  ${file.path}: ${ranges.join(", ")}`);
        const patch = patches.find((entry) => entry.path === file.path)?.patch ?? null;
        if (patch !== null) lines.push(...uncoveredText(patch, file.old, file.new).map((line) => `    ${line}`));
      }
    };
    const main = narrativeCoverage(snapshot.files, report.steps.flatMap((step) => step.refs));
    describe("Diff", main, snapshot.files);
    let ok = main.uncovered.length === 0 && main.unknownPaths.length === 0;
    if (snapshot.previousId !== null) {
      if (report.revision === null) {
        lines.push("Revision: missing. This narrative revises an earlier one; add the `revision` chapter.");
        ok = false;
      } else if (snapshot.delta !== null) {
        const delta = narrativeCoverage(snapshot.delta.files, report.revision.steps.flatMap((step) => step.refs));
        describe("Delta", delta, snapshot.delta.files);
        ok &&= delta.uncovered.length === 0 && delta.unknownPaths.length === 0;
        const ids = new Set(report.steps.map((step) => step.id));
        for (const step of report.revision.steps) for (const id of step.affects) if (!ids.has(id)) lines.push(`  Revision step "${step.title}" affects unknown step id ${id}.`);
      }
    }
    return { ok, text: [ok ? "Every changed line is covered." : "Not done yet:", ...lines].join("\n") };
  }

  /** A checkout that already has the subject's code: its latest review or tour thread, else the card thread, else nothing. */
  async function reusableEnvironment(subject: Ticket): Promise<string | null> {
    const candidates = [
      // A local review's worktree is detached at the commit it reviewed, not the card's current work.
      subject.pr === null ? null : (stmts.latestCompletedReviewOfKind.get(subject.id, "pr")?.thread_id ?? null),
      stmts.latestNarrative.get(subject.id)?.thread_id ?? null,
      subject.threadId,
    ].filter((id): id is string => id !== null);
    for (const threadId of candidates) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null && thread.archivedAt === null) return thread.environmentId;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** One short agent thread explains a hunk; the thread.idle handler stores its final message as the explanation. */
  async function explainHunk(subject: Ticket, path: string, side: "old" | "new", startLine: number, endLine: number): Promise<HunkExplanation> {
    const diff = await ticketDiff(subject, false);
    const existing = stmts.explanationsForHead
      .all(subject.id, diff.headSha)
      .find((row) => row.path === path && row.side === side && row.start_line === startLine && row.end_line === endLine && row.status !== "failed");
    if (existing !== undefined) return rowToExplanation(existing);
    const where = `${path} lines ${startLine}–${endLine} (${side === "new" ? "the new version, as checked out" : "the OLD version: look at these lines in the base, e.g. `git show origin/$BASE:" + path + "`"})`;
    const ask = [
      `Explain the change at ${where} to a code reviewer: what it does, why it is there (read the surrounding function and use \`git grep\` to find the call sites that depend on it), and anything subtle. Keep it under 150 words of plain Markdown; no headings, no code changes, no GitHub posts.`,
      "Your final message must be only the explanation.",
      `This belongs to kanban card ${subject.id}.`,
    ];
    const environmentId = await reusableEnvironment(subject);
    const title = threadTitle(`Explain ${path.split("/").pop()}:${startLine} — ${subject.title}`);
    let thread: { id: string };
    if (environmentId !== null) {
      const projectId = subject.projectId ?? (subject.pr === null ? null : await projectForTicket(subject, null));
      if (projectId === null) throw new Error("This card has no project to run the explanation in.");
      thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "reuse", environmentId },
        prompt: [subject.pr === null ? "" : `This checkout has pull request ${subject.pr.repo}#${subject.pr.number} checked out. \`BASE=$(gh pr view ${subject.pr.number} --repo ${subject.pr.repo} --json baseRefName --jq .baseRefName)\` if you need the base.`, ...ask].filter((line) => line !== "").join("\n"),
        title,
        ...(subject.threadId === null ? {} : { parentThreadId: subject.threadId }),
        visibility: await codeReviewThreadVisibility(),
        pluginMetadata: { ticketId: subject.id, role: "explain" },
      });
    } else if (subject.pr !== null) {
      const projectId = await projectForTicket(subject, null);
      const { repo, number } = subject.pr;
      thread = await bb.sdk.threads.spawn({
        projectId,
        environment: await freshWorktree(projectId),
        prompt: [
          `Setup first (disposable worktree; GitHub steps may need the sandbox disabled, which is authorized): \`BASE=$(gh pr view ${number} --repo ${repo} --json baseRefName --jq .baseRefName)\`; \`git fetch origin "$BASE" "pull/${number}/head"\`; \`git checkout --detach FETCH_HEAD\`.`,
          ...ask,
        ].join("\n"),
        title,
        ...(subject.threadId === null ? {} : { parentThreadId: subject.threadId }),
        visibility: await codeReviewThreadVisibility(),
        pluginMetadata: { ticketId: subject.id, role: "explain" },
      });
    } else {
      throw new Error("No checkout to explain from; start the card's thread first.");
    }
    const id = shortId();
    stmts.insertExplanation.run({ id, ticket_id: subject.id, path, side, start_line: startLine, end_line: endLine, head_sha: diff.headSha, thread_id: thread.id, created_at: Date.now() });
    publish();
    return rowToExplanation(stmts.explanationsForHead.all(subject.id, diff.headSha).find((row) => row.id === id)!);
  }

  async function listExplanations(ticket: Ticket): Promise<{ explanations: HunkExplanation[] }> {
    const head = (await ticketDiff(ticket, false)).headSha;
    return { explanations: stmts.explanationsForHead.all(ticket.id, head).map(rowToExplanation) };
  }

  /** A tour or explanation thread went idle: store its final message. */
  function handleIdle(threadId: string, lastAssistantText: string | null): boolean {
    const explanationRow = stmts.explanationByThread.get(threadId);
    if (explanationRow !== undefined && explanationRow.status === "running") {
      const text = lastAssistantText?.trim() ?? "";
      if (text === "") stmts.failExplanation.run(null, Date.now(), explanationRow.id);
      else stmts.completeExplanation.run(text, Date.now(), explanationRow.id);
      publish();
      return true;
    }
    const narrativeRow = stmts.narrativeByThread.get(threadId);
    if (narrativeRow !== undefined && narrativeRow.status === "running") {
      if (parseNarrative(lastAssistantText) === null) stmts.failNarrative.run(lastAssistantText, Date.now(), narrativeRow.id);
      else stmts.completeNarrative.run(lastAssistantText, Date.now(), narrativeRow.id);
      publish();
      return true;
    }
    return false;
  }

  return { latestNarrative, narrativeStory, spawnNarrative, ensureNarrative, narrativeContext, checkNarrative, explainHunk, listExplanations, handleIdle };
}

export type Tour = ReturnType<typeof createTour>;
