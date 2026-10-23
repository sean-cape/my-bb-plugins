import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ATTENTION_LEVEL_LABEL, attentionLevelSchema, openFindingsCount, type AttentionLevel } from "../shared/loop";
import type { PlanFile, ReadingPlan } from "../shared/reading-plan";
import type { Ticket } from "../shared/board";
import type { FindingSeverity, Review } from "../shared/review";
import { totalTokens } from "../shared/spend";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Rpc } from "./data";
import { Badge, COMPACT, Group, SegmentedTabs } from "./primitives";
import { toastError, type RunAction } from "./actions";
import type { BriefAction } from "./board-nav";
import { BRIEF_SECTION_TITLE, briefShown, handoffBrief, type BriefFinding, type BriefSection } from "./handoff-brief";
import { shortTokens, spendTitle } from "./format";
import { diffSubPath } from "./reading-plan";
import { openInStepper, useReadingPlan } from "./use-reading-plan";

const LEVEL_TONE: Record<AttentionLevel, "success" | "warning" | "danger"> = { glance: "success", read: "warning", scrutinize: "danger" };
const SEVERITY_TONE: Record<FindingSeverity, "danger" | "warning" | "neutral"> = { critical: "danger", important: "warning", minor: "neutral" };

/** The card's reviews while the brief shows, refetched as the loop moves; null until they first load. */
function useBriefReviews(ticket: Ticket, rpc: Rpc): Review[] | null {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const shown = briefShown(ticket.loop);
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    rpc.call("review_list", { ticketId: ticket.id }).then((result) => {
      if (!cancelled) setReviews(result.reviews);
    }, toastError);
    return () => {
      cancelled = true;
    };
  }, [shown, ticket.id, ticket.loop?.reviewId, ticket.loop?.phase, ticket.latestReview?.completedAt, rpc]);
  return reviews;
}

function LevelBadge({ level }: { level: AttentionLevel | null }) {
  return level === null ? <Badge tone="outline">no level</Badge> : <Badge tone={LEVEL_TONE[level]}>{ATTENTION_LEVEL_LABEL[level]}</Badge>;
}

