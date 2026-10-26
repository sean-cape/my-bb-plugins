import type { LoopGates } from "../shared/loop";
import { GateRow, TipProvider } from "./gate-row";
import { HOLDS, SKIPS } from "./gates";
import { SegmentedTabs } from "./primitives";
import type { RunMode } from "./run-mode-flags";

const HINT: Record<RunMode, string> = {
  card: "A card on the board; start a thread from its panel later",
  thread: "A thread works the card and moves it across the board itself",
  loop: "A thread works the card; the board checks and reviews what it reports ready",
};

const NO_PROJECT = "Pick a project to start a thread";

/**
 * The run-mode choice shared by the new-card dialog, the card panel's Thread row and the proposals' accept step: a
 * segmented control, with the loop's gates inline when Review loop is chosen. Without a project only Card only is open.
 */
export function RunModeControl({
  value,
  onChange,
  gates,
  onGatesChange,
  hasProject,
  cardOnly = true,
  disabled = false,
}: {
  value: RunMode;
  onChange: (mode: RunMode) => void;
  gates: LoopGates;
  onGatesChange: (gates: LoopGates) => void;
  hasProject: boolean;
  /** Whether Card only is offered; a card that exists already can only start a thread. */
  cardOnly?: boolean;
  disabled?: boolean;
}) {
  const threadOption = { disabled: disabled || !hasProject, ...(hasProject ? {} : { title: NO_PROJECT }) };
  const options = [
    ...(cardOnly ? [{ value: "card" as const, label: "Card only", disabled }] : []),
    { value: "thread" as const, label: "Thread", ...threadOption },
    { value: "loop" as const, label: "Review loop", ...threadOption },
  ];
  return (
    <TipProvider>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          How it runs
          <SegmentedTabs label="How it runs" value={value} options={options} onChange={onChange} tabClassName="px-2.5 py-1" />
        </div>
        <span className="text-xs text-muted-foreground">{hasProject || !cardOnly ? HINT[value] : NO_PROJECT}</span>
        {value === "loop" && hasProject ? (
          <div className="grid grid-cols-1 sm:grid-cols-2">
            {[...HOLDS, ...SKIPS].map((option) => (
              <GateRow key={option.gate} option={option} checked={gates[option.gate]} disabled={disabled} onChange={(checked) => onGatesChange({ ...gates, [option.gate]: checked })} />
            ))}
          </div>
        ) : null}
      </div>
    </TipProvider>
  );
}
