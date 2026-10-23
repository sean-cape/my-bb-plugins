import { useContext, useState, type KeyboardEvent } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FindingEdit, FindingSeverity } from "../../types";
import { Button, COMPACT } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../utils";
import { CHEVRON, FAST, OPACITY_TRANSITION, PRESS, enter, useOpenedSinceMount } from "../ui/motion";
import { SEVERITY_DOT, SEVERITY_LABEL, type InlineFinding } from "./findings";
import { ResolveFindingContext } from "./resolve-context";
import { useFindingControls, useIsFocused, useIsReading } from "../keys/review-keys-context";
import { CARD_BODY, CARD_FOOTER, CARD_HEADER, SPANNING_CARD } from "../ui/spanning-card";
import { Badge } from "../ui/badge";
import { SuggestionsContext } from "../suggestions/context";
import { SuggestionDiff } from "../suggestions/suggestion-diff";
import { findingSuggestionLabel } from "../suggestions/finding-suggestion";
import { SUGGESTION_BUTTON, SuggestionBadge, SuggestionButtons } from "../suggestions/suggestion-actions";
import { applicableItem, isInBatch, suggestionKeyHints } from "../suggestions/actions";

/** The rule down the card's left, in the severity's hue. */
const SEVERITY_RULE: Record<FindingSeverity, string> = { critical: "border-l-red-500/80", important: "border-l-amber-500/80", minor: "border-l-slate-400/70" };
const SEVERITY_TEXT: Record<FindingSeverity, string> = { critical: "text-red-600 dark:text-red-400", important: "text-amber-700 dark:text-amber-300", minor: "text-muted-foreground" };
/**
 * A review finding under the line it is about: one quiet strip (checkbox, severity, title) that expands to the details,
 * description and fix, with inline editing of the wording the apply thread will receive. It stays a single line until
 * opened, or while the keyboard cursor is on it.
 */
