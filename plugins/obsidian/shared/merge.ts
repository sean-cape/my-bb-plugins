import { merge } from "node-diff3";

/**
 * Line-level three-way merge of local edits (`mine`) and a disk change
 * (`theirs`) made since `base`. Returns null when the two touch the same lines.
 */
export function mergeText(mine: string, base: string, theirs: string): string | null {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const separator = mine.includes("\r\n") ? "\r\n" : "\n";
  const split = (text: string) => text.replace(/\r\n/g, "\n").split("\n");
  const result = merge(split(mine), split(base), split(theirs));
  return result.conflict ? null : result.result.join(separator);
}
