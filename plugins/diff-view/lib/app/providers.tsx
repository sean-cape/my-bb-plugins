import type { ReactNode } from "react";
import type { CommitRange } from "../types";
import { CommitRangeContext } from "./commits/commit-picker";
import { DiffCommentsContext, type DiffCommentActions } from "./comments/context";
import { FileActionsContext, type FileMenuActions } from "./file-actions";
import { ReviewKeysContext, type ReviewKeys } from "./keys/review-keys-context";
import { SearchHighlightCss } from "./search/use-diff-search";
import { DiffSourceContext, type DiffSource, type DiffViewLabels } from "./source";
import { SuggestionsContext, type SuggestionActions } from "./suggestions/context";

/** What the view hands every file renderer, thread and popover under it. */
export function DiffViewProviders({
  range,
  source,
  comments,
  suggestions,
  keys,
  fileActions,
  searchCss,
  children,
}: {
  range: CommitRange | null;
  source: { source: DiffSource; labels: DiffViewLabels };
  comments: DiffCommentActions;
  suggestions: SuggestionActions;
  keys: ReviewKeys;
  fileActions: FileMenuActions;
  searchCss: string;
  children: ReactNode;
}) {
  return (
    <CommitRangeContext.Provider value={range}>
      <DiffSourceContext.Provider value={source}>
        <DiffCommentsContext.Provider value={comments}>
          <SuggestionsContext.Provider value={suggestions}>
            <ReviewKeysContext.Provider value={keys}>
              <FileActionsContext.Provider value={fileActions}>
                <SearchHighlightCss.Provider value={searchCss}>{children}</SearchHighlightCss.Provider>
              </FileActionsContext.Provider>
            </ReviewKeysContext.Provider>
          </SuggestionsContext.Provider>
        </DiffCommentsContext.Provider>
      </DiffSourceContext.Provider>
    </CommitRangeContext.Provider>
  );
}
