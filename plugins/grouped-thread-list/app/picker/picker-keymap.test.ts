import { describe, expect, it } from "vitest";
import {
  keyName,
  pickerHints,
  PICKER_KEYMAP,
  PREVIEW_KEYMAP,
  resolveFilterKey,
  resolvePickerKey,
  resolvePreviewKey,
} from "./picker-keymap.js";

function command(key: string, pendingKey: string | null = null) {
  const resolved = resolvePickerKey(key, pendingKey);
  return resolved.type === "command" ? resolved.command : resolved.type;
}

describe("picker keymap", () => {
  it("names Ctrl chords with a C- prefix", () => {
    expect(keyName({ key: "n", ctrlKey: true })).toBe("C-n");
    expect(keyName({ key: "N", ctrlKey: false })).toBe("N");
  });

  it("maps vim keys, arrows, and Ctrl+N/P to the same moves", () => {
    expect(["j", "ArrowDown", "C-n"].map((key) => command(key))).toEqual([
      "down",
      "down",
      "down",
    ]);
    expect(["k", "ArrowUp", "C-p"].map((key) => command(key))).toEqual([
      "up",
      "up",
      "up",
    ]);
    expect(
      ["h", "l", "Tab", "G", "Enter", "o", "/", "q"].map((key) => command(key)),
    ).toEqual([
      "left",
      "right",
      "switch-column",
      "bottom",
      "activate",
      "activate",
      "filter",
      "close",
    ]);
    expect(command("x")).toBe("unbound");
  });

  it("jumps to the top only on gg", () => {
    expect(command("g")).toBe("pending");
    expect(command("g", "g")).toBe("top");
    expect(command("g", "j")).toBe("pending");
    expect(command("j", "g")).toBe("down");
  });

  it("hints only the keys that act in the focused column", () => {
    expect(pickerHints("left")).toEqual([
      ["↵", "open"],
      ["n", "new thread"],
      ["/", "filter"],
      ["esc", "close"],
    ]);
    expect(pickerHints("right")).toEqual([
      ["l", "preview"],
      ["↵", "open"],
      ["p", "pin"],
      ["r", "mark read"],
      ["d", "delete"],
      ["u", "undo"],
      ["n", "new thread"],
    ]);
    expect(pickerHints("preview")).toEqual([
      ["⌃d", "scroll down"],
      ["⌃u", "scroll up"],
      ["h", "back"],
      ["↵", "open"],
      ["p", "pin"],
      ["r", "mark read"],
      ["d", "delete"],
      ["u", "undo"],
      ["n", "new thread"],
    ]);
    expect(command("d")).toBe("archive");
    expect(command("u")).toBe("undo-archive");
  });

  it("keeps preview scrolling keys out of the main map", () => {
    const pickerKeys = new Set(
      PICKER_KEYMAP.flatMap((binding) => binding.keys),
    );
    for (const binding of PREVIEW_KEYMAP) {
      for (const key of binding.keys) expect(pickerKeys.has(key)).toBe(false);
    }
    expect(
      ["C-d", "C-u", "C-f", "C-b", "C-e", "C-y"].map(resolvePreviewKey),
    ).toEqual([
      "half-down",
      "half-up",
      "page-down",
      "page-up",
      "line-down",
      "line-up",
    ]);
    expect(resolvePreviewKey("j")).toBeUndefined();
  });

  it("leaves typed letters to the filter box", () => {
    expect(
      ["ArrowDown", "C-n", "ArrowUp", "C-p", "Enter", "Escape"].map(
        resolveFilterKey,
      ),
    ).toEqual(["down", "down", "up", "up", "accept", "cancel"]);
    expect(["j", "k", "q", "/"].map(resolveFilterKey)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("binds each key at most once", () => {
    const keys = PICKER_KEYMAP.flatMap((binding) => binding.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
