import { forwardRef, useState } from "react";
import type { AnimationEvent, ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { createMenuKeys, type Keymap, useKeyHandler } from "bb-vim-keys/react";
import { CHEVRON, PRESS, STAGGER, TRANSFORM_TRANSITION, enter, exit, speed, stagger, usePresence, type Arrival, useEntrance, usePopOnChange } from "bb-motion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** GitHub links open in the system browser: an explicit target bypasses bb's in-app routing. */
export function ExternalLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

export function PushToggle({ push, onChange, disabled }: { push: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <label
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", disabled && "opacity-50")}
      title={push ? "The apply thread commits and pushes to the PR branch." : "The apply thread commits in its worktree and leaves pushing to you."}
    >
      <Checkbox checked={push} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} aria-label="Push to the PR branch after applying" />
      and push
    </label>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "outline" | "accent" | "warning" | "danger" | "success";
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4",
        className,
        // Solid enough to stand on a tinted group header, where a muted fill would vanish.
        tone === "neutral" && "bg-foreground/10 text-muted-foreground",
        tone === "outline" && "border border-border text-muted-foreground",
        tone === "accent" && "bg-primary/10 text-primary",
        tone === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "success" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {children}
    </span>
  );
}

export function ThreadStatusDot({ thread }: { thread: PluginSidebarThread | null | undefined }) {
  const status = thread?.runtimeStatus;
  const busy = status === "active" || status === "starting" || status === "stopping" || status === "provisioning";
  // The dot's colour, which is what the eye catches; a change pops it.
  const tone = thread == null ? null : thread.hasPendingInteraction ? "input" : busy ? "busy" : status === "error" ? "error" : "idle";
  const pop = usePopOnChange(tone);
  if (thread === undefined) {
    return <span title="Thread not loaded" className="size-2 rounded-full bg-border" />;
  }
  if (thread === null) return null;
  const label = thread.hasPendingInteraction
    ? "Thread needs your input"
    : thread.isArchived
      ? "Thread archived"
      : `Thread ${status}`;
  return (
    <span
      key={pop.key}
      title={label}
      aria-label={label}
      onAnimationEnd={pop.onAnimationEnd}
      className={cn(
        "size-2 shrink-0 rounded-full",
        pop.className,
        thread.hasPendingInteraction && "bg-amber-500",
        !thread.hasPendingInteraction && busy && "animate-pulse bg-primary",
        !thread.hasPendingInteraction && !busy && status === "error" && "bg-destructive",
        !thread.hasPendingInteraction && !busy && status !== "error" && "bg-muted-foreground/50",
      )}
    />
  );
}

