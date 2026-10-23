// @vitest-environment jsdom
import { KEY_COMMAND_EVENT, type KeyCommandDetail } from "bb-vim-keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Collector, controlKey, controlLabel, describeControl, generalize, mountCollector, normalizeRoute, routePlugin } from "./collector";
import type { ActivityEvent } from "./contract";

let sent: ActivityEvent[][];
let collector: Collector | null = null;
let now = 1_000_000;
let route = "/threads/thr_abc123";

const mount = (overrides: Partial<Parameters<typeof mountCollector>[2]> = {}) => {
  collector = mountCollector(document, window, {
    send: async (events) => {
      sent.push(events);
    },
    now: () => now,
    route: () => route,
    flushMs: 60_000,
    ...overrides,
  });
  return collector;
};

const html = (markup: string) => {
  document.body.innerHTML = markup;
};

const click = (element: Element, detail = 1) => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail }));
};

const keydown = (target: Element | Document, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init });
  (target instanceof Document ? target.body : target).dispatchEvent(event);
  return event;
};

const announce = (on: Element, detail: Omit<KeyCommandDetail, "plugin"> & { plugin?: string }) => {
  on.dispatchEvent(new CustomEvent<KeyCommandDetail>(KEY_COMMAND_EVENT, { bubbles: true, composed: true, detail: { plugin: undefined, ...detail } }));
};

/** Everything buffered so far, without the route event the mount records. */
const recorded = async () => {
  await collector!.flush();
  return sent.flat().filter((event) => event.kind !== "route");
};

beforeEach(() => {
  sent = [];
  now = 1_000_000;
  route = "/threads/thr_abc123";
  vi.useFakeTimers();
});

