// @vitest-environment jsdom

import { KEY_COMMAND_EVENT, type KeyCommandDetail } from "bb-vim-keys";
import { afterEach, describe, expect, it } from "vitest";
import { announceShortcut } from "./shortcut.js";

let seen: KeyCommandDetail[] = [];
const listen = (event: Event) => seen.push((event as CustomEvent<KeyCommandDetail>).detail);

afterEach(() => {
  window.removeEventListener(KEY_COMMAND_EVENT, listen);
  seen = [];
});

describe("announceShortcut", () => {
  it("announces the chord that ran a command, with its keydown", () => {
    window.addEventListener(KEY_COMMAND_EVENT, listen);
    const back = new KeyboardEvent("keydown", { key: "o", ctrlKey: true });
    const rail = new KeyboardEvent("keydown", { key: "2", metaKey: true });
    announceShortcut(document, back);
    announceShortcut(document, rail);
    expect(seen.map(({ keys, event }) => [keys, event])).toEqual([
      ["<C-o>", back],
      ["<D-2>", rail],
    ]);
  });

  it("stays quiet when the command came from the palette rather than a key", () => {
    window.addEventListener(KEY_COMMAND_EVENT, listen);
    announceShortcut(document, new MouseEvent("click"));
    announceShortcut(document, undefined);
    expect(seen).toEqual([]);
  });
});