function Items({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-1 text-xs">{children}</ul>;
}

/** `action` makes the row a finding the card's per-finding keys act on. */
function FindingItem({ id, severity, title, note, action }: { id: string; severity: FindingSeverity; title: string; note?: string; action?: ReactNode }) {
  return (
    <li data-kanban-brief-finding={action === undefined ? undefined : ""} className="flex items-baseline gap-1.5">
      <Badge tone={SEVERITY_TONE[severity]}>{id}</Badge>
      <span>
        {title}
        {note ? <span className="text-muted-foreground"> · {note}</span> : null}
      </span>
      {action === undefined ? null : <span className="ml-auto">{action}</span>}
    </li>
  );
}

/** Decides on the card from the brief; `findingId` is set for the actions on one finding. */
type Decide = (action: BriefAction, findingId?: string) => void;

function ActionButton({ action, label, keyHint, title, disabled, onDecide, findingId }: { action: BriefAction; label: string; keyHint: string; title: string; disabled: boolean; onDecide: Decide; findingId?: string }) {
  return (
    <span title={`${title} (${keyHint})`} className="shrink-0">
      <Button type="button" variant="secondary" className={COMPACT} data-kanban-action={action} disabled={disabled} onClick={() => onDecide(action, findingId)}>
        {label}
        <kbd className="font-mono text-[10px] text-muted-foreground">{keyHint}</kbd>
      </Button>
    </span>
  );
}

function Subhead({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground">{children}</div>;
}

function LevelBody({ section, onOpenThread }: { section: Extract<BriefSection, { kind: "level" }>; onOpenThread: (threadId: string) => void }) {
  const { escalation, reasons, failedThreadId, override } = section;
  return (
    <>
      {override !== null ? (
        <p className="text-xs">
          <span className="font-medium">You set {ATTENTION_LEVEL_LABEL[override.level]}</span>: {override.reason}
          <span className="text-muted-foreground">
            {" "}
            · {override.from === null ? "the loop had no level" : `the loop said ${ATTENTION_LEVEL_LABEL[override.from]}`}, until the head moves
          </span>
        </p>
      ) : null}
      {escalation !== null ? (
        <p className="text-xs font-medium text-destructive">
          {escalation}
          {failedThreadId === null ? null : (
            <>
              {" · "}
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenThread(failedThreadId)}>
                open the failed thread
              </button>
            </>
          )}
        </p>
      ) : null}
      {reasons.length > 0 ? (
        <Items>
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </Items>
      ) : (
        <p className="text-xs text-muted-foreground">{section.level === null ? "The loop stopped before the change was classified." : "No reasons beyond the default."}</p>
      )}
    </>
  );
}

function NotCoveredBody({ section }: { section: Extract<BriefSection, { kind: "not-covered" }> }) {
  if (section.items.length === 0) {
    return <p className="text-xs text-muted-foreground">{section.known ? "The review found nothing the checks miss." : "Unknown: no review ran."}</p>;
  }
  return (
    <Items>
      {section.items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </Items>
  );
}

function EvidenceBody({ section }: { section: Extract<BriefSection, { kind: "evidence" }> }) {
  return (
    <>
      <Subhead>Re-ran by the board{section.reranBy === "agent" ? " (command chosen by the agent)" : ""}</Subhead>
      {section.reran.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing re-ran yet.</p>
      ) : (
        <Items>
          {section.reran.map((outcome, index) => (
            <li key={index} className="flex items-baseline gap-1.5">
              <Badge tone={outcome.passed ? "success" : "danger"}>{outcome.passed ? "passed" : `exit ${outcome.exitCode}`}</Badge>
              <code className="font-mono">{outcome.command ?? "checks"}</code>
              <span className="text-muted-foreground">at {outcome.commit.slice(0, 7)}</span>
            </li>
          ))}
        </Items>
      )}
      <Subhead>Claimed by the agent, not re-run</Subhead>
      {section.claimed.length === 0 && section.screenshots.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing claimed.</p>
      ) : (
        <Items>
          {section.claimed.map((command, index) => (
            <li key={index} className="flex items-baseline gap-1.5">
              <Badge tone="outline">exit {command.exitCode}</Badge>
              <code className="font-mono">{command.command}</code>
            </li>
          ))}
          {section.screenshots.map((path) => (
            <li key={path}>
              screenshot <code className="font-mono">{path}</code>
            </li>
          ))}
        </Items>
      )}
    </>
  );
}

function HistoryBody({ section }: { section: Extract<BriefSection, { kind: "history" }> }) {
  return (
    <>
      <Items>
        {section.rounds.map((round, index) => (
          <li key={index}>
            <span className="font-medium">{round.round === null ? "Your round" : `Round ${round.round}`}</span>
            :{" "}
            {round.comments > 0
              ? `your ${round.comments} diff comment${round.comments === 1 ? "" : "s"}`
              : `${round.handed} handed, ${
                  round.resolved === null
                    ? `not re-reviewed; the agent says ${round.claimed.fixed} fixed, ${round.claimed.disputed} disputed`
                    : `resolved ${round.resolved.map((entry) => entry.title).join(", ")}`
                }`}
          </li>
        ))}
      </Items>
      {section.acceptedDisputes.length > 0 ? (
        <>
          <Subhead>Accepted disputes</Subhead>
          <Items>
            {section.acceptedDisputes.map((entry) => (
              <li key={entry.id}>
                {entry.title}
                <span className="text-muted-foreground">
                  {" "}
                  · agent: {entry.dispute.reason}
                  {entry.dispute.note ? ` · verifier: ${entry.dispute.note}` : ""}
                </span>
              </li>
            ))}
          </Items>
        </>
      ) : null}
      {section.polish.length > 0 ? (
        <>
          <Subhead>Nits and smells fixed</Subhead>
          <Items>
            {section.polish.map((entry) => (
              <li key={entry.id}>{entry.title}</li>
            ))}
          </Items>
        </>
      ) : null}
    </>
  );
}

