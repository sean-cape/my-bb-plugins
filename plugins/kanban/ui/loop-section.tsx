import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Board, Ticket } from "../shared/board";
import { ATTENTION_LEVEL_LABEL, NEEDS_YOU_REASON_LABEL, formatPathRules, parsePathRules, phaseChip, type LoopGates, type PathRule } from "../shared/loop";
import { Checkbox } from "@/components/ui/checkbox";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { Rpc } from "./data";
import type { RunAction } from "./actions";
import { LoopChip } from "./badges";
import { Group, Switch } from "./primitives";

type GateOption = { gate: keyof LoopGates; label: string; hint: string; detail: string };

const HOLDS: GateOption[] = [
  {
    gate: "plan",
    label: "Plan approval",
    hint: "Building waits until you approve a plan",
    detail: "The card's thread proposes a plan and the card waits in planning. Approve it, edited or not, with Y; the approved plan goes to the thread and into every review.",
  },
  {
    gate: "findings",
    label: "Findings approval",
    hint: "Each round's fixes wait for you",
    detail: "Each review round stops at Needs you. Untick the findings you don't want fixed and approve the rest with Y; the unticked stay open.",
  },
];

const SKIPS: GateOption[] = [
  {
    gate: "autoAccept",
    label: "Auto-accept",
    hint: "A clean, low-risk change is accepted for you",
    detail: "A change that ends clean at Glance, with no critical or important finding or dispute open, is accepted without stopping at Needs you. Never at Read or Scrutinize; open minors are listed on the card.",
  },
];

const ABOUT_LOOP =
  "Each time the card's thread reports its work ready, the board re-runs the checks, reviews the commit at a depth set by its risk, and sends the findings back to fix, until the change is clean or needs you. Press m to turn it on or off; off stops after the current step.";

/** A tooltip that opens on hover and when the keys reach its trigger, for the longer story behind a short label. */
function Tip({ text, children }: { text: string; children: ReactElement }) {
  const portalScope = usePortalScopeProps();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          {...portalScope}
          side="left"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          className="z-50 max-w-64 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Subhead({ children }: { children: ReactNode }) {
  return <div className="px-1 pt-1 text-xs font-medium text-muted-foreground">{children}</div>;
}

function GateRow({ option, checked, disabled, onChange }: { option: GateOption; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Tip text={option.detail}>
      <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-state-hover">
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(next === true)} aria-label={`${option.label}: ${option.hint}`} className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span className="text-sm leading-5">{option.label}</span>
          <span className="text-xs text-muted-foreground">{option.hint}</span>
        </span>
      </label>
    </Tip>
  );
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
  onLeave,
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
  onLeave: (field: HTMLElement) => void;
}) {
  const monitored = ticket.loop?.monitored === true;
  const gateRow = (option: GateOption) => (
    <GateRow key={option.gate} option={option} checked={gates[option.gate]} disabled={pending} onChange={(checked) => onGatesChange({ ...gates, [option.gate]: checked })} />
  );
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <Group title="Review loop" summary={monitored ? <LoopChip ticket={ticket} /> : <span className="text-xs text-muted-foreground">off</span>} defaultOpen={monitored}>
        <div className="flex items-start gap-2.5 px-1">
          <Tip text={ABOUT_LOOP}>
            <span className="mt-0.5 inline-flex">
              <Switch checked={monitored} disabled={pending} onChange={onToggle} aria-label="Review loop: the board checks and reviews this card's work itself" />
            </span>
          </Tip>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm leading-5">
              {monitored ? "On" : "Off"}
              <kbd className="font-mono text-[10px] text-muted-foreground">m</kbd>
            </span>
            {monitored ? (
              <LoopStatus ticket={ticket} onOpenThread={onOpenThread} />
            ) : (
              <span className="text-xs text-muted-foreground">Checks and reviews each commit the card's thread reports ready, and sends findings back to fix</span>
            )}
          </div>
        </div>
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
    </Tooltip.Provider>
  );
}

/** One line on where the loop stands, beyond what the chip says. */
function LoopStatus({ ticket, onOpenThread }: { ticket: Ticket; onOpenThread: (threadId: string) => void }) {
  const loop = ticket.loop!;
  const last = loop.checks.at(-1);
  const chip = phaseChip(loop);
  const text =
    loop.phase === "checking"
      ? `Re-running \`${loop.checkCommand?.command ?? "checks"}\`${loop.checkCommand?.source === "agent" ? " (the agent's choice)" : ""}`
      : loop.phase === "planning" || loop.phase === "classifying" || loop.phase === "reviewing" || loop.phase === "fixing"
        ? (chip?.title ?? "")
        : loop.phase === "paused"
          ? "Paused: the card's thread is waiting on you; the loop resumes when it reports ready"
        : loop.phase === "needs-you" && loop.reason !== null && loop.reason !== "clean"
          ? `Needs you: ${NEEDS_YOU_REASON_LABEL[loop.reason]}${loop.reason === "checks" && last !== undefined ? `, exit code ${last.exitCode}` : ""}${loop.reason === "loop-error" && loop.failure !== null ? `: ${loop.failure}` : ""}`
          : loop.phase === "needs-you" && loop.openFindings.length > 0
            ? `Clean with ${loop.openFindings.length} minor finding${loop.openFindings.length === 1 ? "" : "s"} left open: ${loop.openFindings.map((finding) => `${finding.id} ${finding.title}`).join(", ")}`
          : loop.phase === "needs-you" && loop.levelOverride !== null
            ? `${ATTENTION_LEVEL_LABEL[loop.levelOverride.level]}: you set it, ${loop.levelOverride.reason}`
          : loop.phase === "needs-you" && loop.attention !== null
            ? `${ATTENTION_LEVEL_LABEL[loop.attention.level]}: ${loop.attention.reasons.join("; ")}`
            : last !== undefined
            ? `Last checks ${last.passed ? "passed" : `failed (exit code ${last.exitCode})`} at ${last.commit.slice(0, 7)}`
            : "Waiting for the card's thread to report ready";
  const failedThreadId = loop.phase === "needs-you" && loop.reason === "loop-error" ? loop.failedThreadId : null;
  return (
    <span className="text-xs text-muted-foreground" title={chip?.title}>
      {text}
      {failedThreadId === null ? null : (
        <>
          {" · "}
          <button type="button" className="hover:underline" onClick={() => onOpenThread(failedThreadId)}>
            open the failed thread
          </button>
        </>
      )}
    </span>
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

