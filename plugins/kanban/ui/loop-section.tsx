import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Board, Ticket } from "../shared/board";
import { formatPathRules, parsePathRules, type LoopGates, type PathRule } from "../shared/loop";
import { formatDuration, loopStages, type Holder, type LoopStages, type Stage } from "../shared/stages";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useNow, type Rpc } from "./data";
import type { RunAction } from "./actions";
import { LoopChip } from "./badges";
import { APPROVED_PLAN } from "./brief-panel";
import { BRIEF } from "./card-keys";
import { shortSha } from "./format";
import { GateRow, Tip, TipProvider } from "./gate-row";
import { HOLDS, SKIPS, type GateOption } from "./gates";
import { LoopMenu, pickLoopItem, type LoopActionHandlers } from "./loop-menu";
import { PAUSED_ON_QUESTION, PLAN_GATE_LATER, composerMode, loopMenuItems, planGateLater, type LoopMenuItemId } from "./loop-menu-items";
import { Badge, COMPACT, Group, KeyedButton, Switch } from "./primitives";

const ABOUT_LOOP =
  "Each time the card's thread reports its work ready, the board re-runs the checks, reviews the commit at a depth set by its risk, and sends the findings back to fix, until the change is clean or needs you. m opens the loop menu; off stops after the current step.";

function Subhead({ children }: { children: ReactNode }) {
  return <div className="px-1 pt-1 text-xs font-medium text-muted-foreground">{children}</div>;
}

/**
 * The card's review loop: its switch and status, the gates it runs with (chosen before it turns on, changeable after),
 * and, while it runs, the project's check command and path rules.
 */
export function LoopSection({
  ticket,
  gates,
  projectSettings,
  rpc,
  run,
  pending,
  onToggle,
  onGatesChange,
  onOpenThread,
  onOpenDiff,
  onLeave,
  menuOpen,
  onMenuOpenChange,
  composerMain,
}: {
  ticket: Ticket;
  gates: LoopGates;
  projectSettings: Board["projectSettings"];
  rpc: Rpc;
  run: RunAction;
  pending: boolean;
  onToggle: () => void;
  onGatesChange: (gates: LoopGates) => void;
  onOpenThread: (threadId: string) => void;
  /** Opens the card's changes page, where the review's findings annotate the diff. */
  onOpenDiff: () => void;
  onLeave: (field: HTMLElement) => void;
  /** The loop menu under `m`, opened by the key as well as its button. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Whether the composer is the card's main text box, which `i` goes to; the card decides, so the description box can yield. */
  composerMain: boolean;
}) {
  const monitored = ticket.loop?.monitored === true;
  const gateRow = (option: GateOption) => (
    <GateRow
      key={option.gate}
      option={option.gate === "plan" && planGateLater(ticket.loop) ? { ...option, hint: PLAN_GATE_LATER } : option}
      checked={gates[option.gate]}
      disabled={pending}
      onChange={(checked) => onGatesChange({ ...gates, [option.gate]: checked })}
    />
  );
  return (
    <TipProvider>
      <Group title="Review loop" summary={monitored ? <LoopChip ticket={ticket} /> : <span className="text-xs text-muted-foreground">off</span>} defaultOpen={monitored}>
        <div className="flex items-start gap-2.5 px-1">
          <Tip text={ABOUT_LOOP}>
            <span className="mt-0.5 inline-flex">
              <Switch checked={monitored} disabled={pending} onChange={onToggle} aria-label="Review loop: the board checks and reviews this card's work itself" />
            </span>
          </Tip>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm leading-5">{monitored ? "On" : "Off"}</span>
            <span className="text-xs text-muted-foreground">{aboutSwitch(ticket)}</span>
          </div>
        </div>
        {monitored ? (
          <LoopPipeline
            ticket={ticket}
            rpc={rpc}
            run={run}
            pending={pending}
            onOpenThread={onOpenThread}
            onOpenDiff={onOpenDiff}
            onLeave={onLeave}
            onToggle={onToggle}
            menuOpen={menuOpen}
            onMenuOpenChange={onMenuOpenChange}
            composerMain={composerMain}
          />
        ) : null}
        <div className="flex flex-col">
          <Subhead>Wait for you</Subhead>
          {HOLDS.map(gateRow)}
          <Subhead>Finish on its own</Subhead>
          {SKIPS.map(gateRow)}
        </div>
        {monitored && ticket.projectId !== null ? (
          <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-border px-1 pt-2.5">
            <dt className="text-xs text-muted-foreground">Checks</dt>
            <dd className="min-w-0">
              <CheckCommandEditor projectId={ticket.projectId} command={projectSettings[ticket.projectId]?.checkCommand ?? null} rpc={rpc} run={run} onLeave={onLeave} />
            </dd>
            <dt className="text-xs text-muted-foreground">Path rules</dt>
            <dd className="min-w-0">
              <PathRulesEditor projectId={ticket.projectId} rules={projectSettings[ticket.projectId]?.pathRules ?? []} rpc={rpc} run={run} onLeave={onLeave} />
            </dd>
          </dl>
        ) : null}
      </Group>
    </TipProvider>
  );
}

