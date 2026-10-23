import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceKeyCommand,
  bindKeyScope,
  chordToken,
  createKeyReader,
  cycle,
  displaySequence,
  KEY_COMMAND_EVENT,
  type KeyCommandDetail,
  keymapConflicts,
  keyToken,
  listAction,
  type NavRow,
  readRows,
  runListMotion,
  stepWrapping,
  tokenize,
  unboundHelpKeys,
} from "../lib/index.ts";

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}

describe("chordToken", () => {
  it("writes ⌘ and ⌥ chords, which bb owns, in vim notation", () => {
    expect(chordToken(key("k", { metaKey: true }))).toBe("<D-k>");
    expect(chordToken(key("D", { metaKey: true, shiftKey: true }))).toBe("<D-S-d>");
    expect(chordToken(key("ArrowLeft", { altKey: true }))).toBe("<A-Left>");
    expect(chordToken(key("f", { metaKey: true, ctrlKey: true }))).toBe("<D-C-f>");
    expect(chordToken(key("j"))).toBe("j");
    expect(chordToken(key("Meta", { metaKey: true }))).toBeNull();
  });
});

describe("keyToken", () => {
  it("writes printable keys as themselves and the rest in vim notation", () => {
    expect(keyToken(key("j"))).toBe("j");
    expect(keyToken(key("G", { shiftKey: true }))).toBe("G");
    expect(keyToken(key("?", { shiftKey: true }))).toBe("?");
    expect(keyToken(key("d", { ctrlKey: true }))).toBe("<C-d>");
    expect(keyToken(key("D", { ctrlKey: true, shiftKey: true }))).toBe("<C-S-d>");
    expect(keyToken(key("Escape"))).toBe("<Esc>");
    expect(keyToken(key("Enter"))).toBe("<CR>");
    expect(keyToken(key("Enter", { shiftKey: true }))).toBe("<CR>");
    expect(keyToken(key("ArrowDown", { shiftKey: true }))).toBe("<Down>");
    expect(keyToken(key(" "))).toBe("<Space>");
    expect(keyToken(key("Tab", { shiftKey: true }))).toBe("<S-Tab>");
    expect(keyToken(key("ArrowDown"))).toBe("<Down>");
    expect(keyToken(key("F2"))).toBe("<F2>");
  });

  it("leaves ⌘ and ⌥ chords, bare modifiers, and composition alone", () => {
    expect(keyToken(key("k", { metaKey: true }))).toBeNull();
    expect(keyToken(key("j", { altKey: true }))).toBeNull();
    expect(keyToken(key("Shift", { shiftKey: true }))).toBeNull();
    expect(keyToken(key("Control", { ctrlKey: true }))).toBeNull();
    expect(keyToken(key("Dead"))).toBeNull();
    expect(keyToken(key("a", { isComposing: true }))).toBeNull();
  });
});

describe("sequences", () => {
  it("split into tokens and read the way shortcut lists write them", () => {
    expect(tokenize("gg")).toEqual(["g", "g"]);
    expect(tokenize("<C-w>j")).toEqual(["<C-w>", "j"]);
    expect(tokenize("<")).toEqual(["<"]);
    expect(displaySequence("gO")).toBe("gO");
    expect(displaySequence("<C-d>")).toBe("Ctrl-d");
    expect(displaySequence("<CR>")).toBe("Enter");
    expect(displaySequence("<Esc>")).toBe("Esc");
    expect(displaySequence("<C-w>j")).toBe("Ctrl-w j");
  });
});

