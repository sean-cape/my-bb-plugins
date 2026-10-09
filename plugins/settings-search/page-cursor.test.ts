// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPageCursor, CURSOR_ATTRIBUTE, type PageCursor } from "./page-cursor.js";

const setting = (label: string, control: string) => `
  <div data-control-placement="inline">
    <div class="min-w-0 flex-1"><div><p class="text-sm">${label}</p></div></div>
    <div>${control}</div>
  </div>`;

const project = (name: string) => `
  <div class="flex items-center gap-2 project">
    <button aria-label="Reorder ${name}" aria-roledescription="sortable"></button>
    <a href="/settings/projects/${name}" aria-label="Open ${name} settings">${name}</a>
    <button aria-label="${name} actions"></button>
  </div>`;

function render(body: string) {
  window.history.replaceState(null, "", "/settings");
  document.body.innerHTML = `
    <div data-app-content-shell>
      <header><button aria-label="Header button"></button></header>
      <main><div data-page-scroll-viewport>${body}</div></main>
    </div>`;
}

const GENERAL = `
  ${setting("Navigate to threads", '<button role="switch" aria-label="Navigate to threads"></button>')}
  ${setting("New branch prefix", '<input aria-label="New branch prefix">')}
  ${setting("Followup", '<button aria-label="Followup">Steer</button>')}`;

const press = (key: string, init: KeyboardEventInit = {}) =>
  cursor.handleKey(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const marked = () => document.querySelector(`[${CURSOR_ATTRIBUTE}]`);
const markedLabel = () => marked()?.querySelector("p, a")?.textContent ?? null;

let cursor: PageCursor;
let stepPage: ReturnType<typeof vi.fn<(delta: number) => void>>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  stepPage = vi.fn<(delta: number) => void>();
  cursor = createPageCursor(document, window, { stepPage });
});

afterEach(() => {
  cursor.dispose();
  document.body.innerHTML = "";
});

describe("page cursor", () => {
  it("steps through the page's settings with j and k, stopping at the ends", () => {
    render(GENERAL);
    expect(marked()).toBeNull();
    expect(press("j")).toBe(true);
    expect(markedLabel()).toBe("Navigate to threads");
    press("j");
    press("j");
    press("j");
    expect(markedLabel()).toBe("Followup");
    press("k");
    expect(markedLabel()).toBe("New branch prefix");
    expect(marked()!.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("jumps to the first setting on gg and the last on G", () => {
    render(GENERAL);
    press("G");
    expect(markedLabel()).toBe("Followup");
    press("g");
    expect(markedLabel()).toBe("Followup");
    press("g");
    expect(markedLabel()).toBe("Navigate to threads");
  });

  it("leaves out the page header", () => {
    render(GENERAL);
    press("g");
    press("g");
    press("k");
    expect(markedLabel()).toBe("Navigate to threads");
  });

  it("starts from the bottom on k", () => {
    render(GENERAL);
    press("k");
    expect(markedLabel()).toBe("Followup");
  });

  it("treats a list row with several controls as one stop, and Enter opens its link", () => {
    render(project("alpha") + project("beta"));
    const opened = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('a[href="/settings/projects/beta"]')!.addEventListener("click", opened);
    press("j");
    press("j");
    expect(markedLabel()).toBe("beta");
    press("j");
    expect(markedLabel()).toBe("beta");
    press("Enter");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("flips a switch on Enter, edits a text field, and focuses a control on i", () => {
    render(GENERAL);
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const flipped = vi.fn();
    toggle.addEventListener("click", flipped);
    press("j");
    press("Enter");
    expect(flipped).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(toggle);

    press("i");
    expect(document.activeElement).toBe(toggle);

    press("j");
    expect(document.activeElement).not.toBe(toggle);
    press("Enter");
    expect(document.activeElement).toBe(document.querySelector("input"));
  });

  it("opens a menu from the keyboard, the way radix triggers expect", () => {
    render(setting("Followup", '<button aria-haspopup="menu" aria-label="Followup">Steer</button>'));
    const trigger = document.querySelector<HTMLButtonElement>("main button")!;
    const keys = vi.fn((event: KeyboardEvent) => event.key);
    const clicked = vi.fn();
    trigger.addEventListener("keydown", keys);
    trigger.addEventListener("click", clicked);
    press("j");
    press("Enter");
    expect(document.activeElement).toBe(trigger);
    expect(keys).toHaveReturnedWith("Enter");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("leaves a focused control on Escape, then hides the cursor", () => {
    render(GENERAL);
    press("j");
    press("i");
    expect(press("Enter")).toBe(false);
    expect(press("Escape")).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(marked()).not.toBeNull();
    press("Escape");
    expect(marked()).toBeNull();
    expect(press("Escape")).toBe(false);
  });

  it("asks for the previous or next page on h and l", () => {
    render(GENERAL);
    press("h");
    press("l");
    expect(stepPage.mock.calls).toEqual([[-1], [1]]);
  });

  it("takes Ctrl-D and Ctrl-U but no other Ctrl key", () => {
    render(GENERAL);
    expect(press("d", { ctrlKey: true })).toBe(true);
    expect(press("u", { ctrlKey: true })).toBe(true);
    expect(press("j", { ctrlKey: true })).toBe(false);
  });

  it("drops the cursor when the page changes", () => {
    render(GENERAL);
    press("j");
    window.history.pushState(null, "", "/settings/appearance");
    cursor.sync();
    expect(marked()).toBeNull();
  });

  it("keeps its place when bb re-renders the row under it", () => {
    render(GENERAL);
    press("j");
    press("j");
    document.querySelector("[data-page-scroll-viewport]")!.innerHTML = GENERAL;
    cursor.sync();
    expect(markedLabel()).toBe("New branch prefix");
  });

  it("follows a click once it is showing", () => {
    render(GENERAL);
    press("j");
    document.querySelector("input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(markedLabel()).toBe("New branch prefix");
  });
});