/** What the switch does for this card: already on, joining a running thread, or waiting for one. */
function aboutSwitch(ticket: Ticket): string {
  if (ticket.loop?.monitored === true) return "The board checks and reviews what the card's thread reports ready";
  if (ticket.threadId !== null) return "Joins the loop from here: the thread gets the loop's contract as a message, and the board checks and reviews what it reports ready from now on";
  return "Checks and reviews each commit the card's thread reports ready, and sends findings back to fix";
}

const HOLDER_TITLE: Record<Holder, string> = {
  agent: "The card's thread holds the ball",
  board: "The board's hidden threads hold the ball",
  you: "You hold the ball",
};

const STEP_DOT: Record<Stage["status"], string> = {
  done: "bg-foreground",
  current: "bg-primary ring-4 ring-primary/20",
  upcoming: "bg-muted-foreground/30",
  skipped: "border border-dashed border-muted-foreground/60 bg-transparent",
};

const STEP_TEXT: Record<Stage["status"], string> = {
  done: "text-foreground",
  current: "font-medium text-primary",
  upcoming: "text-muted-foreground",
  skipped: "text-muted-foreground/70 line-through decoration-muted-foreground/50",
};

/** How much of the approved plan the Plan step's title quotes. */
const PLAN_PREVIEW_CHARS = 200;

const scrollTo = (selector: string) => () => document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });

type StepTarget = { title: string; onPress: (() => void) | null };

/**
 * The loop as a strip of steps, who holds the ball, the current step's detail, a pill per round and the last checks
 * result; a pending directive is a banner with its undo. The steps are buttons, so the card's j/k reach them and Enter
 * opens what each produced.
 */
