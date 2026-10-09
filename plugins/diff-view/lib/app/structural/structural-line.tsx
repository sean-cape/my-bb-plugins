import { memo, type ReactNode } from "react";
import type { DiffSide, StructuralDiff } from "../../types";
import { cn } from "../utils";
import type { LineTokens } from "./syntax";

const HIGHLIGHT_CLASS: Record<string, string> = {
  keyword: "text-violet-600 dark:text-violet-300",
  string: "text-emerald-700 dark:text-emerald-300",
  type: "text-sky-700 dark:text-sky-300",
  comment: "text-muted-foreground italic",
  delimiter: "text-muted-foreground",
  treesittererror: "underline decoration-wavy decoration-destructive",
  normal: "",
};
export const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/gu;

/** One side's line: Shiki colours per token, changed spans tinted by difftastic, identifiers made ⌘-clickable. */
export const StructuralLine = memo(function StructuralLine({
  text,
  changes,
  tokens,
  side,
  onSymbol,
  onSymbolHover,
}: {
  text: string;
  changes: StructuralDiff["oldChanges"][number] | null;
  tokens: LineTokens | null;
  side: DiffSide;
  onSymbol: (symbol: string, anchor: HTMLElement) => void;
  onSymbolHover?: (symbol: string | null, anchor: HTMLElement | null) => void;
}) {
  // Segment boundaries come from both the Shiki tokens and difftastic's changed spans so each piece has one colour and one tint.
  const spans = (changes?.changes ?? []).slice().sort((a, b) => a.start - b.start);
  const cuts = new Set<number>([0, text.length]);
  for (const span of spans) {
    cuts.add(Math.min(span.start, text.length));
    cuts.add(Math.min(span.end, text.length));
  }
  const tokenStarts: Array<{ start: number; end: number; color: string | undefined }> = [];
  let offset = 0;
  for (const token of tokens ?? []) {
    tokenStarts.push({ start: offset, end: offset + token.content.length, color: token.color });
    offset += token.content.length;
    cuts.add(Math.min(offset, text.length));
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const segments: Array<{ text: string; changed: boolean; highlight: string; color: string | undefined }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (end <= start) continue;
    const span = spans.find((entry) => entry.start <= start && entry.end >= end);
    const token = tokenStarts.find((entry) => entry.start <= start && entry.end >= end);
    segments.push({ text: text.slice(start, end), changed: span !== undefined, highlight: span?.highlight ?? "normal", color: token?.color });
  }
  if (segments.length === 0) segments.push({ text: "", changed: false, highlight: "normal", color: undefined });
  const renderTokens = (segment: string, key: string) => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of segment.matchAll(IDENTIFIER)) {
      const index = match.index ?? 0;
      if (index > last) parts.push(segment.slice(last, index));
      const word = match[0];
      parts.push(
        <span
          key={`${key}-${index}`}
          data-symbol={word}
          className="rounded-sm [.symbol-mode_&]:cursor-pointer [.symbol-mode_&]:hover:bg-primary/15 [.symbol-mode_&]:hover:underline"
          onClick={(event) => {
            if (!(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            event.stopPropagation();
            onSymbol(word, event.currentTarget);
          }}
          onPointerEnter={(event) => onSymbolHover?.(word, event.currentTarget)}
          onPointerLeave={() => onSymbolHover?.(null, null)}
        >
          {word}
        </span>,
      );
      last = index + word.length;
    }
    if (last < segment.length) parts.push(segment.slice(last));
    return parts;
  };
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          style={segment.color !== undefined ? { color: segment.color } : undefined}
          className={cn(
            segment.color === undefined ? (HIGHLIGHT_CLASS[segment.highlight] ?? "") : "",
            segment.changed && (side === "LEFT" ? "rounded-sm bg-red-500/25" : "rounded-sm bg-emerald-500/25"),
          )}
        >
          {renderTokens(segment.text, `${index}`)}
        </span>
      ))}
    </>
  );
});
