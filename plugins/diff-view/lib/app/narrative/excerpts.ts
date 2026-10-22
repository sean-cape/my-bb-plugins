// A step's code, cut from the chapter's patches, and the view's annotations cut to those lines. Pure, for the tests.
import { excerptPatch, fileForRef, type NarrativePatchFile, type NarrativeRef } from "../../narrative";
import type { DiffThread } from "../comments/threads";
import type { PlacedFinding } from "../findings/findings";
import type { ComposerAnchor } from "../patch-annotations";
import { patchRows, rowKey } from "../text/patch-rows";
import { ignoreWhitespacePatch } from "../text/whitespace";

/** A step's refs to one file, in the order the step first names each file. */
export interface StepExcerpt {
  path: string;
  refs: NarrativeRef[];
  file: NarrativePatchFile | null;
  patch: string | null;
}

/**
 * With `hideWhitespace`, each file's whitespace pairs become context before the step's lines are cut, as cutting first
 * can split a pair. A hunk holding a line the step names is kept even when only its whitespace changed.
 */
export function stepExcerpts(refs: readonly NarrativeRef[], files: readonly NarrativePatchFile[], hideWhitespace = false): StepExcerpt[] {
  // Keyed by the file a ref resolves to, so a renamed file's old and new names make one excerpt.
  const byPath = new Map<string, { file: NarrativePatchFile | null; refs: NarrativeRef[] }>();
  for (const ref of refs) {
    const file = fileForRef(files, ref.path);
    const key = file?.path ?? ref.path;
    byPath.set(key, { file, refs: [...(byPath.get(key)?.refs ?? []), ref] });
  }
  const shown = (patch: string, mine: readonly NarrativeRef[]) => {
    if (!hideWhitespace) return patch;
    const named = (side: "LEFT" | "RIGHT", line: number) =>
      mine.some((ref) => ref.startLine === null || ((ref.side === "old") === (side === "LEFT") && line >= Math.min(ref.startLine, ref.endLine ?? ref.startLine) && line <= Math.max(ref.startLine, ref.endLine ?? ref.startLine)));
    return ignoreWhitespacePatch(patch, named);
  };
  return [...byPath].map(([path, { file, refs: mine }]) => {
    const patch = file?.patch == null ? null : shown(file.patch, mine);
    return { path, refs: mine, file, patch: patch === null ? null : excerptPatch(patch, mine) };
  });
}

/**
 * The file's threads, findings and open comment box that fall on lines the excerpt shows. Pierre is handed only
 * annotations on lines it renders; a comment on a line the step leaves out stays with the files view. File-level
 * threads (and a file-level comment box) belong to every excerpt of the file, as its header is where they live.
 * Whole-file findings are left out: they would repeat under every step that touches the file.
 */
export function excerptAnnotations(
  patch: string,
  threads: readonly DiffThread[],
  findings: readonly PlacedFinding[],
  composer: ComposerAnchor | null,
): { threads: DiffThread[]; findings: PlacedFinding[]; composer: ComposerAnchor | null } {
  const { at } = patchRows(patch);
  const shows = (side: "LEFT" | "RIGHT", line: number) => at.has(rowKey(side, line));
  return {
    threads: threads.filter((thread) => thread.line === null || shows(thread.side, thread.line)),
    findings: findings.filter((entry) => entry.line !== null && shows("RIGHT", entry.line)),
    composer: composer === null || composer.line === null || shows(composer.side, composer.line) ? composer : null,
  };
}
