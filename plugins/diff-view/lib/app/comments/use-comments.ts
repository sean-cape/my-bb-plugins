import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { DiffComment, DiffCommentTarget, GithubComment, LineRange } from "../../types";
import { errorMessage } from "../format";
import type { DiffSource } from "../source";
import { buildDiffThreads, localCommentState, type DiffThread } from "./threads";

/**
 * The source's comments (and synced GitHub ones) as threads, with the edits the view makes to them. Every edit
 * refetches the list; failures toast, and the ones a form awaits rethrow so the form keeps its text.
 */
export function useComments(source: DiffSource, refreshSignal: unknown) {
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [prComments, setPrComments] = useState<GithubComment[]>([]);
  // Where new comments and replies go, chosen once for the whole view; the source's default until the reviewer picks.
  const [chosenTarget, setChosenTarget] = useState<DiffCommentTarget | null>(null);
  const loadComments = useCallback(() => {
    source.listComments().then(setComments, (cause: unknown) => toast.error(errorMessage(cause)));
    if (source.listGithubComments === undefined) setPrComments([]);
    else source.listGithubComments().then(setPrComments, () => setPrComments([]));
  }, [source]);
  useEffect(loadComments, [loadComments, refreshSignal]);
  const threads = useMemo(() => buildDiffThreads(comments, prComments), [comments, prComments]);

  const editComment = async (id: string, body: string) => {
    try {
      await source.updateComment(id, { body });
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  const moveComment = async (id: string, target: DiffCommentTarget) => {
    try {
      await source.updateComment(id, { target });
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const addComment = async (path: string, range: LineRange, body: string, target: DiffCommentTarget) => {
    try {
      await source.addComment({ path, line: range.line, side: range.side, startLine: range.startLine, startSide: range.startSide, body, target, inReplyTo: null });
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  const reply = async (thread: DiffThread, body: string, target: DiffCommentTarget) => {
    try {
      await source.addComment({ path: thread.path, line: thread.line, side: thread.side, startLine: thread.startLine, startSide: thread.startSide, body, target, inReplyTo: thread.id });
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };
  const deleteComment = async (id: string) => {
    try {
      await source.deleteComment(id);
      loadComments();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  return {
    threads,
    localPending: comments.filter((comment) => localCommentState(comment) === "pending"),
    githubDrafts: comments.filter((comment) => localCommentState(comment) === "draft"),
    target: source.canPostToGithub === true ? (chosenTarget ?? source.defaultCommentTarget ?? "local") : "local",
    setTarget: setChosenTarget,
    loadComments,
    addComment,
    reply,
    editComment,
    moveComment,
    deleteComment,
  };
}
