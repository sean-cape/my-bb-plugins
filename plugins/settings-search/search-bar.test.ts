// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageLoader } from "./crawler.js";
import { extractEntries, type SettingsPage } from "./settings-index.js";
import { mountSettingsSearch } from "./search-bar.js";

const row = (label: string, description = "") => `
  <div data-control-placement="inline">
    <div class="min-w-0 flex-1">
      <div><p class="text-sm">${label}</p></div>
      ${description ? `<p class="mt-0.5 text-xs">${description}</p>` : ""}
    </div>
    <div><button role="switch" aria-label="${label}"></button></div>
  </div>`;

const PAGES: Record<string, string> = {
  "/settings": `<h2>Git</h2>${row("New branch prefix", "Goes in front of every worktree branch.")}`,
  "/settings/appearance": `<h2>Appearance</h2>${row("Theme")}${row("Fade inactive splits")}`,
  "/settings/plugins/vim-mode": `<h2>Configuration</h2>${row("Start in insert mode", "Typing works as usual.")}`,
};

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
const flush = async () => {
  for (let i = 0; i < 4; i++) await nextFrame();
};

function renderSettings(path = "/settings", backTo = "/") {
  window.history.replaceState(null, "", path);
  document.body.innerHTML = `
    <div data-sidebar="sidebar">
      <div data-testid="settings-sidebar-top-reserve-row"></div>
      <div class="shrink-0 px-2 py-2"><div><a href="${backTo}">Back to app</a></div></div>
      <div class="flex-1 overflow-auto">
        <a href="/settings">General</a>
        <a href="/settings/appearance">Appearance</a>
        <a href="/settings/plugins/vim-mode">Vim Mode</a>
        <a href="/settings/archived">Archived threads</a>
      </div>
    </div>
    <main><div data-app-content-shell><main><div data-page-scroll-viewport>${PAGES[path]}</div></main></div></main>`;
  // Stands in for bb's router: a link swaps the page in place.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-sidebar] a")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const href = link.getAttribute("href")!;
      window.history.pushState(null, "", href);
      document.querySelector("[data-page-scroll-viewport]")!.innerHTML = PAGES[href] ?? "";
    });
  }
}

function fakeLoader() {
  const loaded: string[] = [];
  const dispose = vi.fn();
  const load: PageLoader = async (page: SettingsPage) => {
    loaded.push(page.href);
    const viewport = document.createElement("div");
    viewport.innerHTML = PAGES[page.href] ?? "";
    return extractEntries(viewport, page);
  };
  return { loaded, dispose, createLoader: () => ({ load, dispose }) };
}

const input = () => document.querySelector<HTMLInputElement>("[data-settings-search] input")!;
const options = () => [...document.querySelectorAll<HTMLElement>("[data-settings-search-results] [role=option]")];
const labels = () => options().map((option) => option.querySelector("[data-label]")!.textContent);
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

let cleanup: (() => void) | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(path = "/settings") {
  renderSettings(path);
  const loader = fakeLoader();
  cleanup = mountSettingsSearch(document, window, { createLoader: loader.createLoader });
  await flush();
  return loader;
}

