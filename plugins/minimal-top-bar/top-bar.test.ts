// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINIMAL_TOP_BAR_CSS,
  mountMinimalTopBar,
  TITLE_CLICK_DELAY_MS,
} from "./top-bar.js";

const nextFrame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mountMinimalTopBar", () => {
  it("hides the Commit button and removes everything it added on cleanup", async () => {
    document.body.innerHTML = `
      <div data-thread-header-workflow-actions>
        <div id="commit" data-thread-header-responsive-action><button>Commit</button></div>
        <div id="other" data-thread-header-responsive-action><button>Review</button></div>
      </div>`;
    const cleanup = mountMinimalTopBar(document, window);
    expect(document.querySelectorAll("style[data-minimal-top-bar]")).toHaveLength(
      1,
    );
    await nextFrame();
    const commit = document.getElementById("commit")!;
    expect(commit.hasAttribute("data-minimal-top-bar-hidden")).toBe(true);
    expect(
      document.getElementById("other")!.hasAttribute("data-minimal-top-bar-hidden"),
    ).toBe(false);

    cleanup();

    expect(document.querySelectorAll("style[data-minimal-top-bar]")).toHaveLength(
      0,
    );
    expect(commit.hasAttribute("data-minimal-top-bar-hidden")).toBe(false);
  });

  it("hides a Commit button that bb renders later", async () => {
    document.body.innerHTML = `<div id="actions" data-thread-header-workflow-actions></div>`;
    const cleanup = mountMinimalTopBar(document, window);
    await nextFrame();

    document.getElementById("actions")!.innerHTML =
      `<div id="commit" data-thread-header-responsive-action><button>Commit</button></div>`;
    await nextFrame();
    await nextFrame();

    expect(
      document.getElementById("commit")!.hasAttribute("data-minimal-top-bar-hidden"),
    ).toBe(true);
    cleanup();
  });

  it("hides bb's sidebar toggle", () => {
    document.body.innerHTML = `<button id="toggle" data-sidebar="trigger"></button><button id="back"></button>`;
    const cleanup = mountMinimalTopBar(document, window);
    expect(getComputedStyle(document.getElementById("toggle")!).display).toBe("none");
    expect(getComputedStyle(document.getElementById("back")!).display).not.toBe("none");
    cleanup();
  });

  it("collapses the sidebar to the rail whenever bb expands it", async () => {
    document.body.innerHTML = `
      <div id="sidebar" data-side="left" data-variant="sidebar" data-state="expanded" data-collapsible=""></div>
      <div id="drawer" data-sidebar="panel" data-side="left" data-variant="sidebar" data-state="expanded"></div>
      <button id="toggle" data-sidebar="trigger"></button>`;
    const sidebar = document.getElementById("sidebar")!;
    const toggle = document.getElementById("toggle")!;
    const presses = vi.fn(() => {
      const expanded = sidebar.dataset.state === "expanded";
      sidebar.dataset.state = expanded ? "collapsed" : "expanded";
      sidebar.dataset.collapsible = expanded ? "rail" : "";
    });
    toggle.addEventListener("click", presses);
    const cleanup = mountMinimalTopBar(document, window);
    await nextFrame();
    expect(presses).toHaveBeenCalledTimes(1);
    expect(sidebar.dataset.state).toBe("collapsed");

    await nextFrame();
    expect(presses).toHaveBeenCalledTimes(1);

    sidebar.dataset.state = "expanded";
    await nextFrame();
    await nextFrame();
    expect(presses).toHaveBeenCalledTimes(2);
    expect(sidebar.dataset.state).toBe("collapsed");
    cleanup();
  });

  it("waits to collapse the sidebar while something in it has focus, as bb's / gives its settings search", async () => {
    document.body.innerHTML = `
      <div id="sidebar" data-side="left" data-variant="sidebar" data-state="collapsed" data-collapsible="rail">
        <input id="search" aria-label="Search settings" />
      </div>
      <button id="toggle" data-sidebar="trigger"></button>`;
    const sidebar = document.getElementById("sidebar")!;
    const presses = vi.fn(() => {
      sidebar.dataset.state = "collapsed";
      sidebar.dataset.collapsible = "rail";
    });
    document.getElementById("toggle")!.addEventListener("click", presses);
    const cleanup = mountMinimalTopBar(document, window);
    await nextFrame();
    expect(presses).not.toHaveBeenCalled();

    const search = document.getElementById("search")!;
    sidebar.dataset.state = "expanded";
    sidebar.dataset.collapsible = "";
    search.focus();
    await nextFrame();
    await nextFrame();
    expect(presses).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);

    search.blur();
    await nextFrame();
    await nextFrame();
    expect(presses).toHaveBeenCalledTimes(1);
    expect(sidebar.dataset.state).toBe("collapsed");
    cleanup();
  });

  it("leaves the compact window's sidebar drawer alone", async () => {
    document.body.innerHTML = `
      <div data-sidebar="panel" data-side="left" data-variant="sidebar" data-state="expanded"></div>
      <button id="toggle" data-sidebar="trigger"></button>`;
    const presses = vi.fn();
    document.getElementById("toggle")!.addEventListener("click", presses);
    const cleanup = mountMinimalTopBar(document, window);
    await nextFrame();
    expect(presses).not.toHaveBeenCalled();
    cleanup();
  });

  it("shows a collapsed sidebar's page list on Settings, Plugins, and Skills but not elsewhere", () => {
    const sidebar = (page: string) => `
      <div id="${page}" data-side="left" data-collapsible="rail">
        <div data-testid="nav-rail-sidebar-body" style="visibility: hidden">
          <div data-testid="${page}-sidebar-body"></div>
        </div>
        <div data-testid="sidebar-footer-row">
          <div style="visibility: hidden"></div>
          <div style="visibility: hidden"></div>
        </div>
      </div>`;
    document.body.innerHTML = ["settings", "plugins", "skills", "app"].map(sidebar).join("");
    const cleanup = mountMinimalTopBar(document, window);
    const visibility = (page: string) => {
      const root = document.getElementById(page)!;
      const footer = root.querySelectorAll('[data-testid="sidebar-footer-row"] > div');
      return [root.querySelector('[data-testid="nav-rail-sidebar-body"]')!, ...footer].map(
        (element) => getComputedStyle(element).visibility,
      );
    };
    for (const page of ["settings", "plugins", "skills"]) {
      expect(visibility(page)).toEqual(["visible", "hidden", "visible"]);
    }
    expect(visibility("app")).toEqual(["hidden", "hidden", "hidden"]);
    cleanup();
  });

  it("shows the footer's icons above Settings while the sidebar is collapsed to the rail", () => {
    document.body.innerHTML = `
      <div data-side="left" data-collapsible="rail">
        <div data-testid="sidebar-footer-row">
          <div id="settings-cell"></div>
          <div id="footer-icons" data-sidebar="collapsible-body" style="visibility: hidden"></div>
        </div>
      </div>`;
    const cleanup = mountMinimalTopBar(document, window);
    expect(getComputedStyle(document.getElementById("footer-icons")!).visibility).toBe("visible");
    expect(
      getComputedStyle(document.querySelector('[data-testid="sidebar-footer-row"]')!).flexDirection,
    ).toBe("column-reverse");
    cleanup();
  });

  it("lifts bb's inert from the collapsed list and footer, again whenever bb sets it, and puts it back on cleanup", async () => {
    document.body.innerHTML = `
      <div data-side="left" data-collapsible="rail">
        <div id="list" data-testid="nav-rail-sidebar-body" inert></div>
        <div data-testid="sidebar-footer-row">
          <div id="settings-cell"></div>
          <div id="footer-icons" data-sidebar="collapsible-body" inert></div>
        </div>
      </div>
      <div data-side="right" data-collapsible="rail">
        <div id="other" data-testid="nav-rail-sidebar-body" inert></div>
      </div>`;
    const list = document.getElementById("list")!;
    const footer = document.getElementById("footer-icons")!;
    const cleanup = mountMinimalTopBar(document, window);
    await nextFrame();
    expect(list.hasAttribute("inert")).toBe(false);
    expect(footer.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("other")!.hasAttribute("inert")).toBe(true);

    footer.setAttribute("inert", "");
    await nextFrame();
    await nextFrame();
    expect(footer.hasAttribute("inert")).toBe(false);

    cleanup();
    expect(list.hasAttribute("inert")).toBe(true);
    expect(footer.hasAttribute("inert")).toBe(true);
  });

  it("applies at every window width", () => {
    // bb's compact layout brings back the ⋯ and close buttons, so the restyle can't be limited to wide windows.
    expect(MINIMAL_TOP_BAR_CSS).not.toContain("@media");
  });
});

