import { useState, type KeyboardEvent } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FindingEdit, FindingSeverity } from "../../types";
import { Button, COMPACT } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../utils";
import { CHEVRON, FAST, OPACITY_TRANSITION, PRESS, enter, useOpenedSinceMount } from "../ui/motion";
import { SEVERITY_LABEL, type InlineFinding } from "./findings";
import { returnToDiff, useFindingControls, useIsFocused, useIsReading } from "../keys/review-keys-context";

const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bg-red-500", important: "bg-amber-500", minor: "bg-slate-400" };
const SEVERITY_BORDER: Record<FindingSeverity, string> = { critical: "border-red-500/70", important: "border-amber-500/70", minor: "border-border" };

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
  // Escape cancels the edit like the Cancel button and hands the keyboard back to the diff; ⌘↩ saves.
  const onFieldKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && draft.title.trim() !== "") void save();
    if (event.key !== "Escape") return;
    returnToDiff(event.currentTarget);
    setEditing(false);
  };
  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
  const reveal = useOpenedSinceMount(expanded) ? cn(enter.rise, FAST) : undefined;
  const meta = [
    finding.id,
    SEVERITY_LABEL[finding.severity],
    finding.importance !== null && finding.scopeFit !== null ? `importance ${finding.importance}/5 · scope fit ${finding.scopeFit}/5` : null,
    item.carriedFrom !== null ? `still open from ${item.carriedFrom}` : null,
    item.edited ? "reworded by you" : null,
    item.overridden ? (item.selected ? "included by you" : "excluded by you") : null,
  ].filter((part) => part !== null);
  return (
    <div data-finding-anchor="" className={cn("my-0.5 min-w-0 max-w-full break-words border-l-2 pl-2 text-sm [&_pre]:max-w-full [&_pre]:overflow-x-auto", entering && [enter.fade, FAST], OPACITY_TRANSITION, SEVERITY_BORDER[finding.severity], !item.selected && "opacity-60", focused && "rounded-r-md ring-1 ring-primary/70")}>
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <Checkbox checked={item.selected} onCheckedChange={(checked) => onToggle(checked === true)} aria-label={`${item.selected ? "Exclude" : "Include"} ${finding.id} in the apply round`} className="size-3.5" />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={toggle} aria-expanded={expanded} data-bbm-open={expanded}>
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className="min-w-0 flex-1 truncate text-foreground">{finding.title}</span>
        </button>
        {item.isNew ? <span className="shrink-0 rounded border border-sky-500/50 px-1 text-[10px] text-sky-700 dark:text-sky-300" title="Reported since you last looked">new</span> : null}
        {item.touched ? <span className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="These lines changed since you last looked">touched</span> : null}
      </div>
      {/* Mounted while folded: it opens as the cursor passes, and mounting it then restyles the whole page under bb
          themes with broad :has() rules. */}
      {!editing ? (
        <div className={cn("flex flex-col gap-1 pb-1.5 text-sm", reveal, !expanded && "hidden")}>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="min-w-0">{meta.join(" · ")}</span>
            <button type="button" className={cn("ml-auto rounded px-1 hover:bg-state-hover hover:text-foreground", PRESS)} onClick={beginEdit}>
              Edit
            </button>
          </div>
          {finding.description !== "" ? <Markdown content={finding.description} /> : <p className="text-muted-foreground">No description.</p>}
          {finding.fix !== null && finding.fix !== "" ? (
            <div className="flex gap-1.5">
              <Icon name="diff-view-wrench" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <Markdown content={finding.fix} className="min-w-0 flex-1" />
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
        <div className={cn("flex flex-col gap-1.5 pb-1.5", enter.fade, FAST)}>
          <input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} onKeyDown={onFieldKeyDown} className={field} aria-label="Finding title" />
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} onKeyDown={onFieldKeyDown} rows={4} className={cn(field, "font-mono")} aria-label="Finding description" placeholder="Description (Markdown)" />
          <textarea value={draft.fix ?? ""} onChange={(event) => setDraft({ ...draft, fix: event.target.value })} onKeyDown={onFieldKeyDown} rows={3} className={cn(field, "font-mono")} aria-label="Suggested fix" placeholder="Suggested fix (optional)" />
          <div className="flex gap-2">
            <Button type="button" className={COMPACT} disabled={saving || draft.title.trim() === ""} onClick={() => void save()}>
              Save
            </Button>
            <Button type="button" variant="ghost" className={COMPACT} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <p className={cn("pb-1 font-mono text-[10px] text-muted-foreground", enter.fade, FAST, !focused && "hidden")}>
        {[item.selected ? "x exclude" : "x include", editing ? null : "e edit", expanded ? "↩ fold" : "↩ unfold", "c next"].filter((hint) => hint !== null).join(" · ")}
      </p>
    </div>
  );
}
