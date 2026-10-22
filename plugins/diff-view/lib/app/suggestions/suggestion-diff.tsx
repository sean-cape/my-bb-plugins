import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { parseCommentBody } from "../../suggestions";
import { cn } from "../utils";
import { hangingIndent } from "../text/hanging-indent";

/**
 * A suggested change as a small diff: the lines it replaces (`expected`, null when they are not known here) as
 * removed, then the suggestion as added. Line numbers count from `startLine` on both sides.
 */
export function SuggestionDiff({ expected, replacement, startLine, label = "Suggested change", badge }: { expected: readonly string[] | null; replacement: readonly string[]; startLine: number | null; label?: string; badge?: ReactNode }) {
  const row = (mark: "-" | "+", text: string, line: number | null, key: string) => (
    <div key={key} className={cn("flex min-w-0", mark === "-" ? "bg-red-500/10" : "bg-emerald-500/10")}>
      <span className={cn("w-10 shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground", mark === "-" ? "bg-red-500/15" : "bg-emerald-500/15")}>{line ?? ""}</span>
      <span className="w-4 shrink-0 select-none text-center text-muted-foreground">{mark}</span>
      {/* break-normal: a thread's card breaks words, and that inherits. */}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-normal pr-2" style={hangingIndent(text)}>
        {text === "" ? " " : text}
      </span>
    </div>
  );
  const at = (offset: number) => (startLine === null ? null : startLine + offset);
  return (
    // Lines wrap only at spaces, so a long identifier scrolls the block sideways instead of breaking.
    <div data-suggestion="" className="my-1 overflow-x-auto rounded-md border border-border font-mono text-xs leading-5">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-0.5 font-sans text-[11px] text-muted-foreground">
        <span>{label}</span>
        {expected === null ? <span className="italic">the lines it replaces aren't in this diff</span> : null}
        {badge !== undefined ? <span className="ml-auto flex items-center gap-1">{badge}</span> : null}
      </div>
      {(expected ?? []).map((text, offset) => row("-", text, at(offset), `-${offset}`))}
      {replacement.map((text, offset) => row("+", text, at(offset), `+${offset}`))}
      {replacement.length === 0 ? <p className="px-2 py-0.5 font-sans text-[11px] italic text-muted-foreground">Deletes the lines</p> : null}
    </div>
  );
}

/** A comment body with each suggestion block drawn as a `SuggestionDiff` over `expected`, the commented lines today. */
export function CommentBody({ body, expected, startLine, badge }: { body: string; expected: readonly string[] | null; startLine: number | null; badge?: ReactNode }) {
  const parts = parseCommentBody(body);
  if (!parts.some((part) => part.kind === "suggestion")) return <Markdown content={body} className="text-sm" />;
  let first = true;
  return (
    <div className="flex flex-col gap-1">
      {parts.map((part, index) => {
        if (part.kind === "markdown") return <Markdown key={index} content={part.text} className="text-sm" />;
        // The badge (applied, in batch) belongs to the block that applies: the first.
        const shownBadge = first ? badge : undefined;
        first = false;
        return <SuggestionDiff key={index} expected={expected} replacement={part.lines} startLine={startLine} badge={shownBadge} />;
      })}
    </div>
  );
}