describe("title menu", () => {
  function renderTitle() {
    document.body.innerHTML = `
      <div data-testid="app-page-header-content-row">
        <p><span class="bb-thread-title">A thread</span></p>
        <span><button aria-label="Thread actions"></button></span>
      </div>`;
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Thread actions"]')!;
    const opened = vi.fn(() => trigger.setAttribute("aria-expanded", "true"));
    const clicked = vi.fn();
    trigger.addEventListener("pointerdown", opened);
    trigger.addEventListener("click", clicked);
    return {
      title: document.querySelector<HTMLElement>(".bb-thread-title")!,
      trigger,
      opened,
      clicked,
    };
  }

  it("opens the thread menu on a single click of the title", () => {
    vi.useFakeTimers();
    const { title, opened } = renderTitle();
    const cleanup = mountMinimalTopBar(document, window);

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(opened).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(opened).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("doesn't also click a dropdown that opened on pointerdown", () => {
    vi.useFakeTimers();
    const { title, clicked } = renderTitle();
    const cleanup = mountMinimalTopBar(document, window);

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(clicked).not.toHaveBeenCalled();

    cleanup();
  });

  it("clicks the trigger when pointerdown doesn't open a menu, as bb's compact sheet needs", () => {
    vi.useFakeTimers();
    const { title, trigger, opened, clicked } = renderTitle();
    trigger.removeEventListener("pointerdown", opened);
    const cleanup = mountMinimalTopBar(document, window);

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(clicked).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("leaves a double-click to bb's rename", () => {
    vi.useFakeTimers();
    const { title, opened } = renderTitle();
    const cleanup = mountMinimalTopBar(document, window);

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(opened).not.toHaveBeenCalled();

    cleanup();
  });

  it("stays closed when bb's rename opens before the delay is up", () => {
    vi.useFakeTimers();
    const { title, opened } = renderTitle();
    const cleanup = mountMinimalTopBar(document, window);

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    title.closest("p")!.append(document.createElement("input"));
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(opened).not.toHaveBeenCalled();

    cleanup();
  });

  it("stops listening on cleanup", () => {
    vi.useFakeTimers();
    const { title, opened } = renderTitle();
    mountMinimalTopBar(document, window)();

    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    vi.advanceTimersByTime(TITLE_CLICK_DELAY_MS);
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("title press feedback", () => {
  it("eases only the title's transform, with bb-motion's tokens", () => {
    const rule = (selectorEnd: string) =>
      MINIMAL_TOP_BAR_CSS.match(
        new RegExp(`${selectorEnd.replace(/[.:]/g, "\\$&")} \\{([^}]*)\\}`),
      )?.[1];
    expect(rule(".bb-thread-title")).toContain(
      "transition: transform var(--bbm-duration-fast) var(--bbm-ease-out);",
    );
    expect(rule(".bb-thread-title:active")).toContain(
      "transform: scale(calc((1 + var(--bbm-scale-press)) / 2));",
    );
  });
});
