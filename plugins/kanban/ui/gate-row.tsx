import type { ReactElement, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { GateOption } from "./gates";

/** The provider every `Tip` needs above it: a short wait before the first tip, shorter between neighbours. */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </Tooltip.Provider>
  );
}

/** A tooltip that opens on hover and when the keys reach its trigger, for the longer story behind a short label. */
export function Tip({ text, children }: { text: string; children: ReactElement }) {
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

/** One gate's checkbox, label and hint, with its longer story in a tooltip; needs a `TipProvider` above it. */
export function GateRow({ option, checked, disabled, onChange }: { option: GateOption; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
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
