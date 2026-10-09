import { useState } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FindingEdit, FindingSeverity } from "../../types";
import { Button, COMPACT } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../utils";
import { CHEVRON, FAST, OPACITY_TRANSITION, PRESS, enter, useOpenedSinceMount } from "../ui/motion";
import { SEVERITY_LABEL, type InlineFinding } from "./findings";

const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bg-red-500", important: "bg-amber-500", minor: "bg-slate-400" };
const SEVERITY_BORDER: Record<FindingSeverity, string> = { critical: "border-red-500/70", important: "border-amber-500/70", minor: "border-border" };

/**
 * A review finding under the line it is about: one quiet strip (checkbox, severity, title, scores) that expands to the
 * description and fix, with inline editing of the wording the apply thread will receive.
 */
export function FindingAnnotation({
  item,
  entrance = true,
  onToggle,
  onEdit,
}: {
  item: InlineFinding;
  /** Read once, at mount: false when the finding was already on screen and only remounted. */
  entrance?: boolean;
  onToggle: (selected: boolean) => void;
  onEdit: (edit: FindingEdit | null) => Promise<void>;
}) {
  const { finding } = item;
  const [entering] = useState(entrance);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FindingEdit>({ title: finding.title, description: finding.description, fix: finding.fix });
  const [saving, setSaving] = useState(false);
  const beginEdit = () => {
    setDraft({ title: finding.title, description: finding.description, fix: finding.fix });
    setEditing(true);
    setOpen(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onEdit({ title: draft.title.trim(), description: draft.description, fix: draft.fix === null || draft.fix.trim() === "" ? null : draft.fix });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs";
  const reveal = useOpenedSinceMount(open) ? cn(enter.rise, FAST) : undefined;
  return (
    <div data-finding-anchor="" className={cn("my-0.5 min-w-0 max-w-full break-words border-l-2 pl-2 text-sm [&_pre]:max-w-full [&_pre]:overflow-x-auto", entering && [enter.fade, FAST], OPACITY_TRANSITION, SEVERITY_BORDER[finding.severity], !item.selected && "opacity-60")}>
      <div className="flex items-center gap-2 py-0.5 text-xs">
        <Checkbox checked={item.selected} onCheckedChange={(checked) => onToggle(checked === true)} aria-label={`${item.selected ? "Exclude" : "Include"} ${finding.id} in the apply round`} className="size-3.5" />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-bbm-open={open}>
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className="shrink-0 font-mono text-muted-foreground">{finding.id}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{finding.title}</span>
        </button>
        {finding.importance !== null && finding.scopeFit !== null ? (
          <span className="shrink-0 tabular-nums text-muted-foreground" title="importance / scope fit (1–5)">
            {finding.importance}/{finding.scopeFit}
          </span>
        ) : null}
        {item.isNew ? <span className="shrink-0 rounded border border-sky-500/50 px-1 text-[10px] text-sky-700 dark:text-sky-300" title="Reported since you last looked">new</span> : null}
        {item.carriedFrom !== null ? <span className="shrink-0 text-muted-foreground" title={`Still open from an earlier review, where it was ${item.carriedFrom}`}>carried</span> : null}
        {item.touched ? <span className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="These lines changed since you last looked">touched</span> : null}
        {item.edited ? <span className="shrink-0 text-muted-foreground" title="You reworded this finding">edited</span> : null}
        {item.overridden ? <span className="shrink-0 text-muted-foreground" title="You changed this from the suggested selection">manual</span> : null}
        {!editing ? (
          <button type="button" className={cn("rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} onClick={beginEdit}>
            Edit
          </button>
        ) : null}
      </div>
      {open && !editing ? (
        <div className={cn("flex flex-col gap-1 pb-1.5 text-sm", reveal)}>
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
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className={field} aria-label="Finding title" />
          <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={4} className={cn(field, "font-mono")} aria-label="Finding description" placeholder="Description (Markdown)" />
          <textarea value={draft.fix ?? ""} onChange={(event) => setDraft({ ...draft, fix: event.target.value })} rows={3} className={cn(field, "font-mono")} aria-label="Suggested fix" placeholder="Suggested fix (optional)" />
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
    </div>
  );
}
