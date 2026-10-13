import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { PRESS, enter, speed } from "bb-motion";
import type { Column } from "../shared/board";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage, parseQuickAdd, parseTagList } from "./format";
import { type Rpc, type ProjectOption } from "./data";
import { Select, Textarea, SegmentedTabs } from "./primitives";
import { ProjectSelect } from "./project-select";
import { toastError } from "./actions";

/** Records microphone audio and transcribes it with bb's voice service. */
function useDictation(onText: (text: string) => void) {
  const sdk = useSdk();
  const [state, setState] = useState<"idle" | "recording" | "transcribing" | "unsupported">(() =>
    typeof navigator === "undefined" || navigator.mediaDevices === undefined || typeof MediaRecorder === "undefined" ? "unsupported" : "idle",
  );
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const media = new MediaRecorder(stream, mime === undefined ? undefined : { mimeType: mime });
      chunks.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      media.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const result = await sdk.system.transcribeVoice({ file: blob, prompt: "Software tasks, tickets, pull requests, code names." });
          const text = (result as { text?: string; transcript?: string }).text ?? (result as { transcript?: string }).transcript ?? "";
          if (text.trim() !== "") onText(text.trim());
        } catch (cause) {
          toast.error(`Transcription failed: ${errorMessage(cause)}`);
        } finally {
          setState("idle");
        }
      };
      recorder.current = media;
      media.start();
      setState("recording");
    } catch (cause) {
      toast.error(`Microphone unavailable: ${errorMessage(cause)}`);
      setState("idle");
    }
  };
  const stop = () => recorder.current?.stop();
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((track) => track.stop()), []);
  return { state, start, stop };
}

type SubtaskDraft = { key: number; text: string };

