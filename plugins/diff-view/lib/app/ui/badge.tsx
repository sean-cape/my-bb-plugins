import type { ReactNode } from "react";
import { cn } from "../utils";

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  /** `fresh`: changed since the point new code counts from (the last review), the blue the gutter marks it in. */
  tone?: "neutral" | "outline" | "accent" | "warning" | "danger" | "success" | "fresh";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "outline" && "border border-border text-muted-foreground",
        tone === "accent" && "bg-primary/10 text-primary",
        tone === "warning" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "success" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        tone === "fresh" && "border border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      )}
    >
      {children}
    </span>
  );
}