function LeftOutBody({ section, decide }: { section: Extract<BriefSection, { kind: "left-out" }>; decide: Decide | null }) {
  const groups: Array<[string, BriefFinding[]]> = [
    ["Deferred", section.deferred],
    ["Dropped", section.dropped],
    ["Pre-existing", section.preExisting],
  ];
  return (
    <>
      {groups
        .filter(([, findings]) => findings.length > 0)
        .map(([label, findings]) => (
          <div key={label} className="flex flex-col gap-1">
            <Subhead>{label}</Subhead>
            <Items>
              {findings.map((finding) => (
                <FindingItem
                  key={finding.id}
                  {...finding}
                  {...(label === "Pre-existing"
                    ? {}
                    : {
                        action: (
                          <ActionButton action="pull-in" label="Pull in" keyHint="p" title="Send it to fix as a round of yours" disabled={decide === null} onDecide={decide ?? (() => {})} findingId={finding.id} />
                        ),
                      })}
                />
              ))}
            </Items>
          </div>
        ))}
      {section.leftOpen.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Subhead>Left open</Subhead>
          <Items>
            {section.leftOpen.map((finding) => (
              <FindingItem key={finding.id} {...finding} />
            ))}
          </Items>
        </div>
      ) : null}
    </>
  );
}

function DisputesBody({ section, decide }: { section: Extract<BriefSection, { kind: "disputes" }>; decide: Decide | null }) {
  return (
    <Items>
      {section.disputes.map((dispute) => (
        <li key={dispute.id} data-kanban-brief-finding="" className="flex flex-col gap-0.5">
          <div className="flex items-start justify-between gap-2">
            <FindingItem id={dispute.id} severity={dispute.severity} title={dispute.title} />
            {dispute.decision !== null ? (
              <Badge tone="outline">{dispute.decision}</Badge>
            ) : dispute.decidable ? (
              <span className="flex shrink-0 gap-1">
                <ActionButton action="uphold" label="Uphold" keyHint="u" title="The finding stands: send it to fix" disabled={decide === null} onDecide={decide ?? (() => {})} findingId={dispute.id} />
                <ActionButton action="close-dispute" label="Close" keyHint="c" title="The agent is right: close the finding" disabled={decide === null} onDecide={decide ?? (() => {})} findingId={dispute.id} />
              </span>
            ) : null}
          </div>
          <span className="pl-2 text-muted-foreground">Agent: {dispute.agent || "no reason given"}</span>
          <span className="pl-2 text-muted-foreground">Verifier: {dispute.verifier || "no reason given"}</span>
        </li>
      ))}
    </Items>
  );
}

function sectionSummary(section: BriefSection): ReactNode {
  switch (section.kind) {
    case "level":
      return (
        <>
          {section.escalation !== null ? <Badge tone="danger">stopped</Badge> : null}
          <LevelBadge level={section.level} />
        </>
      );
    case "not-covered":
      return <span className="text-xs text-muted-foreground">{section.items.length === 0 ? "none listed" : section.items.length}</span>;
    case "evidence":
      return <span className="text-xs text-muted-foreground">{section.reran.length} re-ran · {section.claimed.length} claimed</span>;
    case "history":
      return <span className="text-xs text-muted-foreground">{section.rounds.length} round{section.rounds.length === 1 ? "" : "s"}</span>;
    case "left-out":
      return <span className="text-xs text-muted-foreground">{section.deferred.length + section.dropped.length + section.preExisting.length + section.leftOpen.length}</span>;
    case "disputes":
      return <Badge tone="danger">{section.disputes.length}</Badge>;
  }
}

function SectionBody({ section, onOpenThread, decide }: { section: BriefSection; onOpenThread: (threadId: string) => void; decide: Decide | null }) {
  switch (section.kind) {
    case "level":
      return <LevelBody section={section} onOpenThread={onOpenThread} />;
    case "not-covered":
      return <NotCoveredBody section={section} />;
    case "evidence":
      return <EvidenceBody section={section} />;
    case "history":
      return <HistoryBody section={section} />;
    case "left-out":
      return <LeftOutBody section={section} decide={decide} />;
    case "disputes":
      return <DisputesBody section={section} decide={decide} />;
  }
}

