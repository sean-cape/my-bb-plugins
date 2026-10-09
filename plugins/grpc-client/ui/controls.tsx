import type { ReactNode } from "react";
import { cx, enter, PRESS, useLateMount } from "bb-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** The keyboard cursor on list rows and menu items. */
export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="max-w-lg space-y-3 text-center text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex items-center gap-1" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm",
            PRESS,
            value === option.id ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border p-0.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={cn("rounded px-2 py-0.5 text-xs", PRESS, value === option.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function MenuItem({ children, onClick, disabled, checked }: { children: ReactNode; onClick: () => void; disabled?: boolean; checked?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50", FOCUS_RING)}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {checked ? <CheckMark /> : null}
    </button>
  );
}

/** Pops when toggled on, but not when the menu holding it opens. */
function CheckMark() {
  const late = useLateMount();
  return (
    <span className={cx("flex shrink-0", late && enter.pop)}>
      <Icon name="Check" className="size-3.5" />
    </span>
  );
}

export function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" | "error" }) {
  return (
    <p
      className={cn(
        "mb-3 rounded-md px-3 py-2 text-xs",
        enter.fade,
        tone === "error" && "bg-destructive/10 text-destructive",
        tone === "warning" && "bg-amber-500/10 text-amber-800 dark:text-amber-200",
        tone === "muted" && "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
