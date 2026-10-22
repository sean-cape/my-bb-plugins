import { beforeAll, describe, expect, it } from "vitest";
import { COMMIT_PICKER_KEYMAP, collapsedRangeNote, pickedRange, pickerRows, rangeLabel, toggledRangeStart } from "./lib/app/commits/commit-range";
import type { CommitRange, DiffCommits } from "./lib/types";
import { createPickerKeys } from "../vim-mode/lib/index.ts";

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const commit = (n: number) => ({ sha: sha(n), summary: `commit ${n}`, author: "a", date: "" });
const HISTORY: DiffCommits = { commits: [commit(1), commit(2), commit(3), commit(4)], marks: [{ sha: sha(1), label: "Since last review" }], base: sha(9) };

/** The commit picker's keys as the component wires them, over a highlighted row and a started range. */
function picker(commits: DiffCommits) {
  const rows = pickerRows(commits);
  const state = { highlight: 0, start: null as number | null, picked: undefined as { range: CommitRange | null; note: string | null } | undefined };
  const keys = createPickerKeys<"mark">({
    length: () => rows.length,
    highlight: () => state.highlight,
    setHighlight: (index) => (state.highlight = index),
    pick: (index) => {
      const row = rows[index]!;
      const range = pickedRange(commits, row, state.start);
      if (range !== undefined) state.picked = { range, note: collapsedRangeNote(commits, row, state.start) };
    },
    keymap: COMMIT_PICKER_KEYMAP,
    onCommand: (_, { event }) => {
      if (event.repeat) return;
      const next = toggledRangeStart(rows[state.highlight], state.start);
      if (next !== undefined) state.start = next;
    },
  });
  let at = 0;
  const press = (...keyNames: string[]) => {
    for (const key of keyNames) {
      const event = { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, defaultPrevented: false, target: null, timeStamp: (at += 100), preventDefault() {} };
      keys.list(event as unknown as KeyboardEvent);
    }
  };
  return { state, press };
}

beforeAll(() => {
  // The key handler checks targets with `instanceof Element`, which node lacks.
  (globalThis as { Element?: unknown }).Element ??= class {};
});

describe("the commit picker's range keys", () => {
  // Rows: All changes, the mark, then commits 1-4.
  it("picks the commits between a Space and an Enter, either way round", () => {
    const down = picker(HISTORY);
    down.press("j", "j", "j", " ", "j", "Enter");
    expect(down.state.picked).toEqual({ range: { from: sha(1), to: sha(3) }, note: null });
    expect(rangeLabel(down.state.picked!.range, HISTORY)).toBe("2 commits");

    const up = picker(HISTORY);
    up.press("G", "x", "k", "Enter");
    expect(up.state.picked?.range).toEqual({ from: sha(2), to: sha(4) });
    expect(rangeLabel(up.state.picked!.range, HISTORY)).toBe("2 commits");
  });

  it("drops the start on a second Space, and picks one commit after", () => {
    const session = picker(HISTORY);
    session.press("j", "j", " ", " ", "j", "Enter");
    expect(session.state.start).toBeNull();
    expect(rangeLabel(session.state.picked!.range, HISTORY)).toBe(sha(2).slice(0, 7));
  });

  it("says why Enter on the start commit, or across every commit, is not a range", () => {
    // j at the last row stays there, so the Enter lands on the start commit itself.
    const clamped = picker(HISTORY);
    clamped.press("G", " ", "j", "Enter");
    expect(clamped.state.picked?.range).toEqual({ from: sha(3), to: sha(4) });
    expect(clamped.state.picked?.note).toMatch(/alone/);

    const everything = picker(HISTORY);
    everything.press("j", "j", " ", "G", "Enter");
    expect(everything.state.picked).toEqual({ range: null, note: "Those are all the commits: showing all changes" });
  });

  it("starts no range off a commit row", () => {
    expect(toggledRangeStart({ kind: "all" }, null)).toBeUndefined();
    expect(toggledRangeStart({ kind: "mark", sha: sha(1), label: "x" }, 2)).toBeUndefined();
  });
});
