// What GitHub shows around a comment beyond its text: the author's association, an edited mark, a moderator's hiding,
// and the reactions under it. The conversation provides them by comment id; outside it there are none.
import { createContext, useContext } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { CheckOutcome, CommentMeta, ReactionContent } from "../../types";
import { cn } from "../utils";
import { PRESS } from "../ui/motion";
import { Badge } from "../ui/badge";

/** Badges by comment id, and the reader's reaction toggle where the source takes reactions. */
export const CommentMetaContext = createContext<{ meta: Readonly<Record<string, CommentMeta>>; react: ((subject: string, content: ReactionContent, add: boolean) => void) | null; pick: ((meta: CommentMeta) => void) | null }>({
  meta: {},
  react: null,
  pick: null,
});

export function useCommentMeta(id: string): CommentMeta | null {
  return useContext(CommentMetaContext).meta[id] ?? null;
}

const ASSOCIATION: Record<string, string> = {
  OWNER: "Owner",
  MEMBER: "Member",
  COLLABORATOR: "Collaborator",
  CONTRIBUTOR: "Contributor",
  FIRST_TIME_CONTRIBUTOR: "First-time contributor",
  FIRST_TIMER: "First-time contributor",
  MANNEQUIN: "Mannequin",
};

/** The association badge, the edited mark, and why the comment is hidden; nothing for a comment without meta. */
export function MetaBadges({ meta, author }: { meta: CommentMeta | null; author?: boolean }) {
  if (meta === null && author !== true) return null;
  const association = meta?.association == null ? undefined : ASSOCIATION[meta.association];
  return (
    <>
      {author === true ? (
        <Badge tone="outline" title="The pull request's author">
          Author
        </Badge>
      ) : null}
      {association !== undefined ? (
        <Badge tone="outline" title={`This user is a ${association.toLowerCase()} of this repository`}>
          {association}
        </Badge>
      ) : null}
      {meta?.edited === true ? <span title="Edited since it was posted">edited</span> : null}
      {meta?.minimized != null ? <Badge tone="warning" title="Hidden on GitHub; Enter shows it">hidden as {meta.minimized.toLowerCase().replace(/_/gu, " ")}</Badge> : null}
    </>
  );
}

export const EMOJI: Record<ReactionContent, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

export const REACTION_ORDER = Object.keys(EMOJI) as ReactionContent[];

export function reactionName(content: ReactionContent): string {
  return content.toLowerCase().replace("_", " ");
}

/** The reactions under a comment; with a source that takes them, each toggles the reader's own and + adds another (+ from the keys). */
export function Reactions({ meta }: { meta: CommentMeta | null }) {
  const { react, pick } = useContext(CommentMetaContext);
  if (meta === null) return null;
  const subject = meta.subject;
  const live = react !== null && subject !== null;
  if (meta.reactions.length === 0 && !live) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {meta.reactions.map((reaction) => (
        <button
          type="button"
          key={reaction.content}
          disabled={!live}
          title={live ? (reaction.mine ? "Take back your reaction" : `React with ${reactionName(reaction.content)}`) : reaction.mine ? "You reacted" : undefined}
          onClick={() => react?.(subject!, reaction.content, !reaction.mine)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] tabular-nums",
            PRESS,
            reaction.mine ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
            live && "hover:bg-state-hover",
          )}
        >
          <span aria-label={reactionName(reaction.content)}>{EMOJI[reaction.content]}</span>
          {reaction.count}
        </button>
      ))}
      {live && pick !== null ? (
        <button type="button" title="Add a reaction (+)" onClick={() => pick(meta)} className={cn("inline-flex items-center rounded-full border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}>
          +☺
        </button>
      ) : null}
    </div>
  );
}

const CHECK_ICON: Record<CheckOutcome, { icon: string; className: string; label: string }> = {
  success: { icon: "Check", className: "text-emerald-600 dark:text-emerald-400", label: "passed" },
  failure: { icon: "X", className: "text-destructive", label: "failed" },
  pending: { icon: "Circle", className: "text-amber-500", label: "pending" },
  neutral: { icon: "Circle", className: "text-muted-foreground", label: "neutral" },
  skipped: { icon: "Circle", className: "text-muted-foreground/60", label: "skipped" },
};

export function CheckMark({ outcome, title }: { outcome: CheckOutcome; title?: string }) {
  const mark = CHECK_ICON[outcome];
  return (
    <span title={title ?? `Checks ${mark.label}`} className={cn("inline-flex shrink-0", mark.className)}>
      <Icon name={mark.icon} className="size-3.5" />
    </span>
  );
}

export function checkLabel(outcome: CheckOutcome): string {
  return CHECK_ICON[outcome].label;
}
