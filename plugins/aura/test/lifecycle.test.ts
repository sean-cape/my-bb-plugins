import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountBackground, notifyChange, PANEL_TARGETS } from "../lib/background.ts";
import { defaults } from "../lib/model.ts";

test("applies scoped backgrounds, disables cleanly and ignores a late fetch after disposal", async () => {
  const dom = new JSDOM('<html><head></head><body><div id="thread-detail-timeline-panel"></div><div id="root-compose-main-panel"></div><aside>Sidebar</aside></body></html>', { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const dispose = mountBackground(controller.signal);
  try {
    assert.equal(document.querySelectorAll('style[data-aura]').length, 1);
    notifyChange({ settings: defaults, image: null, slots: [], activeSlot: null });
    assert.match(document.head.textContent!, /thread-detail-timeline-panel/);
    assert.ok(document.head.textContent!.includes(PANEL_TARGETS));
    assert.match(document.head.textContent!, /data-root-compose-mobile-recents.*letter-spacing:\.02em; text-transform:none/s);
    assert.match(document.head.textContent!, /data-root-compose-mobile-recents.*data-overflow-fade.*display:none/s);
    assert.match(document.head.textContent!, /:root:not\(\.dark\).*data-root-compose-mobile-recents.*background:color-mix\(in oklab,var\(--background\) 94%,transparent\)/s);
    assert.match(document.head.textContent!, /\.dark.*data-root-compose-mobile-recents.*background:color-mix\(in oklab,var\(--background\) 30%,transparent\)/s);
    assert.match(document.head.textContent!, /\.thread-scrollbar > div > \.mx-auto::before.*background-color:color-mix\(in oklab,var\(--background\) 75%,transparent\);\s*-webkit-backdrop-filter:blur\(12px\); backdrop-filter:blur\(12px\)/s);
    assert.match(document.head.textContent!, /\[data-scroll-footer\] > \.bg-background > \.mx-auto \{\s*max-width:max\(760px,60%\);/);
    assert.ok(!/\.mx-auto \{\s*background-color:var\(--background\)/.test(document.head.textContent!), "The reading column is smoky glass, not a solid paint");
    assert.ok(!document.head.textContent!.includes("aside"));
    assert.equal(document.querySelectorAll('.aura-capy-layer').length, 2);
    notifyChange({ settings: { ...defaults, newThreadOnly: true }, image: null, slots: [], activeSlot: null });
    assert.equal(document.querySelector('#thread-detail-timeline-panel .aura-capy-layer'), null);
    assert.equal(document.querySelectorAll('#root-compose-main-panel .aura-capy-layer').length, 1);
    assert.ok(!document.head.textContent!.includes('thread-detail-timeline-panel'));
    const pane = document.createElement('div'); pane.id = 'thread-detail-timeline-panel'; document.body.append(pane);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(pane.querySelector('.aura-capy-layer'), null);
    notifyChange({ settings: defaults, image: null, slots: [], activeSlot: null });
    assert.equal(document.querySelectorAll('.aura-capy-layer').length, 3);
    const photo = { version: "a".repeat(24), name: "wallpaper.png", mime: "image/png" as const, bytes: 100 };
    notifyChange({ settings: defaults, image: photo, slots: [], activeSlot: null });
    const reused = document.querySelector<HTMLElement>('#root-compose-main-panel')!;
    assert.ok(reused.querySelector('.aura-capy-ink[data-half-wallpaper]'));
    reused.id = 'thread-detail-timeline-panel';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reused.querySelector('.aura-capy-ink[data-half-wallpaper]'), null);
    reused.id = 'root-compose-main-panel';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(reused.querySelector('.aura-capy-ink[data-half-wallpaper]'), 'Reused New thread panels must regain their half-wallpaper fade');


    notifyChange({ settings: { ...defaults, enabled: false }, image: null, slots: [], activeSlot: null });
    assert.equal(document.head.textContent, "");
    controller.abort();
    dispose();
    assert.equal(document.querySelectorAll('style[data-aura]').length, 0);
    finish(new Response(JSON.stringify({ ok: true, result: { settings: defaults, image: null, slots: [], activeSlot: null } })));
    await new Promise(resolve => setTimeout(resolve, 0));
    notifyChange({ settings: defaults, image: null, slots: [], activeSlot: null });
    assert.equal(document.querySelectorAll('style[data-aura]').length, 0);
  } finally {
    dispose(); dom.window.close(); Object.assign(globalThis, saved);
  }
});

test("fills opted-in plugin surfaces with the full wallpaper, and leaves them out of New thread only", async () => {
  const dom = new JSDOM('<html><head></head><body><div id="root-compose-main-panel"></div></body></html>', { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  globalThis.fetch = () => new Promise(() => {});
  const controller = new AbortController();
  const dispose = mountBackground(controller.signal);
  try {
    const photo = { version: "b".repeat(24), name: "wallpaper.png", mime: "image/png" as const, bytes: 100 };
    notifyChange({ settings: defaults, image: photo, slots: [], activeSlot: null });
    const surface = document.createElement("div");
    document.body.append(surface);
    surface.setAttribute("data-aura-surface", "");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(surface.querySelectorAll(".aura-capy-layer").length, 1);
    assert.equal(surface.querySelector(".aura-capy-ink[data-half-wallpaper]"), null, "Surfaces get the full wallpaper, like conversations");
    assert.ok(!document.head.textContent!.includes("data-aura-surface"), "A surface positions itself; Aura must not override it");
    const added = document.createElement("section");
    added.innerHTML = '<div data-aura-surface=""></div>';
    document.body.append(added);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(added.querySelectorAll(".aura-capy-layer").length, 1);
    notifyChange({ settings: { ...defaults, newThreadOnly: true }, image: photo, slots: [], activeSlot: null });
    assert.equal(document.querySelectorAll("[data-aura-surface] .aura-capy-layer").length, 0);
    assert.equal(document.querySelectorAll("#root-compose-main-panel .aura-capy-layer").length, 1);
  } finally {
    dispose(); dom.window.close(); Object.assign(globalThis, saved);
  }
});
