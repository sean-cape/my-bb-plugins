import type { ConversationEvent } from "../../shared/comments";
import type { BoardStore } from "../board";
import type { KanbanContext } from "../context";
import { NO_GITHUB_TOKEN, github, githubPages, resolveToken, type GithubUser } from "../github";

/** One entry of GitHub's issue timeline, trimmed to the fields the kinds read here use. */
export interface GithubTimelineEvent {
  event?: string;
  id?: number;
  actor?: GithubUser | null;
  user?: GithubUser | null;
  body?: string | null;
  state?: string;
  html_url?: string;
  submitted_at?: string;
  created_at?: string;
  commit_id?: string | null;
  requested_reviewer?: GithubUser | null;
  requested_team?: { name?: string } | null;
  rename?: { from?: string; to?: string } | null;
}

interface GithubPullSummary {
  user: GithubUser | null;
  body: string | null;
  created_at: string;
  html_url: string;
}

const ACTIONS: Record<string, Extract<ConversationEvent, { kind: "action" }>["action"]> = {
  merged: "merged",
  closed: "closed",
  reopened: "reopened",
  head_ref_force_pushed: "force-pushed",
  ready_for_review: "ready-for-review",
  convert_to_draft: "converted-to-draft",
  review_requested: "review-requested",
  renamed: "renamed",
  head_ref_deleted: "branch-deleted",
};

const VERDICTS = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

/**
 * The timeline's reviews and changes to the pull request as conversation events. Commits and comments are left out:
 * the board already has them (the diff's commits, the synced comments). Pending reviews are the user's unsent drafts.
 */
export function conversationEvents(timeline: readonly GithubTimelineEvent[], login: string | null): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  timeline.forEach((entry, index) => {
    if (entry.event === "reviewed") {
      const state = (entry.state ?? "").toUpperCase();
      if (entry.id === undefined || entry.submitted_at === undefined || !VERDICTS.has(state)) return;
      const author = entry.user?.login ?? "";
      events.push({
        kind: "review",
        id: `review:${entry.id}`,
        author,
        mine: login !== null && author === login,
        state: state as Extract<ConversationEvent, { kind: "review" }>["state"],
        body: entry.body ?? "",
        createdAt: entry.submitted_at,
        url: entry.html_url ?? "",
      });
      return;
    }
    const action = entry.event === undefined ? undefined : ACTIONS[entry.event];
    if (action === undefined || entry.created_at === undefined) return;
    const detail =
      action === "merged"
        ? (entry.commit_id ?? null)
        : action === "review-requested"
          ? (entry.requested_reviewer?.login ?? entry.requested_team?.name ?? null)
          : action === "renamed"
            ? (entry.rename?.to ?? null)
            : null;
    events.push({ kind: "action", id: `${entry.event}:${entry.id ?? index}`, action, actor: entry.actor?.login ?? "", detail, createdAt: entry.created_at });
  });
  return events;
}

/** A PR card's conversation, read from GitHub each time the changes page shows it. */
export function createPrConversation(ctx: KanbanContext, { board }: { board: BoardStore }) {
  const { settings, sync } = ctx;

  async function prConversation(ticketId: string): Promise<{ events: ConversationEvent[] }> {
    const { pr } = board.getTicket(ticketId);
    if (pr === null) return { events: [] };
    const auth = await resolveToken(settings);
    if (auth === null) throw new Error(NO_GITHUB_TOKEN);
    const base = `/repos/${pr.repo}`;
    const [pull, timeline] = await Promise.all([
      github<GithubPullSummary>(`${base}/pulls/${pr.number}`, auth.token),
      githubPages<GithubTimelineEvent>(`${base}/issues/${pr.number}/timeline`, auth.token),
    ]);
    const opened: ConversationEvent = { kind: "opened", id: `pr:${pr.number}`, author: pull.user?.login ?? pr.author, body: pull.body ?? "", createdAt: pull.created_at, url: pull.html_url };
    return { events: [opened, ...conversationEvents(timeline, sync.login)] };
  }

  return { prConversation };
}
