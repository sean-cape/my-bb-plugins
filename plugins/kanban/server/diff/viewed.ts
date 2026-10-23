import type { Ticket } from "../../shared/board";
import type { DiffDelta } from "../../shared/diff";

type HeadsDelta = Omit<DiffDelta, "since">;
import type { KanbanContext } from "../context";
import { github, resolveToken } from "../github";
import type { Changes } from "./changes";

/** New-side line ranges a unified patch touches (added lines, and the insertion point of pure deletions). */
export function newLineRangesFromPatch(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let line = 0;
  let open: [number, number] | null = null;
  const close = () => {
    if (open !== null) ranges.push(open);
    open = null;
  };
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (header !== null) {
      close();
      line = Number.parseInt(header[1]!, 10);
      continue;
    }
    if (raw.startsWith("+")) {
      if (open === null) open = [line, line];
      else open[1] = line;
      line += 1;
    } else if (raw.startsWith("-")) {
      if (open === null) open = [Math.max(1, line), Math.max(1, line)];
    } else if (raw.startsWith("\\")) {
      continue;
    } else {
      close();
      line += 1;
    }
  }
  close();
  return ranges;
}

/** Files the reviewer ticked as viewed, carried over a push for the files it did not touch. */
export function createViewedMarks(ctx: KanbanContext, { changes }: { changes: Changes }) {
  const { bb, settings, stmts } = ctx;
  const { ticketDiff } = changes;

  /** Viewed marks are scoped to the PR head so a push resets them; environment diffs have no head and keep theirs. */
  async function viewedHeadKey(ticket: Ticket): Promise<string> {
    return (await ticketDiff(ticket, false)).headSha ?? "env";
  }

  const deltaCache = new Map<string, HeadsDelta>();

  /** GitHub's compare of two PR heads, reduced to per-file new-side ranges. Null for environment diffs or unknown shas. */
  async function compareHeads(ticket: Ticket, fromSha: string, toSha: string): Promise<HeadsDelta | null> {
    if (ticket.pr === null || fromSha === toSha) return null;
    const key = `${ticket.pr.repo}:${fromSha}..${toSha}`;
    const cached = deltaCache.get(key);
    if (cached !== undefined) return cached;
    const auth = await resolveToken(settings);
    if (auth === null) return null;
    let response: { files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }> };
    try {
      response = await github(`/repos/${ticket.pr.repo}/compare/${fromSha}...${toSha}`, auth.token);
    } catch (error) {
      bb.log.warn(`could not compare ${key}: ${String(error)}`);
      return null;
    }
    const delta: HeadsDelta = {
      fromSha,
      toSha,
      files: (response.files ?? []).map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ranges: file.patch === undefined ? [] : newLineRangesFromPatch(file.patch),
      })),
    };
    deltaCache.set(key, delta);
    return delta;
  }

  /** The head the reviewer last ticked files on, when it differs from the current one. */
  function lastViewedHead(ticket: Ticket, currentHead: string): string | null {
    const heads = stmts.viewedHeads.all(ticket.id).filter((row) => row.head_sha !== currentHead && row.head_sha !== "env");
    return heads[0]?.head_sha ?? null;
  }

  /** Marks made on an older head still count for files that did not change since; promote them so the UI and later calls see one head. */
  async function carryOverViewed(ticket: Ticket, head: string): Promise<void> {
    if (head === "env") return;
    const stale = stmts.viewedPathsNotForHead.all(ticket.id, head);
    if (stale.length === 0) return;
    const now = Date.now();
    const byHead = new Map<string, string[]>();
    for (const row of stale) byHead.set(row.head_sha, [...(byHead.get(row.head_sha) ?? []), row.path]);
    for (const [fromSha, paths] of byHead) {
      const delta = fromSha === "env" ? null : await compareHeads(ticket, fromSha, head);
      if (delta === null) {
        for (const path of paths) stmts.deleteViewed.run(ticket.id, path);
        continue;
      }
      const changed = new Set(delta.files.map((file) => file.path));
      for (const path of paths) {
        if (changed.has(path)) stmts.deleteViewed.run(ticket.id, path);
        else stmts.upsertViewed.run(ticket.id, path, head, now);
      }
    }
  }

  async function listViewed(ticket: Ticket): Promise<{ paths: string[] }> {
    const head = await viewedHeadKey(ticket);
    await carryOverViewed(ticket, head);
    return { paths: stmts.viewedPathsForHead.all(ticket.id, head).map((row) => row.path) };
  }

  async function setViewed(ticket: Ticket, path: string, viewed: boolean): Promise<{ paths: string[] }> {
    const head = await viewedHeadKey(ticket);
    if (viewed) stmts.upsertViewed.run(ticket.id, path, head, Date.now());
    else stmts.deleteViewed.run(ticket.id, path);
    return { paths: stmts.viewedPathsForHead.all(ticket.id, head).map((row) => row.path) };
  }

  return { lastViewedHead, listViewed, setViewed };
}

export type ViewedMarks = ReturnType<typeof createViewedMarks>;