const DECISION_DONE: Record<BriefAction, string> = {
  accept: "Accepted",
  "send-back": "Sent your comments back",
  rethink: "Asked the card's thread to rethink the approach",
  "pull-in": "Pulled the finding back in",
  uphold: "Upheld the finding",
  "close-dispute": "Closed the finding",
  "open-plan": "",
  "change-level": "Changed the attention level",
  approve: "Approved",
};

const ROLE_TONE: Record<PlanFile["role"], "danger" | "warning" | "outline"> = { key: "danger", supporting: "warning", mechanical: "outline" };

function PlanFileItem({ file }: { file: PlanFile }) {
  return (
    <li className="flex items-baseline gap-1.5">
      {file.viewed ? (
        <Icon name="Check" aria-label="viewed" className="size-3 shrink-0 self-center text-emerald-600 dark:text-emerald-400" />
      ) : (
        <span aria-label="not viewed" className="size-3 shrink-0 self-center rounded-full border border-muted-foreground/60" />
      )}
      <Badge tone={ROLE_TONE[file.role]}>{file.role}</Badge>
      <code className="min-w-0 truncate font-mono">{file.path}</code>
      {file.risk === null ? null : <span className="shrink-0 text-muted-foreground">risk {file.risk}</span>}
      {file.note ? <span className="min-w-0 truncate text-muted-foreground">· {file.note}</span> : null}
    </li>
  );
}

const PLAN_SOURCE: Record<NonNullable<ReadingPlan["source"]>, string> = {
  narrative: "Roles from the narrative's reading order.",
  classify: "No narrative yet: roles from the classify pass.",
};

function PlanBody({ plan }: { plan: ReadingPlan }) {
  return (
    <>
      {plan.level === "glance" ? (
        <p className="text-xs text-muted-foreground">At Glance the evidence and the not-covered list are the plan; no files to read.</p>
      ) : plan.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No {plan.level === "read" ? "key" : "key or supporting"} files in the diff.</p>
      ) : (
        <Items>
          {plan.files.map((file) => (
            <PlanFileItem key={file.path} file={file} />
          ))}
        </Items>
      )}
      {plan.source === null ? null : <p className="text-[11px] text-muted-foreground">{PLAN_SOURCE[plan.source]}</p>}
      {plan.skipped.length > 0 ? (
        <Group title="Collapsed" summary={<span className="text-xs text-muted-foreground">{plan.skipped.length}</span>} defaultOpen={false}>
          <Items>
            {plan.skipped.map((file) => (
              <PlanFileItem key={file.path} file={file} />
            ))}
          </Items>
        </Group>
      ) : null}
    </>
  );
}

const LEVEL_OPTIONS = attentionLevelSchema.options.map((value) => ({ value, label: ATTENTION_LEVEL_LABEL[value] }));

/** Sets the level with a reason; the reason box takes focus, and the picker's h/l and Enter work from the keys. */
function LevelForm({ current, onSave, onCancel }: { current: AttentionLevel | null; onSave: (level: AttentionLevel, reason: string) => void; onCancel: () => void }) {
  const [level, setLevel] = useState<AttentionLevel>(current ?? "read");
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => reasonRef.current?.focus(), []);
  const save = () => {
    if (reason.trim() === "") {
      reasonRef.current?.focus();
      return;
    }
    onSave(level, reason.trim());
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <SegmentedTabs label="Attention level" value={level} options={LEVEL_OPTIONS} onChange={setLevel} onActivate={save} className="shrink-0" tabClassName="whitespace-nowrap px-2 py-0.5" />
      <Input
        ref={reasonRef}
        aria-label="Why this level"
        placeholder="Why this level (kept for tuning the classifier)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
        }}
        className="h-7 text-xs"
      />
      <div className="flex gap-1.5">
        <Button type="button" variant="secondary" className={COMPACT} disabled={reason.trim() === ""} onClick={save}>
          Set {ATTENTION_LEVEL_LABEL[level]}
        </Button>
        <Button type="button" variant="ghost" className={COMPACT} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The handoff brief at the top of a monitored card waiting on you; each section's header is a stop for the card's keys.
 * Its decisions need the loop stopped at Needs you, so a card paused by a question shows them disabled.
 */