describe("createKeyReader", () => {
  const keymap = { j: "down", gg: "top", gO: "outline", dd: "delete", "<C-d>": "half", "0": "start" } as const;

  it("waits on the first key of a sequence and runs it on the second", () => {
    const reader = createKeyReader(keymap);
    expect(reader.read("g", 0)).toEqual({ kind: "pending", keys: "g" });
    expect(reader.pending).toBe("g");
    expect(reader.read("g", 100)).toEqual({ kind: "command", command: "top", keys: "gg", count: null });
    expect(reader.pending).toBe("");
  });

  it("starts over on a key that can't continue the sequence", () => {
    const reader = createKeyReader(keymap);
    reader.read("g", 0);
    expect(reader.read("j", 10)).toMatchObject({ kind: "command", command: "down" });
    reader.read("d", 20);
    expect(reader.read("g", 30)).toEqual({ kind: "pending", keys: "g" });
    expect(reader.read("x", 40)).toEqual({ kind: "none" });
  });

  it("forgets a first key left waiting past the timeout", () => {
    const reader = createKeyReader(keymap, { timeoutMs: 500 });
    reader.read("g", 0);
    expect(reader.read("g", 501)).toEqual({ kind: "pending", keys: "g" });
    expect(reader.read("g", 900)).toMatchObject({ kind: "command", command: "top" });
    const patient = createKeyReader(keymap, { timeoutMs: Infinity });
    patient.read("g", 0);
    expect(patient.read("g", 60_000)).toMatchObject({ kind: "command", command: "top" });
  });

  it("reads Ctrl chords and shifted second keys", () => {
    const reader = createKeyReader(keymap);
    expect(reader.read("<C-d>", 0)).toMatchObject({ kind: "command", command: "half" });
    reader.read("g", 10);
    expect(reader.read("O", 20)).toMatchObject({ kind: "command", command: "outline" });
  });

  it("takes a count only when asked to, and 0 still runs alone", () => {
    expect(createKeyReader(keymap).read("5", 0)).toEqual({ kind: "none" });
    const reader = createKeyReader(keymap, { counts: true });
    expect(reader.read("1", 0)).toEqual({ kind: "pending", keys: "1" });
    expect(reader.read("0", 10)).toEqual({ kind: "pending", keys: "10" });
    expect(reader.read("j", 20)).toEqual({ kind: "command", command: "down", keys: "j", count: 10 });
    expect(reader.read("0", 30)).toEqual({ kind: "command", command: "start", keys: "0", count: null });
    reader.read("3", 40);
    expect(reader.read("g", 50)).toEqual({ kind: "pending", keys: "3g" });
    expect(reader.read("g", 60)).toEqual({ kind: "command", command: "top", keys: "gg", count: 3 });
  });

  it("finds keys that would make a sequence wait for a timeout", () => {
    expect(keymapConflicts(keymap)).toEqual([]);
    expect(keymapConflicts({ g: 1, gg: 2, "<C-w>": 3, "<C-w>j": 4 })).toEqual([
      ["g", "gg"],
      ["<C-w>", "<C-w>j"],
    ]);
  });

  it("finds keys a shortcuts list shows that nothing binds", () => {
    const sections = [{ title: "", keys: [{ keys: ["j", "gg", "Ctrl-d", "Enter", "⌘↵"], action: "" }] }];
    expect(unboundHelpKeys(sections, keymap)).toEqual(["Enter", "⌘↵"]);
    expect(unboundHelpKeys(sections, keymap, ["⌘↵", "Enter"])).toEqual([]);
  });
});

describe("listAction", () => {
  // A folder (expanded) with two notes, a collapsed folder, then a root note.
  const tree: NavRow[] = [
    { kind: "group", expanded: true, parent: null },
    { kind: "item", parent: 0 },
    { kind: "item", parent: 0 },
    { kind: "group", expanded: false, parent: null },
    { kind: "item", parent: null },
  ];
  // name, then an address section holding street and a nested geo section with lat, then age.
  const form: NavRow[] = [
    { kind: "item", parent: null },
    { kind: "group", expanded: true, parent: null },
    { kind: "item", parent: 1 },
    { kind: "group", expanded: true, parent: 1 },
    { kind: "item", parent: 3 },
    { kind: "item", parent: null },
  ];

  it("lands on the start row, clamped, when there's no cursor", () => {
    expect(listAction(tree, null, "down", 2)).toEqual({ kind: "focus", index: 2 });
    expect(listAction(tree, null, "open", 9)).toEqual({ kind: "focus", index: 4 });
    expect(listAction(tree, 7, "up", 0)).toEqual({ kind: "focus", index: 0 });
    expect(listAction([], null, "down", 0)).toBeNull();
  });

  it("moves with j/k/gg/G and stops at the ends", () => {
    expect(listAction(tree, 0, "down", 0)).toEqual({ kind: "focus", index: 1 });
    expect(listAction(tree, 4, "down", 0)).toEqual({ kind: "focus", index: 4 });
    expect(listAction(tree, 0, "up", 0)).toEqual({ kind: "focus", index: 0 });
    expect(listAction(tree, 2, "top", 0)).toEqual({ kind: "focus", index: 0 });
    expect(listAction(tree, 0, "bottom", 0)).toEqual({ kind: "focus", index: 4 });
  });

  it("opens a closed group on l, steps into an open one, and activates an item", () => {
    expect(listAction(tree, 3, "right", 0)).toEqual({ kind: "activate", index: 3 });
    expect(listAction(tree, 0, "right", 0)).toEqual({ kind: "focus", index: 1 });
    expect(listAction(tree, 2, "right", 0)).toEqual({ kind: "activate", index: 2 });
    expect(listAction([{ kind: "group", expanded: true, parent: null }], 0, "right", 0)).toBeNull();
  });

  it("closes an open group on h and climbs one level at a time", () => {
    expect(listAction(tree, 0, "left", 0)).toEqual({ kind: "activate", index: 0 });
    expect(listAction(tree, 2, "left", 0)).toEqual({ kind: "focus", index: 0 });
    expect(listAction(tree, 3, "left", 0)).toBeNull();
    expect(listAction(form, 4, "left", 0)).toEqual({ kind: "focus", index: 3 });
    expect(listAction(form, 3, "left", 0)).toEqual({ kind: "activate", index: 3 });
    expect(listAction(form, 5, "left", 0)).toBeNull();
  });

  it("never toggles a fixed group: h leaves it, l and o step into it", () => {
    const list: NavRow[] = [
      { kind: "group", expanded: true, parent: null },
      { kind: "group", expanded: true, parent: 0, fixed: true },
      { kind: "item", parent: 1 },
    ];
    expect(listAction(list, 1, "left", 0)).toEqual({ kind: "focus", index: 0 });
    expect(listAction(list, 1, "right", 0)).toEqual({ kind: "focus", index: 2 });
    expect(listAction(list, 1, "open", 0)).toEqual({ kind: "focus", index: 2 });
  });

  it("activates whatever row o is on", () => {
    expect(listAction(tree, 0, "open", 0)).toEqual({ kind: "activate", index: 0 });
    expect(listAction(tree, 1, "open", 0)).toEqual({ kind: "activate", index: 1 });
  });
});