describe("mountSettingsSearch", () => {
  it("does nothing inside the indexing iframe", () => {
    const framed = { top: {} } as unknown as Window;
    mountSettingsSearch(document, framed)();
    expect(document.querySelector("style[data-settings-search-style]")).toBeNull();
  });

  it("puts the search bar under Back to app and indexes every other settings page", async () => {
    const loader = await mount();
    const back = document.querySelector('a[href="/"]')!.closest("[data-sidebar] > div")!;
    expect(back.nextElementSibling?.hasAttribute("data-settings-search")).toBe(true);
    expect(input().hasAttribute("data-vim-ignore")).toBe(true);
    expect(loader.loaded).toEqual(["/settings/appearance", "/settings/plugins/vim-mode"]);
    expect(loader.dispose).toHaveBeenCalled();
  });

  it("finds its place when settings were opened from a thread", async () => {
    renderSettings("/settings", "/projects/proj_a/threads/thr_b");
    cleanup = mountSettingsSearch(document, window, { createLoader: fakeLoader().createLoader });
    await flush();
    expect(document.querySelector("[data-settings-search] input")).not.toBeNull();
  });

  it("swaps the page list for results from every page while there is a query", async () => {
    await mount();
    const sidebar = document.querySelector("[data-sidebar]")!;
    type("insert");
    expect(labels()).toEqual(["Start in insert mode"]);
    expect(sidebar.hasAttribute("data-settings-search-active")).toBe(true);
    expect(options()[0]!.querySelector("[data-where]")!.textContent).toBe("Vim Mode › Configuration");
    expect(options()[0]!.querySelector("mark")!.textContent).toBe("insert");

    type("worktree");
    expect(labels()).toEqual(["New branch prefix"]);

    type("");
    expect(sidebar.hasAttribute("data-settings-search-active")).toBe(false);
  });

  it("opens a result on another page, rings its row, and focuses its control", async () => {
    await mount();
    type("fade");
    press(input(), "Enter");
    await flush();

    expect(window.location.pathname).toBe("/settings/appearance");
    const target = [...document.querySelectorAll("[data-control-placement]")].find((element) =>
      element.textContent!.includes("Fade inactive splits"),
    )!;
    expect(target.hasAttribute("data-settings-search-hit")).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(target.querySelector("button"));
  });

  it("moves through results with the arrows and Ctrl-N/P, wrapping at the ends", async () => {
    await mount();
    type("e");
    const selected = () => options().findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    press(input(), "ArrowDown");
    expect(selected()).toBe(1);
    press(input(), "n", { ctrlKey: true });
    expect(selected()).toBe(2);
    press(input(), "p", { ctrlKey: true });
    press(input(), "ArrowUp");
    press(input(), "ArrowUp");
    expect(selected()).toBe(options().length - 1);
  });

  it("clears on the first Escape and leaves the box on the second", async () => {
    await mount();
    input().focus();
    type("theme");
    press(input(), "Escape");
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(input());
    press(input(), "Escape");
    expect(document.activeElement).not.toBe(input());
  });

  it("focuses the search on /, but not while typing elsewhere", async () => {
    await mount();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    press(other, "/");
    expect(document.activeElement).toBe(other);

    other.blur();
    press(document.body, "/");
    expect(document.activeElement).toBe(input());
  });

  it("steps through results with n and N once focus has left the box", async () => {
    await mount();
    type("in");
    expect(labels()).toEqual(["Fade inactive splits", "Start in insert mode", "New branch prefix"]);
    press(input(), "Enter");
    await flush();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fade inactive splits");

    press(document.activeElement!, "n");
    await flush();
    expect(window.location.pathname).toBe("/settings/plugins/vim-mode");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Start in insert mode");

    press(document.activeElement!, "N");
    await flush();
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fade inactive splits");
  });

  it("walks the page list with j and k until l moves into the page's settings", async () => {
    await mount();
    const cursorText = () => document.querySelector("[data-settings-search-cursor]")?.textContent ?? null;
    press(document.body, "j");
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(cursorText()).toBe("Appearance");
    press(document.body, "j");
    expect(window.location.pathname).toBe("/settings/plugins/vim-mode");
    press(document.body, "k");
    expect(window.location.pathname).toBe("/settings/appearance");

    press(document.body, "l");
    expect(cursorText()).toContain("Theme");
    press(document.body, "j");
    expect(cursorText()).toContain("Fade inactive splits");
    expect(window.location.pathname).toBe("/settings/appearance");

    press(document.body, "h");
    expect(cursorText()).toBe("Appearance");
    press(document.body, "l");
    expect(cursorText()).toContain("Fade inactive splits");
  });

  it("jumps to the first or last page on gg and G", async () => {
    await mount("/settings/appearance");
    press(document.body, "G");
    expect(window.location.pathname).toBe("/settings/archived");
    press(document.body, "g");
    press(document.body, "g");
    expect(window.location.pathname).toBe("/settings");
  });

  it("leaves a text box on the page on Escape, even one vim-mode marked handled", async () => {
    await mount();
    const field = document.createElement("input");
    document.querySelector("[data-page-scroll-viewport]")!.append(field);
    field.focus();
    field.addEventListener("keydown", (event) => event.preventDefault());
    press(field, "Escape");
    expect(document.activeElement).not.toBe(field);
  });

  it("leaves the keys to an open menu or dialog", async () => {
    await mount();
    document.body.insertAdjacentHTML("beforeend", '<div role="menu"><div role="menuitem" tabindex="0"></div></div>');
    press(document.querySelector('[role="menuitem"]')!, "j");
    expect(document.querySelector("[data-settings-search-cursor]")).toBeNull();
  });

  it("puts the page cursor on a setting opened from the search", async () => {
    await mount();
    type("fade");
    press(input(), "Enter");
    await flush();
    expect(document.querySelector("[data-settings-search-cursor]")!.textContent).toContain("Fade inactive splits");
    // The search left the keys with the page's settings, not the page list.
    press(document.activeElement!, "k");
    expect(document.querySelector("[data-settings-search-cursor]")!.textContent).toContain("Theme");
  });

  it("lists its keys on ?", async () => {
    await mount();
    press(document.body, "?");
    expect(document.querySelector("[data-settings-search] [data-keys]")!.textContent).toContain("Search settings");
    press(document.body, "?");
    expect(document.querySelector("[data-settings-search] [data-keys]")).toBeNull();
  });

  it("goes away with the settings sidebar and comes back with it", async () => {
    await mount();
    document.querySelector("[data-sidebar]")!.remove();
    await flush();
    expect(document.querySelector("[data-settings-search]")).toBeNull();

    renderSettings();
    await flush();
    expect(document.querySelector("[data-settings-search]")).not.toBeNull();
  });

  it("removes everything it added on cleanup", async () => {
    await mount();
    type("theme");
    cleanup!();
    cleanup = null;
    expect(document.querySelector("[data-settings-search], [data-settings-search-results]")).toBeNull();
    expect(document.querySelector("[data-settings-search-active], [data-settings-search-nav]")).toBeNull();
    expect(document.querySelector("style[data-settings-search-style]")).toBeNull();
  });
});