function LoopPipeline({
  ticket,
  rpc,
  run,
  pending,
  onOpenThread,
  onOpenDiff,
  onLeave,
  onToggle,
  menuOpen,
  onMenuOpenChange,
  composerMain,
}: {
  ticket: Ticket;
  rpc: Rpc;
  run: RunAction;
  pending: boolean;
  onOpenThread: (threadId: string) => void;
  onOpenDiff: () => void;
  onLeave: (field: HTMLElement) => void;
  onToggle: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  composerMain: boolean;
}) {
  const loop = ticket.loop!;
  const now = useNow(60_000);
  const stages = loopStages(loop, now);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const items = loopMenuItems(ticket);
  const item = (id: LoopMenuItemId) => items.find((entry) => entry.id === id)!;
  const focusComposer = () => {
    const field = composerRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };
  const handlers: LoopActionHandlers = { onCompose: focusComposer, onToggleMonitored: onToggle };
  const mode = composerMode(loop);
  const openThread = (threadId: string | null) => {
    if (threadId !== null) onOpenThread(threadId);
  };
  /** The thread running the current step: the card's own, one of the board's hidden ones, or the one whose failure stopped the loop. */
  const threadFor = (role: LoopStages["current"]["threadRole"]): string | null => {
    switch (role) {
      case "card":
        return ticket.threadId;
      case "checks":
        return loop.failedStep === "checks" ? loop.failedThreadId : ticket.checksThreadId;
      case "classify":
        return ticket.classifyThreadId;
      case "review":
        return loop.failedStep === "review" ? loop.failedThreadId : ticket.reviewThreadId;
      case null:
        return null;
    }
  };
  const currentThreadId = threadFor(stages.current.threadRole);
  const planTarget = (): StepTarget => {
    if (loop.phase === "planning") return { title: loop.proposedPlan === null ? "Scrolls to the plan the card's thread is proposing" : "Opens the proposed plan", onPress: scrollTo(BRIEF) };
    if (loop.plan === null) return { title: "The plan gate is off: no plan step", onPress: null };
    const preview = loop.plan.length > PLAN_PREVIEW_CHARS ? `${loop.plan.slice(0, PLAN_PREVIEW_CHARS)}…` : loop.plan;
    return { title: `Approved plan: ${preview}`, onPress: scrollTo(APPROVED_PLAN) };
  };
  /** The checks' own thread while they run, the failed one after a loop error, else the card's thread, which was sent the output. */
  const checksThread = (): { threadId: string | null; name: string } => {
    if (ticket.checksThreadId !== null) return { threadId: ticket.checksThreadId, name: "running checks" };
    if (loop.failedStep === "checks") return { threadId: loop.failedThreadId, name: "failed checks" };
    return { threadId: ticket.threadId, name: "card's" };
  };
  const stepTarget = (step: Stage): StepTarget => {
    switch (step.id) {
      case "plan":
        return planTarget();
      case "build":
      case "fix":
        return { title: `Opens the card's thread${step.detail === undefined ? "" : ` (${step.detail})`}`, onPress: ticket.threadId === null ? null : () => openThread(ticket.threadId) };
      case "checks": {
        const checks = stages.checks;
        const result = checks === null ? "no checks run yet" : `${checks.passed ? "passed" : `failed (exit code ${checks.exitCode})`} at ${shortSha(checks.commit)}`;
        const { threadId, name } = checksThread();
        return { title: `Checks ${result}; opens the ${name} thread`, onPress: threadId === null ? null : () => openThread(threadId) };
      }
      case "review":
        return {
          title: ticket.reviewThreadId === null ? "No review has run" : "Opens the changes with the review's findings",
          onPress: ticket.reviewThreadId === null ? null : onOpenDiff,
        };
      case "needs-you":
        return { title: "Scrolls to the handoff brief", onPress: step.status === "current" ? scrollTo(BRIEF) : null };
      case "land":
        return { title: step.status === "done" ? "Landed" : "The card's thread lands the change once you accept it", onPress: null };
    }
  };
  const action = (id: "steer" | "hand-off" | "stop", label: string, keyHint: string, onPress: () => void) => {
    const entry = item(id);
    return <KeyedButton label={label} keyHint={keyHint} title={entry.disabled ?? entry.hint ?? entry.label} data-kanban-loop-action={id} disabled={pending || entry.disabled !== null} onClick={onPress} />;
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2.5" data-kanban-loop-strip="">
      <ol className="flex items-start justify-between gap-1 px-1" aria-label="Review loop steps">
        {stages.steps.map((step, index) => {
          const target = stepTarget(step);
          return (
            <li key={step.id} className="relative flex min-w-0 flex-1 flex-col items-center">
              {index > 0 ? <span aria-hidden className={cn("absolute left-[-50%] right-1/2 top-[5px] h-px", step.status === "upcoming" || step.status === "skipped" ? "bg-border" : "bg-foreground/40")} /> : null}
              <button
                type="button"
                aria-current={step.status === "current" ? "step" : undefined}
                aria-label={`${step.label}: ${step.status}${step.detail === undefined ? "" : `, ${step.detail}`}`}
                title={target.title}
                disabled={target.onPress === null}
                onClick={target.onPress ?? undefined}
                className={cn("relative z-10 flex flex-col items-center gap-1 rounded px-0.5 pb-0.5 text-[10px] leading-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", STEP_TEXT[step.status], target.onPress !== null && "hover:text-foreground")}
              >
                <span aria-hidden className={cn("mt-[1px] size-2.5 rounded-full", STEP_DOT[step.status])} />
                <span className="truncate">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-1 px-1" role="status" aria-label={stages.holder === null ? "Nobody holds the ball" : HOLDER_TITLE[stages.holder]}>
        {(["agent", "board", "you"] as const).map((holder) => (
          <span
            key={holder}
            title={HOLDER_TITLE[holder]}
            className={cn("flex-1 rounded px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide", stages.holder === holder ? "bg-foreground/10 text-foreground" : "text-muted-foreground/50")}
          >
            {holder}
          </span>
        ))}
      </div>
      {stages.directive === null ? null : (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-200">
          <span className="min-w-0 flex-1">{stages.directive.text}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(() => rpc.call("loop_clear_directive", { id: ticket.id }), "Taken back; the loop carries on as before")}
            className="shrink-0 rounded px-1 font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 px-1" aria-label="Loop actions">
        {action("steer", "Steer", "s", focusComposer)}
        {action("hand-off", "Hand to me", "f", () => pickLoopItem("hand-off", ticket, rpc, run, handlers))}
        {action("stop", "Stop now", "x", () => pickLoopItem("stop", ticket, rpc, run, handlers))}
        <LoopMenu ticket={ticket} rpc={rpc} run={run} open={menuOpen} onOpenChange={onMenuOpenChange} handlers={handlers}>
          <KeyedButton label="Loop menu" keyHint="m" title="Every intervention, the gates, and loop off" data-kanban-loop-action="menu" />
        </LoopMenu>
      </div>
      {mode === "paused" ? (
        <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{PAUSED_ON_QUESTION}</span>
          {ticket.threadId === null ? null : (
            <Button type="button" variant="secondary" className={COMPACT} onClick={() => onOpenThread(ticket.threadId!)}>
              Open thread
            </Button>
          )}
        </div>
      ) : mode === null ? null : (
        <LoopComposer fieldRef={composerRef} ticket={ticket} mode={mode} rpc={rpc} run={run} pending={pending} mainInput={composerMain} />
      )}
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-1 text-xs">
        <dt className="text-muted-foreground">Now</dt>
        <dd className="flex min-w-0 flex-col gap-0.5">
          <span>{stages.current.text}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {stages.current.commit === null ? null : <code className="font-mono">{shortSha(stages.current.commit)}</code>}
            {stages.current.elapsedMs === null ? null : <span title="Since this step began">{formatDuration(stages.current.elapsedMs)}</span>}
            {currentThreadId === null ? null : (
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => openThread(currentThreadId)}>
                open the thread
              </button>
            )}
          </span>
        </dd>
        <dt className="text-muted-foreground">Rounds</dt>
        <dd className="flex flex-wrap items-center gap-1">
          {stages.rounds.length === 0 ? <span className="text-muted-foreground">none yet</span> : stages.rounds.map((pill, index) => <Badge key={index} tone={pill.tone} title={pill.title}>{pill.label}</Badge>)}
          <span className="text-muted-foreground" title="Automatic fix rounds used of the cap; rounds you start don't count">
            {stages.cap.used} of {stages.cap.max}
          </span>
          {stages.manualRetries === 0 ? null : (
            <span className="text-muted-foreground" title="Steps you started again after a loop error">
              · retried {stages.manualRetries}×
            </span>
          )}
        </dd>
        {stages.checks === null ? null : (
          <>
            <dt className="text-muted-foreground">Checks</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <Badge tone={stages.checks.passed ? "success" : "danger"}>{stages.checks.passed ? "passed" : "failed"}</Badge>
              {stages.checks.command === null ? null : <code className="truncate font-mono">{stages.checks.command}</code>}
              <span className="text-muted-foreground">
                exit {stages.checks.exitCode} at <code className="font-mono">{shortSha(stages.checks.commit)}</code>
              </span>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * One line to the card's thread that grows as it is typed in: steering while the loop runs, Resume with a message at
 * Needs you. Enter sends, Shift-Enter breaks a line; Escape is the card's (bb-vim-keys' text-box Escape), and returns
 * to the keys. While it is the card's main text box, `i` reaches it.
 */
function LoopComposer({
  fieldRef: ref,
  ticket,
  mode,
  rpc,
  run,
  pending,
  mainInput,
}: {
  /** Its own name: a `ref` prop reaches a function component only on React 19. */
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  ticket: Ticket;
  mode: "steer" | "resume";
  rpc: Rpc;
  run: RunAction;
  pending: boolean;
  mainInput: boolean;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [ticket.id]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${field.scrollHeight}px`;
  }, [value, ref]);
  const noThread = ticket.threadId === null;
  const send = () => {
    const message = value.trim();
    if (message === "" || pending || noThread) return;
    void run(
      async () => {
        await (mode === "resume" ? rpc.call("loop_resume", { id: ticket.id, message }) : rpc.call("loop_steer", { id: ticket.id, message }));
        setValue("");
      },
      mode === "resume" ? "Resumed; the thread carries on with your message as a round of yours" : "Sent to the card's thread as steering",
    );
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      disabled={noThread}
      data-kanban-loop-composer=""
      {...(mainInput ? { "data-kanban-main-input": "" } : {})}
      aria-label={mode === "resume" ? "Resume with a message" : "Steer the thread"}
      placeholder={noThread ? "The card has no thread to steer" : mode === "resume" ? "Resume with a message… (Enter sends)" : "Steer the thread… (Enter sends)"}
      title={mode === "resume" ? "Back to building with your words, as a round of yours" : "Goes to the card's thread as steering: it carries on and reports ready as before"}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        send();
      }}
      className="w-full resize-none overflow-hidden rounded-md border border-input bg-transparent px-2 py-1 text-xs leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
    />
  );
}

/** The project's check command, shared by every monitored card in it; empty leaves the choice to each card's agent. Saves on blur. */
function CheckCommandEditor({ projectId, command, rpc, run, onLeave }: { projectId: string; command: string | null; rpc: Rpc; run: RunAction; onLeave: (field: HTMLElement) => void }) {
  const [value, setValue] = useState(command ?? "");
  useEffect(() => setValue(command ?? ""), [projectId, command]);
  const save = () => {
    const next = value.trim() === "" ? null : value.trim();
    if (next === command) return;
    void run(() => rpc.call("project_set_check_command", { projectId, checkCommand: next }), next === null ? "Check command cleared" : "Check command saved");
  };
  return (
    <input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onLeave(event.currentTarget);
      }}
      aria-label="The project's check command"
      placeholder="The agent picks one, e.g. pnpm typecheck && pnpm test"
      title="Re-run by the board at every ready commit of a monitored card in this project"
      className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

/** The project's path rules, written `<glob> <level>` and comma-separated. Saves on blur; an entry that isn't a rule keeps the old ones. */
function PathRulesEditor({ projectId, rules, rpc, run, onLeave }: { projectId: string; rules: PathRule[]; rpc: Rpc; run: RunAction; onLeave: (field: HTMLElement) => void }) {
  const saved = formatPathRules(rules);
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [projectId, saved]);
  const save = () => {
    const parsed = parsePathRules(value);
    if ("invalid" in parsed) {
      void run(async () => {
        throw new Error(`"${parsed.invalid}" isn't a path rule; write a glob and glance, read or scrutinize`);
      });
      return;
    }
    if (formatPathRules(parsed.rules) === saved) return;
    void run(() => rpc.call("project_set_path_rules", { projectId, pathRules: parsed.rules }), parsed.rules.length === 0 ? "Path rules cleared" : "Path rules saved");
  };
  return (
    <input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onLeave(event.currentTarget);
      }}
      aria-label="The project's path rules"
      placeholder="e.g. src/auth/** scrutinize, .github/** read"
      title="Changed files matching a glob get at least its attention level, and the review at least the matching depth"
      className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
