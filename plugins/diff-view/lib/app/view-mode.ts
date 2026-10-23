export type DiffViewMode = "files" | "narrative" | "conversation";

/** The view `S` goes on to: files, narrative, conversation, and round again, leaving out those this diff lacks; null when there is only the files. */
export function nextViewMode(mode: DiffViewMode, available: { narrative: boolean; conversation: boolean }): DiffViewMode | null {
  const views = (["files", "narrative", "conversation"] as const).filter((view) => view === "files" || available[view]);
  return views.length === 1 ? null : views[(views.indexOf(mode) + 1) % views.length]!;
}
