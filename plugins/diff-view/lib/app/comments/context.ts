import { createContext } from "react";
import type { DiffCommentTarget } from "../../types";
import type { DiffThread } from "./threads";

export interface DiffCommentActions {
  canPostToGithub: boolean;
  /** Where new comments and replies go, set once for the view. */
  target: DiffCommentTarget;
  onReply: (thread: DiffThread, body: string, target: DiffCommentTarget) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  /** Re-targets one unsent comment. */
  onMoveComment: (id: string, target: DiffCommentTarget) => Promise<void>;
  onDelete: (id: string) => void;
  onOpenThread: (threadId: string) => void;
}

export const DiffCommentsContext = createContext<DiffCommentActions>({
  canPostToGithub: false,
  target: "local",
  onReply: async () => {},
  onEdit: async () => {},
  onMoveComment: async () => {},
  onDelete: () => {},
  onOpenThread: () => {},
});