afterEach(() => {
  collector?.dispose();
  collector = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("normalizeRoute", () => {
  it("blanks ids and file names and cuts deep paths", () => {
    expect(normalizeRoute("/threads/thr_abc123")).toBe("/threads/*");
    expect(normalizeRoute("/plugins/kanban/board/diff/a1b2c3d4e5")).toBe("/plugins/kanban/board/…");
    expect(normalizeRoute("/plugins/obsidian/vault/work/ideas.md")).toBe("/plugins/obsidian/vault/…");
    expect(normalizeRoute("/settings/keyboard")).toBe("/settings/keyboard");
    expect(normalizeRoute("/")).toBe("/");
    expect(routePlugin("/plugins/kanban/board")).toBe("kanban");
    expect(routePlugin("/threads/thr_1")).toBeNull();
  });
});

describe("control names", () => {
  it("names a button by its label, text, or image, and blanks numbers in the key", () => {
    html(`
      <div data-bb-plugin="kanban">
        <button id="a" aria-label="Refresh board">↻</button>
        <button id="b">3 open cards</button>
        <button id="c"><img alt="Settings"></button>
        <button id="d" data-testid="composer-send">Send</button>
        <button id="e">7d</button>
      </div>`);
    const by = (id: string) => document.getElementById(id)!;
    expect(describeControl(by("a"))).toEqual({ key: "Refresh board", label: "Refresh board" });
    expect(describeControl(by("b"))).toEqual({ key: "# open cards", label: "3 open cards" });
    expect(controlLabel(by("c"))).toBe("Settings");
    expect(controlKey(by("d"))).toBe("#composer-send");
    expect(describeControl(by("e"))).toEqual({ key: "7d", label: "7d" });
  });

  it("groups list rows by their list rather than their content, and links by their page, keeping no content in the label", () => {
    html(`
      <nav aria-label="Threads">
        <a id="t1" href="/threads/thr_1">Fix the login bug</a>
        <a id="t2" href="/threads/thr_2">Write the release notes</a>
      </nav>
      <section data-bb-plugin="kanban"><section>
        <h3>In review</h3>
        <ul><li><div id="card" data-nav-row="item" role="button">kanban: Submit review button</div></li></ul>
      </section></section>
      <div role="listbox" aria-label="Pick a model"><div id="opt" role="option">Opus 5.5</div></div>`);
    const by = (id: string) => document.getElementById(id)!;
    expect(describeControl(by("t1"))).toEqual({ key: "link /threads/*", label: "link /threads/*" });
    expect(controlKey(by("t1"))).toBe(controlKey(by("t2")));
    expect(describeControl(by("card"))).toEqual({ key: "item in In review", label: "item in In review" });
    expect(describeControl(by("opt"))).toEqual({ key: "option in Pick a model", label: "option in Pick a model" });
  });

  it("names the thing a control sits in from a marker or id attribute, not the card's own title", () => {
    html(`
      <div data-bb-plugin="kanban">
        <div data-kanban-card="" data-ticket-id="tk_1">
          <h2>Accept grants on contracts</h2>
          <ul><li><button id="cancel">Cancel</button></li></ul>
          <section data-thread-id="th_9">
            <button id="fold" aria-expanded="false"><span>outdated</span><span>GitHub</span><span>L20–28</span><span>1 reply</span></button>
          </section>
        </div>
        <div data-column-id="todo"><h3>Short title</h3><ul><li id="row">Write the release notes</li></ul></div>
      </div>`);
    const by = (id: string) => document.getElementById(id)!;
    expect(describeControl(by("cancel"))).toEqual({ key: "Cancel in kanban card", label: "Cancel in kanban card" });
    expect(describeControl(by("fold"))).toEqual({ key: "<button> in thread", label: "<button> in thread" });
    expect(describeControl(by("row"))).toEqual({ key: "li in column", label: "li in column" });
  });

  it("keys a draggable card by its own identity attribute, not its text", () => {
    html(`<div data-bb-plugin="kanban"><div data-kanban-column-list=""><div id="card" data-ticket-id="tk_2" role="button" draggable="true"><span>Kafka consistency fixes</span><span>PR #12</span></div></div></div>`);
    expect(describeControl(document.getElementById("card")!)).toEqual({ key: "ticket in kanban column list", label: "ticket in kanban column list" });
  });

  it("blanks file names and paths, and ignores headings that are dates or titles", () => {
    html(`
      <section data-bb-plugin="obsidian"><section>
        <h3>Thursday, October 22</h3>
        <ul><li id="meeting" data-nav-row="item">Roundtable for: Jordan</li></ul>
      </section></section>
      <div data-bb-plugin="kanban"><button id="viewed">Mark config.go as viewed</button></div>
      <button id="attachment">Screenshot-2026-10-22-at-11.25.37-AM-1792682744165-lre19h.png</button>
      <button id="path">Open src/ui/board.tsx</button>
      <a id="site" href="https://github.com">github.com</a>`);
    const by = (id: string) => document.getElementById(id)!;
    expect(controlKey(by("meeting"))).toBe("item in page");
    expect(describeControl(by("viewed"))).toEqual({ key: "Mark <file> as viewed", label: "Mark <file> as viewed" });
    expect(controlKey(by("attachment"))).toBe("<file>");
    expect(controlKey(by("path"))).toBe("Open <path>");
    expect(controlKey(by("site"))).toBe("external link");
    expect(generalize("github.com", true)).toBe("github.com");
  });

  it("treats a button whose text is longer than a name as content, grouped by where it sits", () => {
    html(`<section aria-label="Timeline"><button id="run">Ran bb activity recent --limit 90 --json 2>/dev/null | python3 -I -c "import json"</button></section>`);
    const run = document.getElementById("run")!;
    expect(describeControl(run)).toEqual({ key: "<button> in Timeline", label: "<button> in Timeline" });
  });

  it("names a control in the conversation only by its aria-label, never by the text or tooltip it shows or a message's headings", () => {
    html(`
      <div data-timeline-row-list="top-level">
        <div data-timeline-row-id="r1"><button id="tool">Ran make deploy</button><button id="copy" aria-label="Copy message">⧉</button></div>
        <section><h3>Root cause</h3><ul><li><button id="expand" aria-label="Expand">▸</button></li></ul></section>
      </div>
      <section data-testid="user-question-banner"><button id="tab" aria-pressed="true" title="Which cache should the widgets use?">Cache</button><fieldset><button id="answer" aria-pressed="false">Use the widget cache</button></fieldset></section>`);
    const by = (id: string) => document.getElementById(id)!;
    expect(controlKey(by("tool"))).toBe("<button> in timeline row");
    expect(controlKey(by("copy"))).toBe("Copy message in timeline row");
    expect(controlKey(by("expand"))).toBe("Expand");
    expect(controlKey(by("answer"))).toBe("<button> in user-question-banner");
    expect(controlKey(by("tab"))).toBe("<button> in user-question-banner");
  });

  it("names a container by its label up to a colon, past which it names what the region shows", () => {
    html(`<div aria-label="Browser preview controls: Acme dashboard"><button id="grow" aria-label="Expand browser preview">⤢</button></div>`);
    expect(controlKey(document.getElementById("grow")!)).toBe("Expand browser preview in Browser preview controls");
  });
});

describe("mountCollector", () => {
  it("records a click on the nearest control, attributed to its plugin and the page", async () => {
    html(`<div data-bb-plugin="kanban"><button aria-label="Refresh board"><svg id="icon"></svg></button></div><p id="prose">text</p>`);
    mount();
    route = "/plugins/kanban/board";
    click(document.getElementById("icon")!);
    click(document.getElementById("prose")!);
    const events = await recorded();
    expect(events).toEqual([{ at: now, kind: "click", plugin: "kanban", route: "/plugins/kanban/board", key: "Refresh board", label: "Refresh board", via: "pointer", count: null }]);
  });

  it("tells a keyboard-made click from a mouse one, and keeps the click rather than its Enter", async () => {
    html(`<button id="go">Go</button>`);
    mount();
    const button = document.getElementById("go")!;
    keydown(button, "Enter");
    click(button, 0);
    await vi.advanceTimersByTimeAsync(0);
    now += 10_000;
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    click(button, 0);
    const events = await recorded();
    expect(events.map((event) => [event.kind, event.key, event.via])).toEqual([
      ["click", "Go", "keyboard"],
      ["click", "Go", "pointer"],
    ]);
  });

  it("records Enter on a role=\"button\" element that opens on its own keydown as a keyboard click on it", async () => {
    html(`<div data-bb-plugin="kanban"><div data-kanban-column-list=""><div id="card" data-ticket-id="tk_2" role="button" tabindex="0">Widget fixes</div></div></div>`);
    mount();
    const card = document.getElementById("card")!;
    card.addEventListener("keydown", (event) => event.preventDefault());
    keydown(card, "Enter");
    await vi.advanceTimersByTimeAsync(0);
    const events = await recorded();
    expect(events.map((event) => [event.kind, event.key, event.via, event.plugin])).toEqual([["click", "ticket in kanban column list", "keyboard", "kanban"]]);
  });

  it("records keys outside text boxes, with ⌘ chords, and nothing typed into one", async () => {
    html(`<div data-bb-plugin="obsidian" id="root" tabindex="-1"></div><input id="box"><div contenteditable="true" id="editor"></div>`);
    mount();
    keydown(document.getElementById("root")!, "j");
    keydown(document, "k", { metaKey: true });
    keydown(document, "Shift", { shiftKey: true });
    keydown(document.getElementById("box")!, "j");
    keydown(document.getElementById("editor")!, "x");
    keydown(document, "j", { repeat: true });
    const events = await recorded();
    expect(events.map((event) => [event.kind, event.key, event.plugin])).toEqual([
      ["key", "j", "obsidian"],
      ["key", "<D-k>", null],
    ]);
  });

  it("forgets a key that a type-to-search box took, since it was text", async () => {
    html(`<input id="search" aria-label="Search settings">`);
    mount();
    const box = document.getElementById("search") as HTMLInputElement;
    // bb's settings page: a letter pressed on the page opens the search box with it.
    window.addEventListener("keydown", (event) => {
      if (event.key.length === 1) box.focus();
    });
    keydown(document, "t");
    await vi.advanceTimersByTimeAsync(0);
    keydown(box, "h");
    box.blur();
    keydown(document, "Escape");
    await vi.advanceTimersByTimeAsync(0);
    const events = await recorded();
    expect(events.map((event) => event.key)).toEqual(["<Esc>"]);
  });

  it("turns a key the library ran as a command into that command, folding in the keys the sequence took", async () => {
    html(`<div data-bb-plugin="grpc-client" id="root" tabindex="-1"></div>`);
    mount();
    const root = document.getElementById("root")!;
    const first = keydown(root, "g");
    const second = keydown(root, "g");
    announce(root, { keys: "gg", count: null, event: second, plugin: "grpc-client" });
    keydown(root, "3");
    const down = keydown(root, "j");
    announce(root, { keys: "j", count: 3, event: down });
    keydown(root, "x");
    const events = await recorded();
    expect(first).toBeDefined();
    expect(events.map((event) => [event.kind, event.key, event.count, event.plugin])).toEqual([
      ["command", "gg", null, "grpc-client"],
      ["command", "j", 3, "grpc-client"],
      ["key", "x", null, "grpc-client"],
    ]);
  });

  it("records a command whose keydown it never saw, from the announcement alone", async () => {
    html(`<div data-bb-plugin="prompt-keys" id="root"></div>`);
    mount();
    announce(document.getElementById("root")!, { keys: "y", count: null, event: new KeyboardEvent("keydown", { key: "y" }), plugin: "prompt-keys" });
    const events = await recorded();
    expect(events).toEqual([{ at: now, kind: "command", plugin: "prompt-keys", route: "/threads/*", key: "y", label: "y", via: null, count: null }]);
  });

  it("notes each page as it changes, once", async () => {
    mount();
    route = "/plugins/kanban/board";
    vi.advanceTimersByTime(1000);
    route = "/plugins/kanban/board/diff/abcdef1234";
    vi.advanceTimersByTime(1000);
    route = "/threads/thr_other";
    window.dispatchEvent(new PopStateEvent("popstate"));
    vi.advanceTimersByTime(1000);
    await collector!.flush();
    expect(sent.flat().map((event) => [event.kind, event.key, event.plugin])).toEqual([
      ["route", "/threads/*", null],
      ["route", "/plugins/kanban/board", "kanban"],
      ["route", "/plugins/kanban/board/…", "kanban"],
      ["route", "/threads/*", null],
    ]);
  });

  it("sends in batches on a timer, keeps a batch the server refused, and caps the buffer", async () => {
    html(`<button id="go">Go</button>`);
    let fail = true;
    const sends: number[] = [];
    mount({
      flushMs: 5000,
      maxBuffer: 3,
      send: async (events) => {
        sends.push(events.length);
        if (fail) throw new Error("down");
        sent.push(events);
      },
    });
    const button = document.getElementById("go")!;
    click(button);
    click(button);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends).toEqual([3]);
    expect(sent).toEqual([]);
    click(button);
    click(button);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends).toEqual([3, 3]);
    expect(sent.flat()).toHaveLength(3);
  });
});
