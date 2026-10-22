import type { CSSProperties } from "react";

/** A wrapped code line continues under its own first character, not at the margin, as an editor wraps; tabs count four. */
export function hangingIndent(text: string): CSSProperties | undefined {
  const indent = (/^[ \t]*/u.exec(text)?.[0] ?? "").replace(/\t/gu, "    ").length;
  return indent > 0 ? { paddingLeft: `${indent}ch`, textIndent: `-${indent}ch` } : undefined;
}
