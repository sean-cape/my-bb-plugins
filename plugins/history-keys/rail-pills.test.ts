// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELD_ATTRIBUTE, labelRail, mountRailPills, SLOT_ATTRIBUTE } from "./rail-pills.js";

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

beforeEach(() => {
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: "MacIntel" });
});

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const byId = (id: string) => document.getElementById(id)!;
const slot = (id: string) => byId(id).getAttribute(SLOT_ATTRIBUTE);
const held = () => byId("rail").hasAttribute(HELD_ATTRIBUTE);

function renderRail() {
  document.body.innerHTML = `
    <nav data-testid="sidebar-navigation-rail">
      <div data-bb-plugin-root data-bb-plugin="navigation">
        <div id="rail" data-testid="app-nav-rail">
          <div>
            <button id="home"></button>
            <span data-nav-rail-item="kanban/board"><button id="kanban"></button></span>
            <button id="more"><svg data-icon="MoreHorizontal"></svg></button>
          </div>
        </div>
      </div>
    </nav>`;
}

describe("labelRail", () => {
  it("numbers the rail's items, not More, and shows the numbers only while held", () => {
    renderRail();
    labelRail(document, "MacIntel", false);
    expect([slot("home"), slot("kanban"), slot("more")]).toEqual(["⌘1", "⌘2", null]);
    expect(held()).toBe(false);
    labelRail(document, "MacIntel", true);
    expect(held()).toBe(true);
  });

  it("renumbers when an item leaves the rail, and unnumbers it", () => {
    renderRail();
    labelRail(document, "MacIntel", false);
    document.body.append(byId("home"));
    labelRail(document, "MacIntel", false);
    expect(slot("kanban")).toBe("⌘1");
    expect(slot("home")).toBeNull();
  });
});

const press = (type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent(type, { key, ...init }));

describe("mountRailPills", () => {
  it("installs its stylesheet, numbers the rail, and removes everything on cleanup", async () => {
    renderRail();
    const cleanup = mountRailPills(document, window);
    expect(document.querySelectorAll("style[data-history-keys]")).toHaveLength(1);
    await nextFrame();
    expect(slot("kanban")).toBe("⌘2");

    press("keydown", "Meta", { metaKey: true });
    await nextFrame();
    cleanup();

    expect(document.querySelectorAll("style[data-history-keys]")).toHaveLength(0);
    expect(slot("kanban")).toBeNull();
    expect(held()).toBe(false);
  });

  it("shows the numbers while Cmd is held, through a Cmd+digit, until it is let go", async () => {
    renderRail();
    const cleanup = mountRailPills(document, window);
    press("keydown", "Meta", { metaKey: true });
    await nextFrame();
    expect(held()).toBe(true);
    press("keydown", "2", { metaKey: true });
    await nextFrame();
    expect(held()).toBe(true);
    press("keyup", "Meta");
    await nextFrame();
    expect(held()).toBe(false);
    cleanup();
  });

  it("hides the numbers for Cmd chords with other modifiers and when the window loses focus", async () => {
    renderRail();
    const cleanup = mountRailPills(document, window);
    press("keydown", "Meta", { metaKey: true, shiftKey: true });
    await nextFrame();
    expect(held()).toBe(false);
    press("keydown", "Meta", { metaKey: true });
    await nextFrame();
    window.dispatchEvent(new Event("blur"));
    await nextFrame();
    expect(held()).toBe(false);
    cleanup();
  });

  it("numbers items that render after it mounts", async () => {
    const cleanup = mountRailPills(document, window);
    renderRail();
    await nextFrame();
    await nextFrame();
    expect(slot("home")).toBe("⌘1");
    cleanup();
  });
});
