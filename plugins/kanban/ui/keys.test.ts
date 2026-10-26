import { describe, expect, it } from "vitest";
import { createPickerKeys, type KeyHelpSection, keymapConflicts, unboundHelpKeys } from "bb-vim-keys";
import { CARD_KEYMAP, KEY_HELP, KEYMAP, LOOP_MENU_KEYMAP, REVIEW_POPOVER_KEYS, SEND_BAR_KEYS } from "./board-nav";

// The same shapes as ProjectSelect's (a filter box behind / and i) and TagPicker's (a filter box alone).
const projectPicker = createPickerKeys({ length: () => 0, highlight: () => null, setHighlight: () => {}, pick: () => {}, openFilter: () => {} });
const tagPicker = createPickerKeys({ length: () => 0, highlight: () => null, setHighlight: () => {}, pick: () => {} });

const section = (title: string): KeyHelpSection[] => {
  const found = KEY_HELP.find((entry) => entry.title === title);
  if (found === undefined) throw new Error(`no help section ${title}`);
  return [found];
};

describe("keymaps", () => {
  it("have no sequence that also starts a longer one", () => {
    expect(keymapConflicts(KEYMAP)).toEqual([]);
    expect(keymapConflicts(CARD_KEYMAP)).toEqual([]);
    expect(keymapConflicts(SEND_BAR_KEYS)).toEqual([]);
    expect(keymapConflicts(REVIEW_POPOVER_KEYS)).toEqual([]);
    expect(keymapConflicts(LOOP_MENU_KEYMAP)).toEqual([]);
    for (const picker of [projectPicker, tagPicker]) {
      expect(keymapConflicts(picker.keymaps.list)).toEqual([]);
      expect(keymapConflicts(picker.keymaps.filter)).toEqual([]);
    }
  });
});

describe("the shortcuts list", () => {
  it("shows only keys something binds", () => {
    expect(unboundHelpKeys(KEY_HELP, [KEYMAP, CARD_KEYMAP, LOOP_MENU_KEYMAP, projectPicker.keymaps.list, projectPicker.keymaps.filter])).toEqual([]);
  });

  it("matches each surface's keys to that surface's keymap", () => {
    // Enter and Space press the focused card (a role=button), todo row or top-bar button themselves.
    const pressed = ["Enter", "Space"];
    for (const title of ["Board", "Todo list", "Top bar, column + and filters"]) {
      expect(unboundHelpKeys(section(title), KEYMAP, pressed)).toEqual([]);
    }
    expect(unboundHelpKeys(section("Open card"), CARD_KEYMAP)).toEqual([]);
    // The loop menu is a Radix menu: j/k come from the shared menu keys, Enter and Escape are Radix's own.
    expect(unboundHelpKeys(section("Loop menu"), LOOP_MENU_KEYMAP, ["j", "k", "Enter", "Esc"])).toEqual([]);
    expect(unboundHelpKeys(section("Open project list"), [projectPicker.keymaps.list, projectPicker.keymaps.filter])).toEqual([]);
  });

  it("gives the card its own Escape, which the board leaves alone", () => {
    expect(CARD_KEYMAP["<Esc>"]).toEqual({ kind: "close" });
    expect(KEYMAP["<Esc>"]).toBeUndefined();
  });
});
