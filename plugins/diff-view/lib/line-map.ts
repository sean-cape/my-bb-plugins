// Where a line of one version of a file sits in a later one, the way GitHub keeps a comment on its line across pushes:
// lines outside the changes move by the lines added and removed above them, and a comment on a changed line is outdated.
// Pure, shared by the view and every host's server.
import { walkPatch } from "./patch";

/** A run of changes between two versions of a file: `oldCount` lines from `oldStart` became `newCount` lines from `newStart`; a count of 0 is a pure insertion (before old line `oldStart`) or deletion. */
export type ChangeBlock = [oldStart: number, oldCount: number, newStart: number, newCount: number];

/** A unified patch's runs of deleted and added lines, in order. */
export function changeBlocks(patch: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let nextOld = 1;
  let nextNew = 1;
  let open: ChangeBlock | null = null;
  const close = () => {
    if (open !== null) blocks.push(open);
    open = null;
  };
  walkPatch(patch, {
    header: (header) => {
      close();
      // A side with no lines in the hunk names the line before it (`@@ -4,0 +5 @@` inserts after old line 4).
      nextOld = header.oldCount === 0 ? header.oldStart + 1 : header.oldStart;
      nextNew = header.newCount === 0 ? header.newStart + 1 : header.newStart;
    },
    line: (line) => {
      if (line.mark === " ") {
        close();
        nextOld += 1;
        nextNew += 1;
        return;
      }
      if (open === null) open = [nextOld, 0, nextNew, 0];
      if (line.mark === "-") {
        open[1] += 1;
        nextOld += 1;
      } else {
        open[3] += 1;
        nextNew += 1;
      }
    },
  });
  close();
  return blocks;
}

/**
 * Lines `start`–`end` of the older version as they sit in the newer one; null when the changes touched any of them,
 * or inserted lines among them, which makes a comment on them outdated.
 */
export function mapLines(blocks: readonly ChangeBlock[], start: number, end: number): { start: number; end: number } | null {
  let offset = 0;
  for (const [oldStart, oldCount, , newCount] of blocks) {
    if (oldCount === 0) {
      if (oldStart <= start) offset += newCount;
      else if (oldStart <= end) return null;
      continue;
    }
    const last = oldStart + oldCount - 1;
    if (oldStart <= end && last >= start) return null;
    if (last < start) offset += newCount - oldCount;
  }
  return { start: start + offset, end: end + offset };
}