export function FindingAnnotation({
  item,
  anchorId,
  entrance = true,
  onToggle,
  onEdit,
}: {
  item: InlineFinding;
  /** This placement's id among the review keys' anchors. */
  anchorId: string;
  /** Read once, at mount: false when the finding was already on screen and only remounted. */
  entrance?: boolean;
  onToggle: (selected: boolean) => void;
  onEdit: (edit: FindingEdit | null) => Promise<void>;
}) {
  const { finding } = item;
  const [entering] = useState(entrance);
  // Null follows the keyboard cursor; a click, Enter or za pins it open or closed.
  const [open, setOpen] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FindingEdit>({ title: finding.title, description: finding.description, fix: finding.fix });
  const [saving, setSaving] = useState(false);
  const suggestions = useContext(SuggestionsContext);
  const suggestion = suggestions.forFinding(item);
  const resolve = useContext(ResolveFindingContext);
  const applicable = applicableItem(suggestions, suggestion?.item ?? null);
  const inBatch = isInBatch(suggestions.batch, applicable);
  const posted = suggestion !== null && suggestions.posted.has(suggestion.id);
  const canPost = suggestions.post !== null && suggestion !== null && !suggestion.applied && !posted && suggestion.current !== null;
  const beginEdit = () => {
    setDraft({ title: finding.title, description: finding.description, fix: finding.fix });
    setEditing(true);
    setOpen(true);
  };
  const focused = useIsFocused("finding", anchorId);
  const reading = useIsReading("finding", anchorId);
  const expanded = editing || (open ?? reading);
  const toggle = () => setOpen(!expanded);
  const save = async () => {
    setSaving(true);
    try {
      await onEdit({ title: draft.title.trim(), description: draft.description, fix: draft.fix === null || draft.fix.trim() === "" ? null : draft.fix });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  useFindingControls(anchorId, { toggle, edit: beginEdit });
  const onFieldKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && draft.title.trim() !== "") void save();
  };
  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
  const reveal = useOpenedSinceMount(expanded) ? cn(enter.rise, FAST) : undefined;
  const meta = [
    finding.locations.length > 1 ? `${finding.locations.length} instances` : null,
    item.carriedFrom !== null ? `still open from an earlier review's ${item.carriedFrom}` : null,
    item.edited ? "reworded by you" : null,
    item.overridden ? (item.selected ? "included by you" : "excluded by you") : null,
  ].filter((part) => part !== null);
  // The review's scores, for the id's tooltip: they shaped the triage and rarely change what the reader does.
  const scores = [
    finding.importance !== null && finding.scopeFit !== null ? `importance ${finding.importance}/5 · scope fit ${finding.scopeFit}/5` : null,
    finding.confidence != null ? `verifier confidence ${finding.confidence}` : null,
    finding.class != null && finding.class !== "" ? `class: ${finding.class}` : null,
  ].filter((part) => part !== null);
  return (
    <div data-finding-anchor="" className={cn(SPANNING_CARD, "break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto", entering && [enter.fade, FAST], OPACITY_TRANSITION, SEVERITY_RULE[finding.severity], !item.selected && "opacity-60", focused && "ring-1 ring-primary/70")}>
      <div className={CARD_HEADER}>
        <Checkbox checked={item.selected} onCheckedChange={(checked) => onToggle(checked === true)} aria-label={`${item.selected ? "Exclude" : "Include"} ${finding.id} in the apply round`} className="size-3.5" />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={toggle} aria-expanded={expanded} data-bbm-open={expanded}>
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className={cn("min-w-0 flex-1 truncate font-medium", item.selected ? "text-foreground" : "text-muted-foreground")}>{finding.title}</span>
        </button>
        {resolve !== null ? (
          <button
            type="button"
            className={cn("shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
            title="Resolve: take it out of the diff and out of the apply round; re-reviews leave it be (r). Resolved findings are listed above the diff, where they can be reopened."
            onClick={() => resolve(item)}
          >
            Resolve
          </button>
        ) : null}
        <span className={cn("shrink-0 text-[11px]", SEVERITY_TEXT[finding.severity])}>{SEVERITY_LABEL[finding.severity]}</span>
      </div>
      {/* Mounted while folded: it opens as the cursor passes, and mounting it then restyles the whole page under bb
          themes with broad :has() rules. */}
      {!editing ? (
        <div className={cn(CARD_BODY, "text-sm", reveal, !expanded && "hidden")}>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="min-w-0">
              <span className={cn("font-mono", scores.length > 0 && "cursor-help underline decoration-dotted underline-offset-2")} title={scores.length > 0 ? scores.join("\n") : undefined}>
                {finding.id}
              </span>
              {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
            </span>
            <button type="button" className={cn("ml-auto rounded px-1 hover:bg-state-hover hover:text-foreground", PRESS)} onClick={beginEdit}>
              Edit
            </button>
          </div>
          {finding.description !== "" ? <Markdown content={finding.description} /> : <p className="text-muted-foreground">No description.</p>}
          {finding.fix !== null && finding.fix !== "" ? (
            <div className="flex gap-2 rounded-md bg-muted/30 px-2.5 py-1.5">
              <Icon name="diff-view-wrench" className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <Markdown content={finding.fix} className="min-w-0 flex-1" />
            </div>
          ) : null}
          {suggestion !== null ? (
            <div className="flex flex-col gap-1">
              <SuggestionDiff
                expected={suggestion.current}
                replacement={suggestion.replacement}
                startLine={suggestion.suggestion.startLine}
                label={`Suggested change · ${findingSuggestionLabel(suggestion.suggestion)}`}
                badge={<SuggestionBadge applied={suggestion.applied} inBatch={inBatch} otherwise={posted ? <Badge tone="outline">draft on GitHub</Badge> : null} />}
              />
              {applicable !== null || canPost ? (
                <div className="flex flex-wrap gap-1.5">
                  <SuggestionButtons actions={suggestions} item={applicable} applyTitle="Apply this suggestion to the code now and mark the finding applied (A)" />
                  {canPost ? (
                    <button type="button" className={SUGGESTION_BUTTON} title="Post it to the pull request as a draft suggestion comment (gs)" onClick={() => void suggestions.post?.(item, suggestion)}>
                      Post to PR
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {item.edited ? (
            <button type="button" className={cn("self-start text-xs text-muted-foreground hover:underline", PRESS)} onClick={() => void onEdit(null)}>
              Revert to the reviewer's wording
            </button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        // Escape cancels the edit like the Cancel button and hands the keyboard back to the diff; ⌘↩ saves.
        <div data-escape-cancels="always" className={cn(CARD_BODY, enter.fade, FAST)}>
          <input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} onKeyDown={onFieldKeyDown} className={field} aria-label="Finding title" />
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} onKeyDown={onFieldKeyDown} rows={4} className={cn(field, "font-mono")} aria-label="Finding description" placeholder="Description (Markdown)" />
          <textarea value={draft.fix ?? ""} onChange={(event) => setDraft({ ...draft, fix: event.target.value })} onKeyDown={onFieldKeyDown} rows={3} className={cn(field, "font-mono")} aria-label="Suggested fix" placeholder="Suggested fix (optional)" />
          <div className="flex gap-2">
            <Button type="button" className={COMPACT} disabled={saving || draft.title.trim() === ""} onClick={() => void save()}>
              Save
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} data-escape-cancel="" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <p className={cn(CARD_FOOTER, enter.fade, FAST, !focused && "hidden")}>
        {[
          ...suggestionKeyHints(suggestions, applicable),
          canPost ? "gs post to PR" : null,
          item.selected ? "x exclude" : "x include",
          resolve === null ? null : "r resolve",
          editing ? null : "e edit",
          expanded ? "↩ fold" : "↩ unfold",
          "c next",
        ]
          .filter((hint) => hint !== null)
          .join(" · ")}
      </p>
    </div>
  );
}