export function HandoffBrief({ ticket, rpc, run, pending, onOpenThread }: { ticket: Ticket; rpc: Rpc; run: RunAction; pending: boolean; onOpenThread: (threadId: string) => void }) {
  const reviews = useBriefReviews(ticket, rpc);
  const plan = useReadingPlan(ticket, rpc);
  const navigate = useBbNavigate();
  const [levelForm, setLevelForm] = useState(false);
  const [deselected, setDeselected] = useState<string[]>([]);
  useEffect(() => setDeselected([]), [ticket.loop?.reviewId, ticket.loop?.reason]);
  const sections = reviews === null ? null : handoffBrief(ticket.loop, reviews);
  if (sections === null) return null;
  const stopped = ticket.loop?.phase === "needs-you" && !pending;
  const awaiting = ticket.loop?.reason === "findings" ? ticket.loop.awaitingFindings : [];
  const approved = awaiting.filter((finding) => !deselected.includes(finding.id)).map((finding) => finding.id);
  const id = ticket.id;
  const level = sections.find((section) => section.kind === "level")!;
  const openPlan = () => {
    const stepper = plan !== null && plan.narrated && plan.level !== "glance";
    if (stepper) openInStepper();
    navigate.toPluginPanel("board", { subPath: diffSubPath(id, stepper) });
  };
  const unviewed = plan !== null && plan.gated ? plan.unviewed.length : 0;
  const decide: Decide = (action, findingId = "") => {
    if (action === "open-plan") {
      openPlan();
      return;
    }
    if (action === "change-level") {
      setLevelForm(true);
      return;
    }
    void run(() => {
      switch (action) {
        case "accept":
          return rpc.call("loop_accept", { id });
        case "send-back":
          return rpc.call("loop_send_back", { id });
        case "rethink":
          return rpc.call("loop_rethink", { id });
        case "pull-in":
          return rpc.call("loop_pull_in", { id, findingId });
        case "uphold":
          return rpc.call("loop_decide_dispute", { id, findingId, decision: "uphold" });
        case "close-dispute":
          return rpc.call("loop_decide_dispute", { id, findingId, decision: "close" });
        case "approve":
          return rpc.call("loop_approve_findings", { id, findingIds: approved });
      }
    }, action === "approve" ? (approved.length === 0 ? "No findings approved; the loop ends here" : `Sent ${approved.length} finding${approved.length === 1 ? "" : "s"} to fix`) : DECISION_DONE[action]);
  };
  const noThread = ticket.threadId === null;
  return (
    <div data-kanban-brief="" className="flex flex-col gap-2">
      {ticket.spend === null ? null : (
        <p className="text-xs text-muted-foreground" title={spendTitle(ticket.spend)}>
          {shortTokens(totalTokens(ticket.spend))} tokens spent across the card's threads
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {awaiting.length === 0 ? null : (
          <ActionButton
            action="approve"
            keyHint="Y"
            label={`Approve findings (${approved.length} of ${awaiting.length})`}
            title="Send the selected findings to the card's thread as the loop's next round; the deselected stay open"
            disabled={!stopped}
            onDecide={decide}
          />
        )}
        <ActionButton
          action="accept"
          keyHint="A"
          label={unviewed === 0 ? "Accept" : `Accept (${unviewed} unviewed)`}
          title={
            unviewed > 0
              ? "At Scrutinize, mark every file of the reading plan viewed in the changes view first"
              : ticket.pr === null
                ? "The card's thread lands the change with the project's finishing steps; the card moves to Done when it has"
                : "Mark it accepted; merging is yours on GitHub"
          }
          disabled={!stopped || (ticket.pr === null && noThread) || unviewed > 0}
          onDecide={decide}
        />
        <ActionButton
          action="send-back"
          label={`Send back${ticket.pendingDiffComments === 0 ? "" : ` (${ticket.pendingDiffComments})`}`}
          keyHint="S"
          title={ticket.pendingDiffComments === 0 ? "Leave diff comments on the changes first" : "Send your unsent diff comments to the card's thread as a round of yours"}
          disabled={!stopped || noThread || ticket.pendingDiffComments === 0}
          onDecide={decide}
        />
        <ActionButton action="rethink" label="Rethink" keyHint="R" title="Stop the loop and have the card's thread propose a new approach" disabled={!stopped || noThread} onDecide={decide} />
        <ActionButton action="open-plan" label="Reading plan" keyHint="P" title="Open the changes at the level's reading plan, in the narrative stepper when there is one" disabled={false} onDecide={decide} />
        <ActionButton action="change-level" label="Change level" keyHint="L" title="Set the attention level yourself, with a reason; it holds until the head moves" disabled={!stopped || levelForm} onDecide={decide} />
      </div>
      {levelForm ? (
        <LevelForm
          current={level.level}
          onCancel={() => setLevelForm(false)}
          onSave={(next, reason) => {
            setLevelForm(false);
            void run(() => rpc.call("loop_set_level", { id, level: next, reason }), DECISION_DONE["change-level"]);
          }}
        />
      ) : null}
      {awaiting.length === 0 ? null : (
        <Group title="Findings to approve" summary={<span className="text-xs text-muted-foreground">{approved.length} of {awaiting.length}</span>} defaultOpen>
          <Items>
            {awaiting.map((finding) => (
              <li key={finding.id} className="flex items-center gap-1.5">
                <Checkbox
                  checked={!deselected.includes(finding.id)}
                  disabled={!stopped}
                  onCheckedChange={(checked) => setDeselected((ids) => (checked === true ? ids.filter((entry) => entry !== finding.id) : [...ids, finding.id]))}
                  aria-label={`Send ${finding.id} to fix`}
                />
                <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.id}</Badge>
                <span>{finding.title}</span>
              </li>
            ))}
          </Items>
        </Group>
      )}
      {sections.map((section) => (
        <Group key={section.kind} title={BRIEF_SECTION_TITLE[section.kind]} summary={sectionSummary(section)} defaultOpen>
          <SectionBody section={section} onOpenThread={onOpenThread} decide={stopped ? decide : null} />
        </Group>
      ))}
      {plan === null ? null : (
        <Group
          title="Reading plan"
          summary={
            <span className="text-xs text-muted-foreground">
              {plan.files.length} file{plan.files.length === 1 ? "" : "s"}
              {plan.gated ? ` · ${plan.unviewed.length} unviewed` : ""}
            </span>
          }
          defaultOpen
        >
          <PlanBody plan={plan} />
        </Group>
      )}
    </div>
  );
}

/** While the plan gate holds the card: the proposed plan, editable, and its approval, which `Y` presses. */
export function PlanApproval({ ticket, rpc, run, pending }: { ticket: Ticket; rpc: Rpc; run: RunAction; pending: boolean }) {
  const proposed = ticket.loop?.proposedPlan ?? null;
  const [plan, setPlan] = useState(proposed ?? "");
  useEffect(() => setPlan(proposed ?? ""), [proposed]);
  if (ticket.loop?.monitored !== true || ticket.loop.phase !== "planning") return null;
  return (
    <div data-kanban-brief="" className="flex flex-col gap-1.5">
      <Group title="Plan" summary={proposed === null ? <Badge tone="outline">waiting</Badge> : <Badge tone="warning">needs you</Badge>} defaultOpen>
        <p className="text-xs text-muted-foreground">
          {proposed === null
            ? "The plan gate holds the card: its thread proposes a plan before building. You can also write one here and approve it."
            : "The card's thread proposed this plan. Edit it if you want; the approved plan goes to the thread and every review of the change."}
        </p>
        <textarea
          aria-label="Plan"
          value={plan}
          rows={8}
          placeholder="The approach, the files it changes, how it is verified"
          onChange={(event) => setPlan(event.target.value)}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div>
          <ActionButton
            action="approve"
            keyHint="Y"
            label={proposed !== null && plan.trim() !== proposed.trim() ? "Approve edited plan" : "Approve plan"}
            title="The card's thread builds to this plan"
            disabled={pending || plan.trim() === ""}
            onDecide={() => void run(() => rpc.call("loop_approve_plan", { id: ticket.id, plan: plan.trim() }), "Plan approved; the card's thread builds to it")}
          />
        </div>
      </Group>
    </div>
  );
}

/** Findings an accepted card left open, each with a card of its own to make. */
export function LeftOpenFindings({ ticket, rpc, run, pending }: { ticket: Ticket; rpc: Rpc; run: RunAction; pending: boolean }) {
  const loop = ticket.loop;
  if (loop === null || (loop.phase !== "accepted" && loop.phase !== "landed") || loop.openFindings.length === 0 || loop.reviewId === null) return null;
  const reviewId = loop.reviewId;
  return (
    <Group title="Left open" summary={<span className="text-xs text-muted-foreground">{openFindingsCount(loop.openFindings)}</span>} defaultOpen>
      <Items>
        {loop.openFindings.map((finding) => (
          <FindingItem
            key={finding.id}
            {...finding}
            action={
              <Button type="button" variant="secondary" className={COMPACT} disabled={pending} onClick={() => void run(() => rpc.call("review_make_card", { reviewId, findingId: finding.id }), "Card made for the finding")}>
                Make a card
              </Button>
            }
          />
        ))}
      </Items>
    </Group>
  );
}

/** The level, its reasons, the not-covered list and the reading plan above the changes page's diff; collapses to one line. */
export function HandoffStrip({ ticket, rpc, plan: planMode, onOpenThread }: { ticket: Ticket; rpc: Rpc; plan: boolean; onOpenThread: (threadId: string) => void }) {
  const [open, setOpen] = useState(true);
  const reviews = useBriefReviews(ticket, rpc);
  const plan = useReadingPlan(ticket, rpc);
  const navigate = useBbNavigate();
  const sections = reviews === null ? null : handoffBrief(ticket.loop, reviews);
  if (sections === null) return null;
  const level = sections.find((section) => section.kind === "level")!;
  const notCovered = sections.find((section) => section.kind === "not-covered")!;
  return (
    <div data-kanban-brief-strip="" className="border-b border-border bg-muted/30 px-3 py-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs">
        <Icon name="ChevronRight" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="font-semibold">Handoff</span>
        <LevelBadge level={level.level} />
        <span className={cn("min-w-0 truncate", level.escalation !== null ? "text-destructive" : "text-muted-foreground")}>{level.escalation ?? level.reasons.join("; ")}</span>
      </button>
      {open ? (
        <div className="grid gap-3 py-1.5 pl-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Subhead>{BRIEF_SECTION_TITLE.level}</Subhead>
            <LevelBody section={level} onOpenThread={onOpenThread} />
          </div>
          <div className="flex flex-col gap-1">
            <Subhead>{BRIEF_SECTION_TITLE["not-covered"]}</Subhead>
            <NotCoveredBody section={notCovered} />
          </div>
          {plan === null ? null : (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <div className="flex items-baseline gap-2">
                <Subhead>Reading plan</Subhead>
                <span className="text-xs text-muted-foreground">
                  {planMode ? "the narrative shows only these files" : "every file is showing"}
                  {plan.gated ? ` · ${plan.unviewed.length} still unviewed before Accept` : ""}
                </span>
                {plan.level !== "glance" && (planMode || plan.narrated) ? (
                  <button
                    type="button"
                    className="text-xs underline-offset-2 hover:underline"
                    onClick={() => {
                      if (!planMode && plan.narrated) openInStepper();
                      navigate.toPluginPanel("board", { subPath: diffSubPath(ticket.id, !planMode && plan.narrated) });
                    }}
                  >
                    {planMode ? "show the whole narrative" : "step through the plan"}
                  </button>
                ) : null}
              </div>
              <PlanBody plan={plan} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
