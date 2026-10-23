import { useRef, useState, type ReactNode } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../utils";
import { useDiffSource } from "../source";
import { CHEVRON, FAST, PRESS, STAGGER, enter, stagger } from "../ui/motion";
import { runListMotion, useKeyHandler } from "../ui/vim-keys";
import { OUTSIDE_FINDINGS_KEYMAP, type OutsideFindingsCommand } from "../keys/keymap";
import { SEVERITY_DOT, SEVERITY_LABEL, findingLocationLabel, type ListedFinding, type ResolvedBy, type ResolvedFinding } from "./findings";
import { shortSha } from "../format";

/** The selector the review keys use to hand the keyboard to this list. */
export const OUTSIDE_FINDINGS = "[data-outside-findings]";

const MAKE_CARD_TITLE = "Add a card for this finding, carrying its title, description, fix and locations";

const listedKey = (entry: ListedFinding) => `${entry.reviewId}:${entry.finding.id}`;

/** Make a card, or open the one made; disabled while the request runs so two presses can't race. */
function CardButton({ entry, onMakeCard }: { entry: ListedFinding; onMakeCard: (entry: ListedFinding) => Promise<string | null> }) {
  const { source } = useDiffSource();
  const [card, setCard] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const className = cn("shrink-0 rounded-md border border-border px-2 py-px text-primary hover:bg-state-hover disabled:opacity-50", PRESS);
  if (card !== null && source.reviews?.openCard !== undefined) {
    const open = source.reviews.openCard;
    return (
      <button type="button" className={className} onClick={() => open(card)}>
        Open card
      </button>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={MAKE_CARD_TITLE}
      disabled={making}
      onClick={() => {
        setMaking(true);
        void onMakeCard(entry)
          .then(setCard)
          .finally(() => setMaking(false));
      }}
    >
      {card !== null ? "Card made" : "Make a card"}
    </button>
  );
}

function ListedRow({ entry, index, onMakeCard, action = null }: { entry: ListedFinding; index: number; onMakeCard: ((entry: ListedFinding) => Promise<string | null>) | null; action?: ReactNode }) {
  const { finding } = entry;
  const [open, setOpen] = useState(false);
  const where = finding.locations.map(findingLocationLabel).join(", ");
  return (
    <li style={stagger(index)} className={cn("flex flex-col", enter.fade, FAST, STAGGER)}>
      <div data-nav-row="toolbar" className="flex min-w-0 items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none" aria-expanded={open} data-bbm-open={open} onClick={() => setOpen(!open)}>
          <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])} title={SEVERITY_LABEL[finding.severity]} />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{finding.id}</span>
          <span className="min-w-0 truncate text-foreground">{finding.title}</span>
          {where !== "" ? <span className="min-w-0 shrink truncate font-mono text-[11px] text-muted-foreground">{where}</span> : null}
        </button>
        {onMakeCard !== null ? <CardButton entry={entry} onMakeCard={onMakeCard} /> : null}
        {action}
      </div>
      {open ? (
        <div className={cn("flex flex-col gap-1 py-1 pl-5 text-sm", enter.rise, FAST)}>
          {finding.verification != null && finding.verification !== "" ? (
            <p className="text-xs text-muted-foreground">
              Verifier: {finding.verification}
              {finding.confidence != null ? <span className="tabular-nums" title="How sure the verifier is that it is real (0–100); it does not measure importance"> (confidence {finding.confidence})</span> : null}
            </p>
          ) : finding.confidence != null ? (
            <p className="text-xs tabular-nums text-muted-foreground" title="How sure the verifier is that it is real (0–100); it does not measure importance">Verifier confidence {finding.confidence}</p>
          ) : null}
          {finding.class != null && finding.class !== "" ? <p className="text-xs text-muted-foreground">Class: {finding.class}</p> : null}
          {finding.description !== "" ? <Markdown content={finding.description} /> : <p className="text-xs text-muted-foreground">No description.</p>}
          {finding.fix !== null && finding.fix !== "" ? (
            <div className="flex gap-1.5">
              <Icon name="diff-view-wrench" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <Markdown content={finding.fix} className="min-w-0 flex-1" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GroupToggle({ open, onToggle, count, label, title }: { open: boolean; onToggle: () => void; count: number; label: string; title: string }) {
  return (
    <button
      type="button"
      className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none", PRESS, open && "bg-background text-foreground")}
      aria-expanded={open}
      data-bbm-open={open}
      title={title}
      onClick={onToggle}
    >
      <Icon name="ChevronRight" className={cn("size-3 text-muted-foreground", CHEVRON)} />
      <span className="font-medium tabular-nums text-foreground">{count}</span> {label}
    </button>
  );
}

const ROW_BUTTON = cn("shrink-0 rounded-md border border-border px-2 py-px hover:bg-state-hover hover:text-foreground", PRESS);

const RESOLVED_BY: Record<ResolvedBy, string> = {
  you: "resolved by you",
  applied: "applied; the next re-review checks it",
  fixed: "fixed",
};

function ResolvedRow({ entry, index, onReopen }: { entry: ResolvedFinding; index: number; onReopen: ((entry: ResolvedFinding) => void) | null }) {
  const where = entry.finding?.locations.map(findingLocationLabel).join(", ") ?? "";
  const how = entry.by === "fixed" ? `fixed${entry.at === null ? "" : ` at ${shortSha(entry.at)}`}${entry.note === null ? "" : `: ${entry.note}`}` : RESOLVED_BY[entry.by];
  return (
    <li style={stagger(index)} data-nav-row="toolbar" className={cn("flex min-w-0 items-center gap-2 py-0.5", enter.fade, FAST, STAGGER)}>
      <Icon name="Check" className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{entry.findingId}</span>
      <span className="min-w-0 truncate text-muted-foreground line-through decoration-muted-foreground/50" title={entry.title}>
        {entry.title}
      </span>
      <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground" title={[how, where].filter((part) => part !== "").join(" · ")}>
        {how}
      </span>
      {onReopen !== null && entry.by !== "fixed" ? (
        <button type="button" className={cn(ROW_BUTTON, "ml-auto")} title="Reopen: show it in the diff again, and in the next apply round and re-review" onClick={() => onReopen(entry)}>
          Reopen
        </button>
      ) : null}
    </li>
  );
}

/**
 * The findings that have no place in the diff, each group folded under its count until asked for: outdated ones (the
 * code under them changed since their review, as GitHub calls a comment outdated), resolved ones (by the reviewer, an
 * apply round or a re-review), pre-existing ones, which can become cards of their own, and the ones the verifier
 * filtered out. It moves with its own list keys (gp reaches it); Escape hands the keyboard back.
 */
export function OutsideFindings({
  outdated,
  resolved,
  onResolve,
  onReopen,
  preExisting,
  filtered,
  filteredOpen,
  onFilteredOpen,
  onMakeCard,
  onLeave,
}: {
  outdated: readonly ListedFinding[];
  resolved: readonly ResolvedFinding[];
  /** Null when the source can't resolve findings. */
  onResolve: ((entry: ListedFinding) => void) | null;
  onReopen: ((entry: ResolvedFinding) => void) | null;
  preExisting: readonly ListedFinding[];
  filtered: readonly ListedFinding[];
  filteredOpen: boolean;
  onFilteredOpen: (open: boolean) => void;
  /** Resolves to the card's id, or null when it could not be made; null when the source cannot make cards. */
  onMakeCard: ((entry: ListedFinding) => Promise<string | null>) | null;
  onLeave: () => void;
}) {
  const { labels } = useDiffSource();
  const [preExistingOpen, setPreExistingOpen] = useState(false);
  const [outdatedOpen, setOutdatedOpen] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  // Before the review keys, so j and k move here; Enter is the focused button's own click.
  const onKeyDown = useKeyHandler<OutsideFindingsCommand>({
    keymap: OUTSIDE_FINDINGS_KEYMAP,
    onCommand: (command) => {
      const section = sectionRef.current;
      if (section === null) return false;
      switch (command.kind) {
        case "list":
          return runListMotion(section, command.motion);
        case "leave":
          onLeave();
          return;
      }
    },
  });
  return (
    <section ref={sectionRef} data-outside-findings="" aria-label="Findings outside the diff" className={cn("flex flex-col gap-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs", enter.fade)} onKeyDown={onKeyDown}>
      <div data-nav-row="toolbar" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="mr-1">Not in the diff</span>
        {outdated.length > 0 ? (
          <GroupToggle
            open={outdatedOpen}
            onToggle={() => setOutdatedOpen(!outdatedOpen)}
            count={outdated.length}
            label="outdated"
            title="Open findings whose lines changed after their review read them, as GitHub calls a comment outdated: the next re-review moves them to where they are now or finds them fixed"
          />
        ) : null}
        {resolved.length > 0 ? (
          <GroupToggle open={resolvedOpen} onToggle={() => setResolvedOpen(!resolvedOpen)} count={resolved.length} label="resolved" title="Findings resolved by you, fixed by an apply round, or found fixed by a re-review" />
        ) : null}
        {preExisting.length > 0 ? (
          <GroupToggle
            open={preExistingOpen}
            onToggle={() => setPreExistingOpen(!preExistingOpen)}
            count={preExisting.length}
            label="pre-existing"
            title="Findings already in the code before this change: never applied with it, but each can become a card of its own"
          />
        ) : null}
        {filtered.length > 0 ? <GroupToggle open={filteredOpen} onToggle={() => onFilteredOpen(!filteredOpen)} count={filtered.length} label="filtered" title={`${labels.filteredFindings} (gF; gp moves the keyboard here)`} /> : null}
      </div>
      {outdated.length > 0 && outdatedOpen ? (
        <ul aria-label="Outdated findings" className="flex flex-col rounded-md border border-border bg-card px-2 py-1">
          {outdated.map((entry, index) => (
            <ListedRow
              key={listedKey(entry)}
              entry={entry}
              index={index}
              onMakeCard={null}
              action={
                onResolve === null ? null : (
                  <button type="button" className={ROW_BUTTON} title="Resolve: the next re-review leaves it be" onClick={() => onResolve(entry)}>
                    Resolve
                  </button>
                )
              }
            />
          ))}
        </ul>
      ) : null}
      {resolved.length > 0 && resolvedOpen ? (
        <ul aria-label="Resolved findings" className="flex flex-col rounded-md border border-border bg-card px-2 py-1">
          {resolved.map((entry, index) => (
            <ResolvedRow key={entry.key} entry={entry} index={index} onReopen={onReopen} />
          ))}
        </ul>
      ) : null}
      {preExisting.length > 0 && preExistingOpen ? (
        <ul aria-label="Pre-existing findings" className="flex flex-col rounded-md border border-border bg-card px-2 py-1">
          {preExisting.map((entry, index) => (
            <ListedRow key={listedKey(entry)} entry={entry} index={index} onMakeCard={onMakeCard} />
          ))}
        </ul>
      ) : null}
      {filtered.length > 0 && filteredOpen ? (
        <ul aria-label="Filtered findings" className="flex flex-col rounded-md border border-border bg-card px-2 py-1 opacity-70">
          {filtered.map((entry, index) => (
            <ListedRow key={listedKey(entry)} entry={entry} index={index} onMakeCard={null} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