describe("cycle and stepWrapping", () => {
  it("wrap both ways, starting from either end with nothing chosen", () => {
    const tabs = ["body", "metadata", "options"] as const;
    expect(cycle(tabs, "body", 1)).toBe("metadata");
    expect(cycle(tabs, "options", 1)).toBe("body");
    expect(cycle(tabs, "body", -1)).toBe("options");
    expect(stepWrapping(0, null, 1)).toBeNull();
    expect(stepWrapping(3, null, 1)).toBe(0);
    expect(stepWrapping(3, null, -1)).toBe(2);
    expect(stepWrapping(3, 2, 1)).toBe(0);
    expect(stepWrapping(3, 0, -1)).toBe(2);
    expect(stepWrapping(2, 5, 1)).toBe(0);
  });
});

// jsdom lays nothing out, so every element would count as hidden.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[hidden]") === null ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe("readRows and runListMotion", () => {
  it("reads a tree's groups, skipping hidden and leaving rows", () => {
    const host = mount(`
      <div data-nav-group><button data-nav-row="group" aria-expanded="true">Daily</button>
        <button data-nav-row="item">a</button>
        <button data-nav-row="item" inert>leaving</button>
      </div>
      <button data-nav-row="item" hidden>gone</button>
      <button data-nav-row="item">b</button>`);
    const { elements, rows } = readRows(host);
    expect(elements.map((element) => element.textContent)).toEqual(["Daily", "a", "b"]);
    expect(rows).toEqual([
      { kind: "group", expanded: true, parent: null },
      { kind: "item", parent: 0 },
      { kind: "item", parent: null },
    ]);
  });

  it("moves focus over rows, steps along a toolbar, and types into a field row", () => {
    const host = mount(`
      <div data-nav-row="toolbar"><button>one</button><button>two</button></div>
      <div data-nav-row="field" tabindex="-1"><input value="abc" /></div>
      <button data-nav-row="item">row</button>`);
    Element.prototype.scrollIntoView = () => {};
    expect(runListMotion(host, "down")).toBe(true);
    expect(document.activeElement?.textContent).toBe("one");
    expect(runListMotion(host, "right")).toBe(true);
    expect(document.activeElement?.textContent).toBe("two");
    expect(runListMotion(host, "right")).toBe(false);
    runListMotion(host, "down");
    expect(document.activeElement?.getAttribute("data-nav-row")).toBe("field");
    runListMotion(host, "open");
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
  });
});

