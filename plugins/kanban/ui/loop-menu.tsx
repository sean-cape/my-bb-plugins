import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { POPOVER_MOTION } from "bb-motion";
import { useKeyHandler } from "bb-vim-keys/react";
import type { Ticket } from "../shared/board";
import type { LoopGates } from "../shared/loop";
import { DIRECTIVE_TEXT } from "../shared/stages";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { RunAction } from "./actions";
import { LOOP_MENU_KEYMAP } from "./board-nav";
import type { Rpc } from "./data";
import { handOffDirective, loopMenuItems, type LoopGateItemId, type LoopMenuItem, type LoopMenuItemId } from "./loop-menu-items";
import { KANBAN_MENU, MENU_ITEM_CLASS, menuVimKeys } from "./primitives";

export interface LoopActionHandlers {
  /** Steer and Resume: put the keyboard in the loop section's composer, opening the card first where the menu is on the board. */
  onCompose: () => void;
  onToggleMonitored: () => void;
}

/** The items that are one RPC call each, which any surface can run from the item alone. */
export type LoopRpcItemId = Exclude<LoopMenuItemId, "steer" | "resume" | "monitor" | LoopGateItemId>;

/** Runs an RPC item with its toast; the retry's words live here, for the menu and the brief's button alike. */
export function runLoopItem(id: LoopRpcItemId, ticket: Ticket, rpc: Rpc, run: RunAction): void {
  switch (id) {
    case "hand-off": {
      const directive = ticket.loop === null ? null : handOffDirective(ticket.loop);
      if (directive !== null) void run(() => rpc.call("loop_set_directive", { id: ticket.id, directive }), DIRECTIVE_TEXT[directive]);
      return;
    }
    case "skip-review":
      void run(() => rpc.call("loop_set_directive", { id: ticket.id, directive: "skip-review-once" }), DIRECTIVE_TEXT["skip-review-once"]);
      return;
    case "stop":
      void run(() => rpc.call("loop_stop", { id: ticket.id }), "Stopping the board's step; the card comes to you");
      return;
    case "retry":
      void run(() => rpc.call("loop_retry", { id: ticket.id }), "Running the failed step again");
      return;
  }
}

/** Runs a menu item other than a gate: the RPC ones through `runLoopItem`, the two that need the card's composer or switch through the handlers. */
export function pickLoopItem(id: Exclude<LoopMenuItemId, LoopGateItemId>, ticket: Ticket, rpc: Rpc, run: RunAction, handlers: LoopActionHandlers): void {
  switch (id) {
    case "steer":
    case "resume":
      handlers.onCompose();
      return;
    case "monitor":
      handlers.onToggleMonitored();
      return;
    default:
      runLoopItem(id, ticket, rpc, run);
  }
}

const isGate = (id: LoopMenuItemId): id is LoopGateItemId => id.startsWith("gate:");

function ItemBody({ item }: { item: LoopMenuItem }) {
  // A disabled item takes no pointer events, so its reason is written out rather than put in a title.
  const note = item.disabled ?? item.hint;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-2">
        <span className="flex-1">{item.label}</span>
        {item.key === undefined ? null : <kbd className="font-mono text-[10px] text-muted-foreground">{item.key}</kbd>}
      </span>
      {note === undefined ? null : <span className="text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

/**
 * The loop menu under `m`: every intervention with its key, the gates, and loop off. Items the server would
 * refuse in this phase are greyed with the reason. `children` is the trigger; `open` is controlled, since the key that
 * opens it isn't a click on the trigger.
 */
export function LoopMenu({
  ticket,
  rpc,
  run,
  open,
  onOpenChange,
  handlers,
  onCloseAutoFocus,
  align = "end",
  children,
}: {
  ticket: Ticket;
  rpc: Rpc;
  run: RunAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handlers: LoopActionHandlers;
  /** Where focus goes as the menu closes; by default Radix returns it to the trigger. */
  onCloseAutoFocus?: (event: Event) => void;
  align?: "start" | "end";
  children: ReactNode;
}) {
  // The gates as ticked in this visit: the server stores them whole, so a second tick before the refetch must build on the first, not on the ticket as rendered.
  const [gates, setGates] = useState<LoopGates | null>(null);
  // Seeded as the menu opens; while it is open the ticket's gates change only through it.
  useEffect(() => {
    if (open) setGates(ticket.loop?.gates ?? null);
  }, [open]);
  const shown = gates === null || ticket.loop === null ? ticket : { ...ticket, loop: { ...ticket.loop, gates } };
  const items = loopMenuItems(shown);
  // Composing starts after the menu has closed, or Radix's focus return would take the keyboard back out of the composer.
  const composeOnClose = useRef(false);
  const pick = (id: LoopMenuItemId) => {
    if (isGate(id)) {
      if (shown.loop === null) return;
      const gate = id.slice("gate:".length) as keyof LoopGates;
      const next = { ...shown.loop.gates, [gate]: !shown.loop.gates[gate] };
      setGates(next);
      void run(() => rpc.call("loop_set_gates", { id: ticket.id, gates: next }));
      return;
    }
    if (id === "steer" || id === "resume") {
      composeOnClose.current = true;
      onOpenChange(false);
      return;
    }
    pickLoopItem(id, ticket, rpc, run, handlers);
  };
  const letterKeys = useKeyHandler({
    keymap: LOOP_MENU_KEYMAP,
    leaveToPressables: false,
    onCommand: (id) => {
      const item = items.find((entry) => entry.id === id);
      if (item === undefined || item.disabled !== null) return;
      pick(item.id);
      if (item.id !== "steer") onOpenChange(false);
    },
  });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    menuVimKeys(event);
    if (!event.nativeEvent.defaultPrevented) letterKeys(event);
  };
  const row = (item: LoopMenuItem) =>
    item.checked === undefined ? (
      <DropdownMenu.Item key={item.id} className={cn(MENU_ITEM_CLASS, "items-start")} disabled={item.disabled !== null} onSelect={() => pick(item.id)}>
        <ItemBody item={item} />
      </DropdownMenu.Item>
    ) : (
      <DropdownMenu.CheckboxItem
        key={item.id}
        className={cn(MENU_ITEM_CLASS, "items-start pl-7")}
        checked={item.checked}
        disabled={item.disabled !== null}
        onCheckedChange={() => pick(item.id)}
        // The menu stays open, so several gates can be set in one visit.
        onSelect={(event) => event.preventDefault()}
      >
        <DropdownMenu.ItemIndicator className="absolute left-2 mt-0.5">
          <Icon name="Check" className="size-3.5" />
        </DropdownMenu.ItemIndicator>
        <ItemBody item={item} />
      </DropdownMenu.CheckboxItem>
    );
  const gateRows = items.filter((item) => item.checked !== undefined);
  const actions = items.filter((item) => item.checked === undefined && item.id !== "monitor");
  const monitor = items.find((item) => item.id === "monitor")!;
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...usePortalScopeProps()}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cn("z-50 w-72 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", POPOVER_MOTION, KANBAN_MENU)}
          aria-label="Review loop"
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            if (composeOnClose.current) {
              composeOnClose.current = false;
              event.preventDefault();
              handlers.onCompose();
              return;
            }
            onCloseAutoFocus?.(event);
          }}
        >
          {actions.map(row)}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className="px-2 pt-1 text-xs text-muted-foreground">Gates</DropdownMenu.Label>
          {gateRows.map(row)}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {row(monitor)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