export function Select({
  value,
  onChange,
  children,
  "aria-label": ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  "aria-label": string;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  "aria-label": ariaLabel,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label": string;
  rows?: number;
}) {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export const HEADER_ICON_BUTTON =
  `relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground ${PRESS} hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;

/** Turns a mode on or off; a button, so the card's keys reach it and Space presses it. */
export function Switch({ checked, disabled, onChange, "aria-label": ariaLabel }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; "aria-label": string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-foreground bg-foreground" : "border-input bg-transparent",
        PRESS,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2.5 rounded-full", checked ? "bg-background" : "bg-muted-foreground", TRANSFORM_TRANSITION)}
        style={{ transform: `translate3d(${checked ? 13 : 3}px, 0, 0)` }}
      />
    </button>
  );
}

/** Compact control sizing for the card panel: the panel is narrow, so chrome stays small. */
export const COMPACT = "h-7 gap-1.5 px-2 text-xs [&_[data-icon-root]]:size-3.5";

/**
 * A compact secondary button with the key that presses it after its label. The title sits on a wrapper, so it still
 * shows on a disabled button, which takes no pointer events. Extra props and the ref reach the button, so it can be a
 * Radix trigger.
 */
export const KeyedButton = forwardRef<HTMLButtonElement, { label: string; keyHint?: string; title: string } & Omit<ComponentPropsWithoutRef<"button">, "title" | "children">>(
  function KeyedButton({ label, keyHint, title, className, ...props }, ref) {
    return (
      <span title={keyHint === undefined ? title : `${title} (${keyHint})`} className="shrink-0">
        <Button ref={ref} type="button" variant="secondary" className={cn(COMPACT, className)} {...props}>
          {label}
          {keyHint === undefined ? null : <kbd className="font-mono text-[10px] text-muted-foreground">{keyHint}</kbd>}
        </Button>
      </span>
    );
  },
);

/** A collapsible block whose header carries the one-line summary; details live inside. */
export function Group({
  title,
  summary,
  menu,
  defaultOpen,
  children,
}: {
  title: string;
  summary?: ReactNode;
  menu?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Groups mount inside a panel that already rises in; only a toggle animates the body.
  const [toggled, setToggled] = useState(false);
  const body = usePresence(open);
  return (
    <section className="rounded-lg border border-border">
      {/* The header is tinted so a long card panel reads as a column of named blocks; no overflow clipping, so the keys' cursor ring stays whole. */}
      <div className={cn("flex items-center gap-1 bg-muted/40 pl-2 pr-1.5", open ? "rounded-t-[7px]" : "rounded-[7px]")}>
        <button
          type="button"
          aria-expanded={open}
          data-bbm-open={open}
          onClick={() => {
            setToggled(true);
            setOpen((value) => !value);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 text-left hover:text-foreground"
        >
          <Icon name="ChevronRight" className={cn("size-3.5 shrink-0 text-muted-foreground", CHEVRON)} />
          <span className="text-xs font-semibold text-foreground">{title}</span>
          {summary !== undefined ? <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">{summary}</span> : null}
        </button>
        {menu}
      </div>
      {body.mounted ? (
        <div
          aria-hidden={body.exiting || undefined}
          inert={body.exiting}
          onAnimationEnd={body.onAnimationEnd}
          className={cn("flex flex-col gap-2.5 border-t border-border px-2.5 py-2.5", body.exiting ? exit.fade : toggled && cn(enter.rise, speed.fast))}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function Property({
  label,
  children,
  className,
  onAnimationEnd,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onAnimationEnd?: (event: AnimationEvent) => void;
}) {
  return (
    <>
      <dt onAnimationEnd={onAnimationEnd} className={cn("pt-1 text-xs text-muted-foreground", className)}>{label}</dt>
      <dd onAnimationEnd={onAnimationEnd} className={cn("min-w-0 text-sm", className)}>{children}</dd>
    </>
  );
}

type TabCommand = 1 | -1 | "activate";

const PICKER_TAB_KEYS: Keymap<TabCommand> = { h: -1, l: 1, "<Left>": -1, "<Right>": 1, "<CR>": "activate" };

/** A segmented control whose selection pill slides between equal-width options. */
export function SegmentedTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  onActivate,
  selectedTabProps,
  className,
  tabClassName,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
  /**
   * Makes the tabs a picker that acts: one tab stop, h/l and the arrows move the choice, and Enter does this (send with
   * that choice, say). Without it each tab is its own stop, so bands that walk buttons with h/l (the top bar) still can.
   */
  onActivate?: () => void;
  /** Attributes for the selected tab alone, such as a marker that a host focuses it from. */
  selectedTabProps?: Record<`data-${string}`, string>;
  className?: string;
  tabClassName?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const picker = onActivate !== undefined;
  const onKeyDown = useKeyHandler<TabCommand>({
    keymap: PICKER_TAB_KEYS,
    active: () => picker,
    // Enter would otherwise stay with the focused tab, which only selects itself.
    leaveToPressables: false,
    onCommand: (command, { target }) => {
      if (command === "activate") {
        onActivate?.();
        return;
      }
      // Taken even at either end, so the views behind (the diff's review keys) leave h and l alone.
      const next = options[Math.min(options.length - 1, Math.max(0, index + command))]!;
      if (next.value === value || next.disabled === true) return;
      onChange(next.value);
      const tabs = target?.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabs?.[options.indexOf(next)]?.focus();
    },
  });
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("relative grid rounded-md border border-border bg-muted/50 p-0.5", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className={cn("pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[5px] bg-background shadow-sm", TRANSFORM_TRANSITION)}
        style={{ width: `calc((100% - 0.25rem) / ${options.length})`, transform: `translate3d(${index * 100}%, 0, 0)` }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={!picker || option.value === value ? 0 : -1}
          disabled={option.disabled}
          title={option.title}
          {...(option.value === value ? selectedTabProps : undefined)}
          onKeyDown={onKeyDown}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative rounded text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            PRESS,
            option.value === value ? "text-foreground" : "text-muted-foreground enabled:hover:text-foreground",
            tabClassName,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Marks the plugin's own menus so board keys can find them; a class because bb's menu drops data attributes. */
export const KANBAN_MENU = "kanban-menu";

const MENU_KEYS = createMenuKeys();

/** j/k and gg/G step through a menu's items while focus is inside it, claimed before Radix's typeahead takes the letters. */
export function menuVimKeys(event: KeyboardEvent<HTMLElement>): void {
  MENU_KEYS.handle(event.nativeEvent);
}

export const MENU_ITEM_CLASS =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";

/** A list row that cascades in with its list, rises in when added later, and sinks out when removed (see `usePresenceList`). */
export function MotionListItem({
  arrival,
  index,
  exiting = false,
  onExited,
  onAnimationEnd,
  className,
  children,
}: {
  arrival: Arrival;
  index: number;
  exiting?: boolean;
  onExited?: () => void;
  onAnimationEnd?: (event: AnimationEvent) => void;
  className?: string;
  children: ReactNode;
}) {
  const entrance = useEntrance(arrival === "intro" ? cn(enter.rise, speed.fast, STAGGER) : arrival === "new" ? enter.rise : undefined);
  return (
    <li
      style={stagger(index)}
      aria-hidden={exiting || undefined}
      inert={exiting}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (exiting) {
          onExited?.();
          return;
        }
        entrance.onAnimationEnd(event);
        onAnimationEnd?.(event);
      }}
      className={cn(className, exiting ? exit.sink : entrance.className)}
    >
      {children}
    </li>
  );
}