/** Subtask titles typed while creating a card; Enter adds one instead of submitting the card. */
function SubtaskDrafts({
  drafts,
  onChange,
  text,
  onTextChange,
}: {
  drafts: readonly SubtaskDraft[];
  onChange: (drafts: SubtaskDraft[]) => void;
  text: string;
  onTextChange: (text: string) => void;
}) {
  const nextKey = useRef(0);
  const addInput = useRef<HTMLInputElement>(null);
  const add = () => {
    if (parseQuickAdd(text).title === "") return;
    nextKey.current += 1;
    onChange([...drafts, { key: nextKey.current, text }]);
    onTextChange("");
  };
  const remove = (key: number) => {
    onChange(drafts.filter((draft) => draft.key !== key));
    addInput.current?.focus();
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLInputElement>, draft: SubtaskDraft) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addInput.current?.focus();
    } else if (event.key === "Backspace" && draft.text === "") {
      event.preventDefault();
      remove(draft.key);
    }
  };
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      Subtasks
      {drafts.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {drafts.map((draft, index) => (
            <li key={draft.key} className={cn("flex items-center gap-1.5 rounded px-1 hover:bg-state-hover", enter.rise, speed.fast)}>
              <Icon name="ListTodo" className="size-3.5 shrink-0" />
              <input
                value={draft.text}
                onChange={(event) => onChange(drafts.map((entry) => (entry.key === draft.key ? { ...entry, text: event.target.value } : entry)))}
                onKeyDown={(event) => onRowKeyDown(event, draft)}
                aria-label={`Subtask ${index + 1}`}
                className="h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground focus-visible:outline-none"
              />
              <button type="button" aria-label={`Remove subtask ${index + 1}`} className={cn("flex size-6 shrink-0 items-center justify-center rounded hover:text-destructive", PRESS)} onClick={() => remove(draft.key)}>
                <Icon name="X" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        ref={addInput}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
        placeholder="Add a subtask… (Enter to add, #tag allowed)"
        aria-label="New subtask"
      />
    </div>
  );
}

const MODE_OPTIONS = [
  { value: "single", label: "One card" },
  { value: "dump", label: "Brain dump" },
] as const;

export function NewTicketDialog({
  open,
  onOpenChange,
  columns,
  initialColumnId,
  projects,
  rpc,
  onCreated,
  onOpenProposals,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: Column[];
  initialColumnId: string | null;
  projects: ProjectOption[];
  rpc: Rpc;
  onCreated: () => void;
  onOpenProposals: () => void;
}) {
  const [mode, setMode] = useState<"single" | "dump">("single");
  // The dialog scales in on open; only a mode switch animates its body.
  const [switched, setSwitched] = useState(false);
  const bodyMotion = switched ? cn(enter.rise, speed.fast) : undefined;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [subtasks, setSubtasks] = useState<SubtaskDraft[]>([]);
  const [subtaskText, setSubtaskText] = useState("");
  const [columnId, setColumnId] = useState(initialColumnId ?? columns[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [startThread, setStartThread] = useState(true);
  const [pending, setPending] = useState(false);
  const [dump, setDump] = useState("");
  const [dumpProject, setDumpProject] = useState("");
  const dictation = useDictation((text) => setDump((current) => (current.trim() === "" ? text : `${current.trimEnd()}\n\n${text}`)));
  useEffect(() => {
    if (open) {
      setColumnId(initialColumnId ?? columns[0]?.id ?? "");
      if (dumpProject === "" && projects[0] !== undefined) setDumpProject(projects[0].id);
    }
  }, [open, initialColumnId, columns, projects, dumpProject]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    const parsed = parseQuickAdd(title);
    const extraTags = parseTagList(tags);
    // Text still in the add box counts, so the last subtask is not lost to a missed Enter.
    const subtaskList = [...subtasks.map((draft) => draft.text), subtaskText].map(parseQuickAdd).filter((subtask) => subtask.title !== "");
    try {
      await rpc.call("ticket_create", {
        title: parsed.title,
        description,
        columnId,
        tags: [...new Set([...parsed.tags, ...extraTags])],
        dueDate: dueDate === "" ? null : dueDate,
        projectId: projectId === "" ? null : projectId,
        startThread: projectId !== "" && startThread,
        subtasks: subtaskList,
      });
      setTitle("");
      setDescription("");
      setTags("");
      setDueDate("");
      setSubtasks([]);
      setSubtaskText("");
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      toastError(cause);
    } finally {
      setPending(false);
    }
  };
  const submitDump = async () => {
    if (dump.trim() === "" || dumpProject === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("dump_create", { text: dump.trim(), projectId: dumpProject });
      setDump("");
      onOpenChange(false);
      onCreated();
      toast.success("Planning in the background. Check Proposals when it is done.");
    } catch (cause) {
      toastError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="sr-only">New card</DialogTitle>
          <DialogDescription className="sr-only">Create one card, or dictate a brain dump to be planned into several.</DialogDescription>
          <SegmentedTabs
            label="Mode"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(entry) => {
              setSwitched(true);
              setMode(entry);
            }}
            className="w-fit"
            tabClassName="px-2.5 py-1"
          />
        </DialogHeader>
        {mode === "single" ? (
          <form onSubmit={submit} className={cn("flex flex-col gap-4", bodyMotion)}>
            <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title (use #tag for tags)" aria-label="Title" />
            <Textarea aria-label="Description" value={description} onChange={setDescription} placeholder="What needs to happen? (markdown, sent to the agent as the first prompt)" />
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma or space separated" aria-label="Tags" />
            <SubtaskDrafts drafts={subtasks} onChange={setSubtasks} text={subtaskText} onTextChange={setSubtaskText} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Column
                <Select aria-label="Column" value={columnId} onChange={setColumnId}>
                  {columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Project
                <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} allowNone />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Due date
                <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="Due date" />
              </label>
            </div>
            <label className={cn("flex items-center gap-2 text-sm", projectId === "" && "pointer-events-none opacity-50")}>
              <Checkbox checked={startThread} onCheckedChange={(checked) => setStartThread(checked === true)} aria-label="Start a thread now" />
              Start a thread now
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || parseQuickAdd(title).title === ""}>
                Create
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className={cn("flex flex-col gap-3", bodyMotion)}>
            <p className="text-xs text-muted-foreground">
              Ramble about everything that needs doing. An agent reads the project, splits it into proposed cards with open questions, and you review the result under Proposals when it is ready.
            </p>
            <div className="relative">
              <textarea
                autoFocus
                value={dump}
                rows={9}
                onChange={(event) => setDump(event.target.value)}
                placeholder="e.g. We need to move billing to the new payments service, the dashboard still shows stale invoices, also someone should look at why the email worker drops…"
                aria-label="Brain dump"
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 pr-12 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {dictation.state !== "unsupported" ? (
                <button
                  type="button"
                  aria-label={dictation.state === "recording" ? "Stop dictating" : "Dictate"}
                  title={dictation.state === "recording" ? "Stop dictating" : "Dictate with your microphone"}
                  disabled={dictation.state === "transcribing"}
                  onClick={() => (dictation.state === "recording" ? dictation.stop() : void dictation.start())}
                  className={cn(
                    "absolute right-2 top-2 flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground",
                    PRESS,
                    dictation.state === "recording" && "animate-pulse border-destructive bg-destructive/10 text-destructive",
                    dictation.state === "transcribing" && "opacity-60",
                  )}
                >
                  <Icon name={dictation.state === "transcribing" ? "kanban-refresh" : "Mic"} className={cn("size-4", dictation.state === "transcribing" && "animate-spin")} />
                </button>
              ) : null}
            </div>
            {dictation.state === "recording" ? <p className={cn("text-xs text-destructive", enter.fade)}>Recording… press the mic again to stop and transcribe.</p> : null}
            {dictation.state === "transcribing" ? <p className={cn("text-xs text-muted-foreground", enter.fade)}>Transcribing…</p> : null}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Project the agent should read while planning
              <ProjectSelect projects={projects} value={dumpProject} onChange={setDumpProject} allowNone={false} />
            </label>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" className="text-muted-foreground" onClick={onOpenProposals}>
                View proposals
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={pending || dump.trim() === "" || dumpProject === "" || dictation.state !== "idle"} onClick={() => void submitDump()}>
                  <Icon name="kanban-search-check" className="size-4" />
                  Plan tickets in background
                </Button>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
