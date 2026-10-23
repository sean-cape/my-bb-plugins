/** Lines past this many go unmarked, so a rewrite of a huge file doesn't hand Pierre a stylesheet as big as the file. */
const MARKED_LINES_CAP = 4000;

/**
 * Pierre's stylesheet rule marking the added lines new since the last review, in blue in the gutter as the structural
 * view marks them. Only additions: an added line's number is always its new-side number, where a context line's
 * `data-column-number` is the side it is drawn on. "" when nothing is new.
 */
export function newSinceCss(ranges: ReadonlyArray<readonly [number, number]>): string {
  const lines: number[] = [];
  for (const [from, to] of ranges) for (let line = from; line <= to && lines.length < MARKED_LINES_CAP; line++) lines.push(line);
  if (lines.length === 0) return "";
  const numbers = lines.map((line) => `[data-column-number="${line}"]`).join(",");
  return `[data-line-type="change-addition"]:is(${numbers}){box-shadow:inset 3px 0 0 0 rgb(14 165 233);background-color:rgb(14 165 233 / 0.28)}`;
}
