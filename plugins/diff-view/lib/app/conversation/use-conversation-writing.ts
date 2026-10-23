// What the reader writes in the conversation, on GitHub: the comment box, rewriting their own comments, deleting one
// (dd twice), quoting into the box, and reactions. Failures toast and keep the text.
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { CommentMeta, ReactionContent } from "../../types";
import { errorMessage } from "../format";
import type { DiffSource } from "../source";
import type { ConversationWriting } from "./conversation-view";

/** How long a first dd waits for the second before the delete is off. */
const DELETE_CONFIRM_MS = 3000;

export function quoted(body: string): string {
  return `${body
    .trimEnd()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")}\n\n`;
}

export function useConversationWriting({ actions, notify, openReactions }: { actions: DiffSource["conversationActions"] | undefined; notify: (message: string) => void; openReactions: (meta: CommentMeta) => void }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editingId = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const armed = useRef<{ id: string; at: number } | null>(null);

  const react = useCallback(
    (subject: string, content: ReactionContent, add: boolean) => {
      actions?.react(subject, content, add).catch((cause: unknown) => toast.error(errorMessage(cause)));
    },
    [actions],
  );

  const writing = useMemo((): ConversationWriting | null => {
    if (actions === undefined) return null;
    return {
      editingKey,
      save: async (_key, body) => {
        const id = editingId.current;
        if (id === null) return;
        try {
          await actions.edit(id, body);
          setEditingKey(null);
          editingId.current = null;
        } catch (cause) {
          toast.error(errorMessage(cause));
        }
      },
      cancelEdit: () => {
        setEditingKey(null);
        editingId.current = null;
      },
      draft,
      setDraft,
      posting,
      post: () => {
        if (draft.trim() === "" || posting) return;
        setPosting(true);
        actions.post(draft).then(
          () => {
            setDraft("");
            notify("Comment posted to the pull request");
          },
          (cause: unknown) => toast.error(errorMessage(cause)),
        ).finally(() => setPosting(false));
      },
      composerRef,
      react,
      pickReaction: openReactions,
    };
  }, [actions, editingKey, draft, posting, react, openReactions, notify]);

  const focusComposer = () => {
    const box = composerRef.current;
    if (box === null) return false;
    box.scrollIntoView({ block: "center" });
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    return true;
  };

  return {
    writing,
    focusComposer,
    edit: (key: string, id: string) => {
      editingId.current = id;
      setEditingKey(key);
    },
    /** The first press arms the delete and says so; a second one within a few seconds deletes. */
    remove: (id: string) => {
      if (actions === undefined) return;
      const now = Date.now();
      if (armed.current === null || armed.current.id !== id || now - armed.current.at > DELETE_CONFIRM_MS) {
        armed.current = { id, at: now };
        notify("dd again to delete this comment on GitHub");
        return;
      }
      armed.current = null;
      actions.remove(id).then(
        () => notify("Comment deleted"),
        (cause: unknown) => toast.error(errorMessage(cause)),
      );
    },
    quote: (body: string) => {
      setDraft((current) => `${current === "" || current.endsWith("\n\n") ? current : `${current.trimEnd()}\n\n`}${quoted(body)}`);
      // The box takes the text on the next render; focusing waits for it so the caret lands after the quote.
      requestAnimationFrame(focusComposer);
    },
  };
}
