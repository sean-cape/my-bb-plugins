import { useContext, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { DiffCommentTarget, LineRange } from "../../types";
import { longLineLabel } from "../../line-range";
import { Button, COMPACT } from "../ui/button";
import { cn } from "../utils";
import { FAST, enter } from "../ui/motion";
import { useDiffSource } from "../source";
import { DiffCommentsContext } from "./context";
import { returnToDiff } from "../keys/review-keys-context";

export function DiffCommentForm({
  path,
  range,
  githubAllowed = true,
  reply = false,
  onSubmit,
  onCancel,
}: {
  path: string;
  range: LineRange;
  /** False where GitHub cannot take the comment (a reply in a local-only thread); it then stays local whatever the view's target. */
  githubAllowed?: boolean;
  reply?: boolean;
  onSubmit: (body: string, target: DiffCommentTarget) => Promise<void>;
  onCancel: () => void;
}) {
  const { canPostToGithub, target: viewTarget } = useContext(DiffCommentsContext);
  const { labels } = useDiffSource();
  const [body, setBody] = useState("");
  const target: DiffCommentTarget = canPostToGithub && githubAllowed && viewTarget === "github" ? "github" : "local";
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submit = async () => {
    if (body.trim() === "") return;
    setPending(true);
    try {
      await onSubmit(body.trim(), target);
      setBody("");
      returnToDiff(textareaRef.current);
      onCancel();
    } finally {
      setPending(false);
    }
  };
  return (
    <div data-comment-form={reply ? "reply" : "new"} className={cn("my-1 flex min-w-0 max-w-full flex-col gap-2 rounded-md border bg-card p-2.5 text-sm", enter.drop, FAST, target === "github" ? "border-sky-500/50" : "border-primary/40")}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Icon name="MessageSquare" className="size-3.5" />
        {reply ? <span>Reply</span> : (
          <>
            <span className="truncate font-mono">{path}</span>
            <code>{longLineLabel(range) ?? "whole file"}</code>
          </>
        )}
        {canPostToGithub ? <span className={cn("ml-auto shrink-0", target === "github" && "text-sky-700 dark:text-sky-300")}>{target === "github" ? "GitHub PR" : "Local"}</span> : null}
      </div>
      <textarea
        ref={textareaRef}
        autoFocus
        value={body}
        rows={reply ? 2 : 3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
          if (event.key !== "Escape") return;
          // A draft survives Escape: the box stays open with its text, and the diff gets the keyboard back.
          returnToDiff(event.currentTarget);
          if (body.trim() === "") onCancel();
        }}
        placeholder={target === "github" ? "Comment for the PR (⌘↩ to add, Esc to cancel)" : "What should the agent change here? (⌘↩ to add, Esc to cancel)"}
        aria-label="Comment"
        className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="mr-auto min-w-0 text-[11px] text-muted-foreground">{target === "github" ? "Draft until you post it to the PR" : viewTarget === "github" && canPostToGithub ? labels.localOnlyThread : labels.localHint}</span>
        <Button
          type="button"
          variant="ghost"
          className={COMPACT}
          onClick={(event) => {
            returnToDiff(event.currentTarget);
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button type="button" variant="secondary" className={COMPACT} disabled={pending || body.trim() === ""} onClick={() => void submit()}>
          {target === "github" ? (reply ? "Add reply to drafts" : "Add to GitHub drafts") : reply ? "Reply" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}
