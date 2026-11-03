import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { LIFT, OPACITY_TRANSITION, PRESS, STAGGER, enter, speed, stagger } from "bb-motion";
import type { rpcContract } from "../contract";
import type { Column } from "../shared/board";
import { todoColumnId } from "../shared/columns";
import type { Dump, ProposedTicket } from "../shared/dump";
import { BOARD_CHANGED } from "../shared/events";
import { plural } from "../shared/format";
import { defaultGates } from "../shared/loop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import { useNow } from "./data";
import { Badge, Select, COMPACT, Group } from "./primitives";
import { RunModeControl } from "./run-mode";
import { runModeFlags, type RunMode } from "./run-mode-flags";
import { TagBadges } from "./tags";
import { usePendingAction, toastError } from "./actions";

function DumpStatusBadge({ dump }: { dump: Dump }) {
  switch (dump.status) {
    case "planning":
      return <Badge tone="accent">planning…</Badge>;
    case "ready":
      return <Badge tone="success">ready to review</Badge>;
    case "failed":
      return <Badge tone="danger">failed</Badge>;
    case "done":
      return <Badge>created</Badge>;
    default:
      return <Badge>discarded</Badge>;
  }
}

export function ProposalsList({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [dumps, setDumps] = useState<Dump[] | null>(null);
  const now = useNow();
  const load = useCallback(() => {
    rpc.call("dumps_list", { includeClosed: true }).then((result) => setDumps(result.dumps), toastError);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(BOARD_CHANGED, load);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 md:p-5">
      {dumps === null ? <p className={cn("text-sm text-muted-foreground", enter.fade)}>Loading…</p> : null}
      {dumps !== null && dumps.length === 0 ? (
        <p className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground", enter.fade)}>
          No brain dumps yet. Use New card → Brain dump to dictate one.
        </p>
      ) : null}
      {dumps?.map((dump, index) => (
        <button
          key={dump.id}
          type="button"
          onClick={() => onOpen(dump.id)}
          style={stagger(index)}
          className={cn("relative flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left hover:border-foreground/30", enter.rise, STAGGER, LIFT, PRESS)}
        >
          <div className="flex items-center gap-2">
            <DumpStatusBadge dump={dump} />
            {dump.proposal !== null ? (
              <span className="text-xs text-muted-foreground">
                {plural(dump.proposal.tickets.length, "ticket")}
                {dump.proposal.questions.length > 0 ? ` · ${plural(dump.proposal.questions.length, "question")}` : ""}
              </span>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">{relativeTime(dump.updatedAt, now)}</span>
          </div>
          <p className="line-clamp-2 text-sm">{dump.text}</p>
        </button>
      ))}
    </div>
  );
}

export function ProposalView({ dumpId, columns, onBack, onOpenThread, onOpenTicket }: { dumpId: string; columns: Column[]; onBack: () => void; onOpenThread: (threadId: string) => void; onOpenTicket: (ticketId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [dump, setDump] = useState<Dump | null>(null);
  const [drafts, setDrafts] = useState<Array<ProposedTicket & { include: boolean }>>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [columnId, setColumnId] = useState(todoColumnId(columns) ?? "");
  // The dump has a project, so the cards default to a thread as the new-card dialog's do.
  const [runMode, setRunMode] = useState<RunMode>("thread");
  const [gates, setGates] = useState(() => defaultGates("adhoc"));
  const [showText, setShowText] = useState(false);
  const loadedProposal = useRef<string | null>(null);
  const load = useCallback(() => {
    rpc.call("dumps_list", { includeClosed: true }).then(
      (result) => setDump(result.dumps.find((entry) => entry.id === dumpId) ?? null),
      toastError,
    );
  }, [rpc, dumpId]);
  useEffect(load, [load]);
  useRealtime(BOARD_CHANGED, load);
  const { pending, run } = usePendingAction(load);
  // Seed editable drafts from each new proposal revision, keeping user edits between realtime refreshes.
  useEffect(() => {
    if (dump?.proposal === null || dump?.proposal === undefined) return;
    const key = JSON.stringify(dump.proposal);
    if (loadedProposal.current === key) return;
    loadedProposal.current = key;
    setDrafts(dump.proposal.tickets.map((ticket) => ({ ...ticket, include: true })));
    setAnswers(Object.fromEntries(dump.proposal.questions.map((question) => [question.id, dump.answers[question.id] ?? ""])));
  }, [dump]);

  const updateDraft = (id: string, patch: Partial<ProposedTicket & { include: boolean }>) =>
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  const included = drafts.filter((draft) => draft.include);

  if (dump === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading…{" "}
        <button type="button" className="underline" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  const closed = dump.status === "done" || dump.status === "discarded";
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <DumpStatusBadge dump={dump} />
        {dump.threadId !== null ? (
          <Button type="button" variant="ghost" className={COMPACT} onClick={() => onOpenThread(dump.threadId!)}>
            <Icon name="MessageSquare" className="size-3.5" />
            Planning thread
          </Button>
        ) : null}
        <Button type="button" variant="ghost" className={COMPACT} onClick={() => setShowText((value) => !value)}>
          {showText ? "Hide dictation" : "Show dictation"}
        </Button>
        {!closed ? (
          <Button type="button" variant="ghost" className={cn(COMPACT, "ml-auto text-muted-foreground hover:text-destructive")} disabled={pending} onClick={() => void run(() => rpc.call("dump_discard", { id: dump.id }), "Discarded")}>
            <Icon name="Trash2" className="size-3.5" />
            Discard
          </Button>
        ) : null}
      </div>
      {showText ? <pre className={cn("whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs", enter.rise, speed.fast)}>{dump.text}</pre> : null}
      {dump.status === "planning" ? (
        <p className={cn("rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground", enter.fade)}>The agent is reading the project and drafting tickets. This page updates when it finishes; you can leave.</p>
      ) : null}
      {dump.status === "failed" ? (
        <div className={cn("flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm", enter.rise)}>
          <p className="text-destructive">Planning did not produce a proposal.</p>
          {dump.error !== null ? <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{dump.error}</pre> : null}
          <div>
            <Button type="button" variant="secondary" className={COMPACT} disabled={pending || dump.threadId === null} onClick={() => void run(() => rpc.call("dump_refine", { id: dump.id, notes: "Please try again and make sure to end with the kanban-proposal block." }), "Asked the thread to retry")}>
              Ask it to try again
            </Button>
          </div>
        </div>
      ) : null}
      {dump.proposal !== null ? (
        <>
          {dump.proposal.summary !== "" ? <Markdown content={dump.proposal.summary} className="text-sm" /> : null}
          {dump.proposal.questions.length > 0 && !closed ? (
            <Group title={`Open questions (${dump.proposal.questions.length})`} defaultOpen>
              {dump.proposal.questions.map((question, index) => (
                <div key={question.id} style={stagger(index)} className={cn("flex flex-col gap-1 rounded-md border border-border p-2.5", enter.rise, speed.fast, STAGGER)}>
                  <div className="flex items-start gap-2 text-sm">
                    <Badge tone="warning">{question.id}</Badge>
                    <span className="min-w-0 flex-1 font-medium">{question.question}</span>
                  </div>
                  {question.why !== "" ? <p className="text-xs text-muted-foreground">{question.why}</p> : null}
                  {question.affects.length > 0 ? <p className="text-xs text-muted-foreground">Affects: {question.affects.join(", ")}</p> : null}
                  {question.options.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {question.options.map((option) => (
                        <button key={option} type="button" className={cn("rounded-full border px-2 py-0.5 text-xs", PRESS, answers[question.id] === option ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Input value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Your answer…" aria-label={`Answer to ${question.id}`} className="h-7 text-xs" />
                </div>
              ))}
              <textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} placeholder="Anything else to tell the planner (optional)" aria-label="Notes for the planner" className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <div>
                <Button type="button" variant="secondary" className={COMPACT} disabled={pending || dump.status === "planning"} onClick={() => void run(() => rpc.call("dump_refine", { id: dump.id, answers, notes }), "Sent to the planner")}>
                  <Icon name="kanban-refresh" className="size-3.5" />
                  Send answers & refine
                </Button>
              </div>
            </Group>
          ) : null}
          <Group title={`Proposed tickets (${included.length}/${drafts.length})`} defaultOpen>
            <ul className="flex flex-col gap-2">
              {drafts.map((draft, index) => (
                <li
                  key={draft.id}
                  style={stagger(index)}
                  className={cn("flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5", enter.rise, speed.fast, STAGGER, OPACITY_TRANSITION, !draft.include && "opacity-60")}
                >
                  <div className="flex items-start gap-2">
                    {!closed ? <Checkbox checked={draft.include} onCheckedChange={(checked) => updateDraft(draft.id, { include: checked === true })} aria-label={`Include ${draft.id}`} className="mt-1" /> : null}
                    <Badge>{draft.id}</Badge>
                    {closed ? (
                      <span className="min-w-0 flex-1 text-sm font-medium">{draft.title}</span>
                    ) : (
                      <input value={draft.title} onChange={(event) => updateDraft(draft.id, { title: event.target.value })} aria-label={`Title of ${draft.id}`} className="min-w-0 flex-1 rounded bg-transparent px-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                    )}
                    {draft.estimate !== null ? <Badge tone="outline">{draft.estimate}</Badge> : null}
                    {draft.dependsOn.length > 0 ? <Badge tone="outline" title="Depends on">after {draft.dependsOn.join(", ")}</Badge> : null}
                  </div>
                  {closed ? (
                    draft.description !== "" ? <Markdown content={draft.description} className="text-sm" /> : null
                  ) : (
                    <textarea value={draft.description} rows={3} onChange={(event) => updateDraft(draft.id, { description: event.target.value })} aria-label={`Description of ${draft.id}`} className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    <TagBadges tags={draft.tags} onRemove={closed ? undefined : (tag) => updateDraft(draft.id, { tags: draft.tags.filter((entry) => entry !== tag) })} />
                    {!closed ? (
                      <input
                        placeholder="+ tag"
                        aria-label={`Add tag to ${draft.id}`}
                        className="h-6 w-20 bg-transparent px-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none"
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          const value = (event.target as HTMLInputElement).value.trim().toLowerCase();
                          if (value === "") return;
                          updateDraft(draft.id, { tags: [...new Set([...draft.tags, value])] });
                          (event.target as HTMLInputElement).value = "";
                        }}
                      />
                    ) : null}
                  </div>
                  {draft.subtasks.length > 0 ? (
                    <ul className="ml-4 list-disc text-xs text-muted-foreground">
                      {draft.subtasks.map((sub, index) => (
                        <li key={index} className="flex items-center gap-1">
                          <span className="flex-1">{sub.title}</span>
                          {!closed ? (
                            <button type="button" aria-label={`Remove subtask ${sub.title}`} className={cn("text-muted-foreground hover:text-destructive", PRESS)} onClick={() => updateDraft(draft.id, { subtasks: draft.subtasks.filter((_, i) => i !== index) })}>
                              <Icon name="X" className="size-3" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {!closed ? (
              <div className="flex flex-col gap-2 border-t border-border pt-2">
                <RunModeControl value={runMode} onChange={setRunMode} gates={gates} onGatesChange={setGates} hasProject disabled={pending} />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Column
                    <Select aria-label="Column for new cards" value={columnId} onChange={setColumnId} className="h-7 w-auto">
                      {columns.map((column) => (
                        <option key={column.id} value={column.id}>
                          {column.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <Button
                    type="button"
                    className={cn(COMPACT, "ml-auto")}
                    disabled={pending || included.length === 0 || dump.status === "planning"}
                    onClick={() => {
                      const { startThread, ...flags } = runModeFlags(runMode, gates);
                      void run(
                        () => rpc.call("dump_finalize", { id: dump.id, tickets: included.map(({ include, ...ticket }) => ticket), columnId, startThreads: startThread, ...flags }),
                        `Created ${plural(included.length, "card")}`,
                      );
                    }}
                  >
                    <Icon name="Plus" className="size-3.5" />
                    Create {plural(included.length, "card")}
                    {runMode === "card" ? "" : " and start"}
                  </Button>
                </div>
              </div>
            ) : null}
            {dump.status === "done" && dump.createdTicketIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
                Created:
                {dump.createdTicketIds.map((id) => (
                  <button key={id} type="button" className={cn("rounded border border-border px-1.5 py-0.5 font-mono hover:text-foreground", PRESS, enter.pop)} onClick={() => onOpenTicket(id)}>
                    {id}
                  </button>
                ))}
              </div>
            ) : null}
          </Group>
        </>
      ) : null}
    </div>
  );
}
