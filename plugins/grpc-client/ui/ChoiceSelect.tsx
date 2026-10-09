import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { cx, enter, exit, speed, usePresence } from "bb-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { NAV_ROW } from "./client-keys";
import { useDismiss, useInertWhileClosing } from "./hooks";

export interface Choice {
  value: string;
  label: string;
  title?: string;
}

const EMPTY_LABEL = "—";

/**
 * A select whose open list takes vim keys, which a native select's popup never sees: j/k or the
 * arrows move, g/G jump to the ends, Enter or Space picks, and Escape closes without changing it.
 * Closing from the keyboard hands the cursor back to the field row.
 */
export function ChoiceSelect({
  value,
  choices,
  onChange,
  className,
}: {
  /** "" is unset. */
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const options: Choice[] = [{ value: "", label: EMPTY_LABEL }, ...choices];
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const presence = usePresence(open);
  useDismiss(root, open, setOpen);
  useInertWhileClosing(root, panel, presence.exiting);
  const listId = useId();
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (open) panel.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const show = () => {
    setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };
  const close = (backToRow: boolean) => {
    setOpen(false);
    const row = trigger.current?.parentElement?.closest<HTMLElement>(NAV_ROW);
    if (backToRow && row != null) row.focus({ preventScroll: true });
  };
  const pick = (index: number, backToRow: boolean) => {
    const option = options[index];
    if (option !== undefined && option.value !== value) onChange(option.value);
    close(backToRow);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open || event.metaKey || event.ctrlKey || event.altKey) return;
    const last = options.length - 1;
    const moves: Record<string, () => void> = {
      j: () => setHighlight(Math.min(highlight + 1, last)),
      ArrowDown: () => setHighlight(Math.min(highlight + 1, last)),
      k: () => setHighlight(Math.max(highlight - 1, 0)),
      ArrowUp: () => setHighlight(Math.max(highlight - 1, 0)),
      g: () => setHighlight(0),
      Home: () => setHighlight(0),
      G: () => setHighlight(last),
      End: () => setHighlight(last),
      Enter: () => pick(highlight, true),
      " ": () => pick(highlight, true),
      Escape: () => close(true),
    };
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    // Escape would also reach the view's keys and the panel dismissal; this list owns it while open.
    event.stopPropagation();
    move();
  };

  return (
    <div ref={root} className={cn("relative min-w-0", className)}>
      <button
        ref={trigger}
        type="button"
        data-choice=""
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        title={current?.title}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className={cn("min-w-0 flex-1 truncate", current === undefined || current.value === "" ? "text-muted-foreground" : null)}>
          {current?.label ?? value}
        </span>
        <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {presence.mounted ? (
        <div
          ref={panel}
          id={listId}
          role="listbox"
          aria-hidden={presence.exiting || undefined}
          className={cx(
            "absolute left-0 top-full z-30 mt-1 max-h-64 min-w-full overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg",
            presence.exiting ? exit.fade : cx(enter.drop, speed.fast),
          )}
          onAnimationEnd={presence.onAnimationEnd}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              title={option.title}
              className={cn(
                "flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 py-1 text-sm",
                index === highlight ? "bg-state-hover text-foreground" : "text-foreground/80",
                option.value === "" && "text-muted-foreground",
              )}
              onPointerMove={() => setHighlight(index)}
              // Picking with the pointer must not blur the trigger first.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(index, false)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value && option.value !== "" ? <Icon name="Check" className="size-3.5 shrink-0" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