describe("bindKeyScope", () => {
  const keymap = { j: "down", gg: "top", gO: "outline", "<C-d>": "half", "<CR>": "open", "<Esc>": "escape" } as const;
  const unbinds: (() => void)[] = [];
  afterEach(() => {
    for (const unbind of unbinds.splice(0)) unbind();
  });

  function scope(root: HTMLElement, options: Partial<Parameters<typeof bindKeyScope<string>>[1]> = {}) {
    const seen: string[] = [];
    unbinds.push(bindKeyScope(root, { keymap, onCommand: (command) => void seen.push(command), ...options }));
    return seen;
  }

  function press(target: EventTarget, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = key(name, init);
    target.dispatchEvent(event);
    return event;
  }

  it("runs keys from inside its root and takes them", () => {
    const host = mount(`<div id="root" tabindex="-1"><span tabindex="-1" id="row"></span></div><button id="other"></button>`);
    const seen = scope(host.querySelector("#root")!);
    const event = press(host.querySelector("#row")!, "j");
    press(host.querySelector("#row")!, "d", { ctrlKey: true });
    expect(seen).toEqual(["down", "half"]);
    expect(event.defaultPrevented).toBe(true);
    expect(press(host.querySelector("#other")!, "j").defaultPrevented).toBe(false);
    expect(seen).toEqual(["down", "half"]);
  });

  it("keeps a Shift keydown between the keys of a sequence from ending it", () => {
    const root = mount(`<div tabindex="-1"></div>`).firstElementChild as HTMLElement;
    const seen = scope(root);
    expect(press(root, "g").defaultPrevented).toBe(true);
    press(root, "Shift", { shiftKey: true });
    press(root, "O", { shiftKey: true });
    expect(seen).toEqual(["outline"]);
  });

  it("leaves keys alone that the command turns down, and ⌘ chords", () => {
    const root = mount(`<div tabindex="-1"></div>`).firstElementChild as HTMLElement;
    unbinds.push(bindKeyScope(root, { keymap, onCommand: () => false }));
    expect(press(root, "j").defaultPrevented).toBe(false);
    expect(press(root, "j", { metaKey: true }).defaultPrevented).toBe(false);
  });

  it("gives text boxes their keys, except Escape when it's asked for", () => {
    const host = mount(`<div id="root"><input id="text" /><input id="box" type="checkbox" /></div>`);
    const fields: Element[] = [];
    const seen = scope(host.querySelector("#root")!, { onTextEscape: (field) => void fields.push(field) });
    const text = host.querySelector("#text")!;
    expect(press(text, "j").defaultPrevented).toBe(false);
    expect(press(text, "Escape").defaultPrevented).toBe(true);
    expect(fields).toEqual([text]);
    press(host.querySelector("#box")!, "j");
    expect(seen).toEqual(["down"]);
  });

  it("leaves Enter to a focused button", () => {
    const host = mount(`<div id="root" tabindex="-1"><button id="press"></button><div id="row" tabindex="-1"></div></div>`);
    const seen = scope(host.querySelector("#root")!);
    expect(press(host.querySelector("#press")!, "Enter").defaultPrevented).toBe(false);
    press(host.querySelector("#row")!, "Enter");
    expect(seen).toEqual(["open"]);
  });

  it("stands down for a menu inside it or a dialog over it, but not a dialog it sits in", () => {
    const host = mount(`
      <div role="dialog" data-state="open"><div id="inner" tabindex="-1"><div role="menu"><span id="item" tabindex="-1"></span></div></div></div>
      <div id="outer" tabindex="-1"></div>`);
    const inner = scope(host.querySelector("#inner")!);
    const outer = scope(host.querySelector("#outer")!);
    press(host.querySelector("#inner")!, "j");
    press(host.querySelector("#item")!, "j");
    press(host.querySelector("#outer")!, "j");
    expect(inner).toEqual(["down"]);
    expect(outer).toEqual([]);
  });

  it("gives keys from the page body to the group's last touched, else primary, root", () => {
    const host = mount(`<div id="a" tabindex="-1"></div><div id="b" tabindex="-1"></div>`);
    const a = scope(host.querySelector("#a")!, { group: "vault", primary: true });
    const b = scope(host.querySelector("#b")!, { group: "vault" });
    press(document.body, "j");
    expect([a, b]).toEqual([["down"], []]);
    host.querySelector<HTMLElement>("#b")!.focus();
    press(document.body, "j");
    expect([a, b]).toEqual([["down"], ["down"]]);
    host.querySelector<HTMLElement>("#b")!.hidden = true;
    press(document.body, "j");
    expect(a).toEqual(["down", "down"]);
  });

  it("counts keys from elements it's told belong to it", () => {
    const host = mount(`<div id="root" tabindex="-1"></div><header data-board-header><button id="bar"></button></header>`);
    const seen = scope(host.querySelector("#root")!, { alsoWithin: "[data-board-header]" });
    press(host.querySelector("#bar")!, "j");
    expect(seen).toEqual(["down"]);
  });

  it("hands keys to intercept first, from anywhere", () => {
    const host = mount(`<div id="root" tabindex="-1"></div><div id="menu" tabindex="-1"></div>`);
    const seen = scope(host.querySelector("#root")!, { intercept: (_event, token) => token === "j" });
    expect(press(host.querySelector("#menu")!, "j").defaultPrevented).toBe(true);
    press(host.querySelector("#root")!, "g");
    press(host.querySelector("#root")!, "j");
    press(host.querySelector("#root")!, "g");
    expect(seen).toEqual([]);
  });

  it("reports the waiting keys, and their timing out, every time", () => {
    vi.useFakeTimers();
    const root = mount(`<div tabindex="-1"></div>`).firstElementChild as HTMLElement;
    const pending: string[] = [];
    scope(root, { onPending: (keys) => void pending.push(keys) });
    press(root, "g");
    press(root, "g");
    press(root, "g");
    vi.advanceTimersByTime(1001);
    press(root, "g");
    expect(pending).toEqual(["g", "", "g", "", "g"]);
    vi.useRealTimers();
  });

  it("listening in capture, keeps a key it takes from later listeners", () => {
    const root = mount(`<div tabindex="-1"></div>`).firstElementChild as HTMLElement;
    scope(root, { capture: true });
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    press(root, "j");
    press(root, "x");
    window.removeEventListener("keydown", later, true);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("claims the group's body keys when it takes focus", () => {
    const host = mount(`<div id="a" tabindex="-1"></div><div id="b" tabindex="-1"></div>`);
    const a = scope(host.querySelector("#a")!, { group: "grpc" });
    host.querySelector<HTMLElement>("#a")!.focus();
    host.querySelector<HTMLElement>("#a")!.blur();
    const b = scope(host.querySelector("#b")!, { group: "grpc", takeFocus: true });
    host.querySelector<HTMLElement>("#b")!.blur();
    press(document.body, "j");
    expect([a, b]).toEqual([[], ["down"]]);
  });

  it("moves focus onto its root from the page body or an unrelated element, not from a text box", () => {
    const host = mount(`<a href="#" id="link"></a><input id="text" /><div id="root" tabindex="-1"></div>`);
    const root = host.querySelector<HTMLElement>("#root")!;
    host.querySelector<HTMLElement>("#link")!.focus();
    scope(root, { takeFocus: true });
    expect(document.activeElement).toBe(root);
    unbinds.pop()!();
    host.querySelector<HTMLElement>("#text")!.focus();
    scope(root, { takeFocus: true });
    expect(document.activeElement?.id).toBe("text");
  });
});

describe("KEY_COMMAND_EVENT", () => {
  it("announces each command that ran, with its keys and count, on the scope's root", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const seen: KeyCommandDetail[] = [];
    window.addEventListener(KEY_COMMAND_EVENT, (event) => seen.push((event as CustomEvent<KeyCommandDetail>).detail));
    const unbind = bindKeyScope(root, { keymap: { j: "down", gg: "top", x: "refused" }, counts: true, onCommand: (command) => command !== "refused" });
    root.focus();
    const typed = (name: string) => {
      const event = key(name);
      root.dispatchEvent(event);
      return event;
    };
    const j = typed("j");
    typed("g");
    typed("g");
    typed("3");
    typed("j");
    typed("x");
    unbind();
    root.remove();
    expect(seen.map(({ keys, count }) => ({ keys, count }))).toEqual([
      { keys: "j", count: null },
      { keys: "gg", count: null },
      { keys: "j", count: 3 },
    ]);
    expect(seen[0]!.event).toBe(j);
    expect(j.defaultPrevented).toBe(true);
    expect(seen[0]!.plugin).toBeUndefined();
  });

  it("still reaches the window when the command removed the root it ran on", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<KeyCommandDetail>).detail.keys);
    window.addEventListener(KEY_COMMAND_EVENT, listen);
    const unbind = bindKeyScope(root, { keymap: { "<CR>": "submit" }, onCommand: () => root.remove() });
    root.focus();
    root.dispatchEvent(key("Enter"));
    unbind();
    window.removeEventListener(KEY_COMMAND_EVENT, listen);
    expect(seen).toEqual(["<CR>"]);
  });

  it("announces a command a plugin ran outside a key handler", () => {
    const seen: KeyCommandDetail[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<KeyCommandDetail>).detail);
    window.addEventListener(KEY_COMMAND_EVENT, listen);
    const event = key("o", { ctrlKey: true });
    announceKeyCommand(document, { keys: "<C-o>", count: null, event });
    window.removeEventListener(KEY_COMMAND_EVENT, listen);
    expect(seen).toEqual([{ keys: "<C-o>", count: null, event, plugin: undefined }]);
  });
});
