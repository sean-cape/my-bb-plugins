// What GitHub shows around a comment beyond its text: the author's association, an edited mark, a moderator's hiding,
// and the reactions under it. The conversation provides them by comment id; outside it there are none.
import { createContext, useContext } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { CheckOutcome, CommentMeta, ReactionContent } from "../../types";
import { cn } from "../utils";
import { Badge } from "../ui/badge";

export const CommentMetaContext = createContext<Readonly<Record<string, CommentMeta>>>({});

export function useCommentMeta(id: string): CommentMeta | null {
  return useContext(CommentMetaContext)[id] ?? null;
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

const EMOJI: Record<ReactionContent, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

export function Reactions({ meta }: { meta: CommentMeta | null }) {
  if (meta === null || meta.reactions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {meta.reactions.map((reaction) => (
        <span
          key={reaction.content}
          title={reaction.mine ? "You reacted" : undefined}
          className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] tabular-nums", reaction.mine ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground")}
        >
          <span aria-label={reaction.content.toLowerCase().replace("_", " ")}>{EMOJI[reaction.content]}</span>
          {reaction.count}
        </span>
      ))}
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
