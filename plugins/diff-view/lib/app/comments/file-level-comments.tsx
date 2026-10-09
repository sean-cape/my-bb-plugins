import type { DiffCommentTarget } from "../../types";
import { WHOLE_FILE } from "../patch-annotations";
import { DiffCommentForm } from "./comment-form";
import { DiffThreadView } from "./thread-view";
import type { DiffThread } from "./threads";

/** Above a file's diff: the whole-file comment form when it is open, then the given threads. */
export function FileLevelComments({
  path,
  threads,
  composing,
  onSubmit,
  onCancel,
}: {
  path: string;
  threads: DiffThread[];
  composing: boolean;
  onSubmit: (body: string, target: DiffCommentTarget) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <>
      {composing ? (
        <div className="px-3">
          <DiffCommentForm path={path} range={WHOLE_FILE} onSubmit={onSubmit} onCancel={onCancel} />
        </div>
      ) : null}
      {threads.length > 0 ? (
        <div className="px-3">
          {threads.map((thread) => (
            <DiffThreadView key={thread.id} thread={thread} />
          ))}
        </div>
      ) : null}
    </>
  );
}
