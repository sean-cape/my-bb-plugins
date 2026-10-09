// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "./app/model/fixtures.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./app/preferences/preferences-sync.js";
import {
  defaultPreferences,
  type PreferenceValues,
} from "./shared/preferences.js";

const app = await loadPluginApp(() => import("./app"));
const registration = app.threadLists[0];
if (!registration) throw new Error("thread-list slot not registered");

const PERSONAL_PROJECT_ID = "proj_personal";

const PROJECTS = [
  makePluginProject({
    id: PERSONAL_PROJECT_ID,
    name: "Personal",
    isPersonal: true,
  }),
  makePluginProject({ id: "proj_app", name: "App" }),
  makePluginProject({ id: "proj_web", name: "Web" }),
];

const SECTIONS = [
  { id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 },
  { id: "sec_review", name: "Review", createdAt: 2, updatedAt: 2 },
];

const THREADS = [
  makeSidebarThread({
    id: "thr_pinned",
    projectId: "proj_app",
    title: "Pinned thread",
    isPinned: true,
    pinnedAt: 10,
    pinSortKey: "a",
    createdAt: 10,
    updatedAt: 10,
    latestAttentionAt: 10,
    lastReadAt: 10,
  }),
  makeSidebarThread({
    id: "thr_parent",
    projectId: "proj_app",
    title: "Parent thread",
    createdAt: 8,
    updatedAt: 8,
    latestAttentionAt: 8,
    lastReadAt: 8,
  }),
  makeSidebarThread({
    id: "thr_child",
    projectId: "proj_app",
    title: "Child thread",
    parentThreadId: "thr_parent",
    createdAt: 7,
    updatedAt: 7,
    latestAttentionAt: 7,
    lastReadAt: 7,
  }),
  makeSidebarThread({
    id: "thr_later",
    projectId: "proj_web",
    title: "Later thread",
    sectionId: "sec_later",
    createdAt: 6,
    updatedAt: 6,
    latestAttentionAt: 6,
    lastReadAt: 6,
    host: { id: "host_laptop", name: "Laptop" },
    environment: {
      id: "env_web",
      name: null,
      branchName: "main",
      path: null,
      providerId: null,
      isWorktree: false,
      workspaceDisplayKind: "other",
    },
  }),
  makeSidebarThread({
    id: "thr_personal",
    projectId: PERSONAL_PROJECT_ID,
    title: "Personal thread",
    createdAt: 5,
    updatedAt: 5,
    latestAttentionAt: 5,
    lastReadAt: 5,
  }),
];

function props(): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: vi.fn(),
    searchQuery: "",
  };
}

function renderList(
  preferences: Partial<PreferenceValues>,
  options: RenderSlotOptions = {},
) {
  return renderSlot(registration, props(), {
    sidebarThreads: {
      projects: PROJECTS,
      sections: SECTIONS,
      threads: THREADS,
    },
    rpc: {
      listPreferences: () => ({
        preferences: { ...defaultPreferences(), ...preferences },
      }),
      setPreference: (input: unknown) => input,
    },
    ...options,
  });
}

function threadIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-sidebar-thread-id]"),
    (element) => element.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

const pickerRegistration = app.appOverlays.find(
  (overlay) => overlay.id === "project-picker",
);
if (!pickerRegistration) throw new Error("project picker not registered");

function webThread(overrides: Parameters<typeof makeSidebarThread>[0] = {}) {
  return makeSidebarThread({
    id: "thr_web_running",
    projectId: "proj_web",
    title: "Web running",
    status: "active",
    runtimeStatus: "active",
    createdAt: 4,
    updatedAt: 4,
    latestAttentionAt: 4,
    ...overrides,
  });
}

describe("sidebar thread list", () => {
  it("leaves the sidebar empty of projects and threads", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { container } = renderList({ activeProject: "proj_app" });
    await waitFor(() => expect(container.childElementCount).toBe(0));
    expect(threadIds()).toEqual([]);
  });

  it("keys its slot and preferences mirror by its own plugin id", async () => {
    window.localStorage.clear();
    expect(registration.id).toBe("thread-list");
    renderList({ activeProject: "proj_web" }, { pluginId: "thread-list" });
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("bb.thread-list.preferences.v1") ?? "{}",
        ).activeProject,
      ).toBe("proj_web"),
    );
    window.localStorage.clear();
  });
});

describe("active project", () => {
  function renderOverlay(
    preferences: Partial<PreferenceValues>,
    options: RenderSlotOptions = {},
  ) {
    return renderSlot(
      pickerRegistration!,
      {},
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: THREADS,
        },
        rpc: {
          listPreferences: () => ({
            preferences: { ...defaultPreferences(), ...preferences },
          }),
          setPreference: (input: unknown) => input,
        },
        ...options,
      },
    );
  }

  function activeProjectWrites(
    rpcCalls: { method: string; input?: unknown }[],
  ) {
    return rpcCalls
      .filter((call) => call.method === "setPreference")
      .map((call) => (call.input as { value: unknown }).value);
  }

  it("switches to the project of the thread you open", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderOverlay(
      { activeProject: "proj_app" },
      { context: { threadId: "thr_later" } },
    );
    await waitFor(() =>
      expect(activeProjectWrites(rpcCalls)).toEqual(["proj_web"]),
    );
  });

  it("leaves the active project alone for Personal threads", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderOverlay(
      { activeProject: "proj_app" },
      { context: { threadId: "thr_personal" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(activeProjectWrites(rpcCalls)).toEqual([]);
  });

  it("stores the most recently active project when none is set", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderOverlay({});
    await waitFor(() =>
      expect(activeProjectWrites(rpcCalls)).toEqual(["proj_app"]),
    );
  });

  it("does not overwrite a stored project that is missing from the list", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderOverlay({ activeProject: "proj_just_created" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(activeProjectWrites(rpcCalls)).toEqual([]);
  });
});

describe("project picker", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function renderPicker(options: RenderSlotOptions = {}) {
    return renderSlot(
      pickerRegistration!,
      {},
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: [...THREADS, webThread()],
        },
        rpc: {
          listPreferences: () => ({
            preferences: { ...defaultPreferences(), activeProject: "proj_app" },
          }),
          setPreference: (input: unknown) => input,
          inspectFolder: (input: unknown) => ({
            path: (input as { path: string }).path.replace(/^~/, "/Users/me"),
            isDirectory: true,
            projectId: null,
          }),
          openProjectFolder: () => ({ projectId: "proj_new", created: true }),
        },
        ...options,
      },
    );
  }

  function visibleText(element: Element): string {
    const visible = element.cloneNode(true) as HTMLElement;
    for (const hidden of visible.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
    return visible.textContent ?? "";
  }

  function leftLabels(): string[] {
    return within(screen.getByRole("listbox", { name: "Projects" }))
      .queryAllByRole("option")
      .map((option) => visibleText(option));
  }

  function selected(column: string | RegExp): string {
    const list = screen.getByRole("listbox", { name: column });
    const option = within(list)
      .getAllByRole("option")
      .find((entry) => entry.getAttribute("aria-selected") === "true");
    return option ? visibleText(option) : "";
  }

  async function openPicker() {
    const { toggleProjectPicker } = await import(
      "./app/picker/picker-store.js"
    );
    act(() => toggleProjectPicker());
    return screen.findByRole("dialog", { name: "Switch project" });
  }

  function press(target: Element, key: string, init: KeyboardEventInit = {}) {
    fireEvent.keyDown(target, { key, ...init });
  }

  /** The picker opens on Unread; App is the first project, one j below it. */
  async function openPickerOnApp() {
    const dialog = await openPicker();
    await waitFor(() => expect(leftLabels()).toContain("App"));
    expect(selected("Projects")).toBe("Unread");
    press(dialog, "j");
    expect(selected("Projects")).toBe("App");
    return dialog;
  }

  afterEach(async () => {
    const { closeProjectPicker } = await import("./app/picker/picker-store.js");
    act(() => closeProjectPicker());
  });

  it("lists Open folder, Unassociated, Pinned, and Unread above projects by recent activity", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker();
    const dialog = await openPicker();

    await waitFor(() =>
      expect(leftLabels()).toEqual([
        "Open folder…",
        "Unassociated",
        "Pinned",
        "Unread",
        "App",
        "Web",
      ]),
    );
    expect(selected("Projects")).toBe("Unread");
    press(dialog, "j");
    expect(
      within(screen.getByRole("listbox", { name: "App threads" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("data-picker-thread-id")),
    ).toEqual(["thr_pinned", "thr_parent", "thr_child"]);
  });

  it("toggles on the Double Shift plugin's window event and claims it", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker();
    const toggle = () =>
      window.dispatchEvent(
        new CustomEvent("bb-project-switcher:toggle", { cancelable: true }),
      );

    let delivered = true;
    act(() => {
      delivered = toggle();
    });
    expect(delivered).toBe(false);
    expect(
      await screen.findByRole("dialog", { name: "Switch project" }),
    ).not.toBeNull();
    act(() => {
      toggle();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores keys while closing and reopens fresh during the close animation", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();
    press(dialog, "/");
    const input = screen.getByRole("textbox", { name: "Filter projects" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "wb" } });
    press(input, "Enter");

    const { toggleProjectPicker } = await import(
      "./app/picker/picker-store.js"
    );
    act(() => toggleProjectPicker());
    expect(screen.queryByRole("dialog")).toBeNull();
    press(dialog, "Enter");
    expect(inspection.sidebarActionCalls).toEqual([]);

    await openPicker();
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Filter projects" })
        .value,
    ).toBe("");
    expect(selected("Projects")).toBe("Unread");
  });

  it("moves with j/k, switches columns with h/l, and opens a thread with Enter", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();

    press(dialog, "j");
    expect(selected("Projects")).toBe("Web");
    press(dialog, "k");
    press(dialog, "k");
    expect(selected("Projects")).toBe("Unread");
    press(dialog, "k");
    expect(selected("Projects")).toBe("Pinned");
    press(dialog, "k");
    expect(selected("Projects")).toBe("Unassociated");
    press(dialog, "g");
    press(dialog, "g");
    expect(selected("Projects")).toBe("Open folder…");
    press(dialog, "G");
    expect(selected("Projects")).toBe("Web");
    press(dialog, "l");
    expect(selected(/Web threads/)).toContain("Web running");
    press(dialog, "G");
    expect(selected(/Web threads/)).toContain("Later thread");
    press(dialog, "g");
    press(dialog, "g");
    expect(selected(/Web threads/)).toContain("Web running");
    press(dialog, "Enter");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_web_running",
    });
  });

  it("lists unread root threads across projects under Unread", async () => {
    setPreferencesMirrorStorageForTest(null);
    const unreadRoot = makeSidebarThread({
      id: "thr_unread",
      projectId: "proj_web",
      title: "Unread thread",
      createdAt: 3,
      updatedAt: 3,
      latestAttentionAt: 3,
      lastReadAt: 1,
    });
    const unreadChild = makeSidebarThread({
      id: "thr_unread_child",
      projectId: "proj_web",
      title: "Unread child",
      parentThreadId: "thr_unread",
      createdAt: 2,
      updatedAt: 2,
      latestAttentionAt: 2,
      lastReadAt: 1,
    });
    const { inspection } = renderPicker({
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: [...THREADS, webThread(), unreadRoot, unreadChild],
      },
    });
    const dialog = await openPicker();
    await waitFor(() => expect(selected("Projects")).toBe("Unread"));
    expect(
      within(screen.getByRole("listbox", { name: "Unread threads" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("data-picker-thread-id")),
    ).toEqual(["thr_unread"]);
    press(dialog, "l");
    press(dialog, "Enter");
    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_unread",
    });
  });

  it("previews the highlighted thread only while the threads column is focused", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker();
    const dialog = await openPickerOnApp();
    const preview = () =>
      document
        .querySelector('[aria-label="Thread preview"]')
        ?.getAttribute("data-picker-preview-thread-id") ?? null;

    expect(preview()).toBeNull();
    press(dialog, "l");
    await waitFor(() => expect(preview()).toBe("thr_pinned"));
    press(dialog, "j");
    await waitFor(() => expect(preview()).toBe("thr_parent"));
    press(dialog, "h");
    await waitFor(() => expect(preview()).toBeNull());
  });

  it("moves into the preview with l and scrolls it with vim keys", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker();
    const dialog = await openPickerOnApp();
    press(dialog, "l");
    const preview = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[aria-label="Thread preview"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
    preview.prepend(scroller);

    press(dialog, "l");
    press(dialog, "j");
    expect(scroller.scrollTop).toBe(40);
    fireEvent.scroll(scroller);
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        ),
    );
    expect(scroller.scrollTop).toBe(40);
    press(dialog, "d", { ctrlKey: true });
    expect(scroller.scrollTop).toBe(240);
    press(dialog, "k");
    expect(scroller.scrollTop).toBe(200);
    press(dialog, "G");
    expect(scroller.scrollTop).toBe(1600);
    press(dialog, "u", { ctrlKey: true });
    expect(scroller.scrollTop).toBe(1400);
    press(dialog, "g");
    press(dialog, "g");
    expect(scroller.scrollTop).toBe(0);
    expect(selected(/App threads/)).toContain("Pinned thread");

    press(dialog, "h");
    press(dialog, "j");
    expect(scroller.scrollTop).toBe(0);
    await waitFor(() =>
      expect(preview.getAttribute("data-picker-preview-thread-id")).toBe(
        "thr_parent",
      ),
    );
  });

  it("starts a new thread in the selected project with n", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();
    press(dialog, "s");
    expect(screen.getByRole("dialog")).not.toBeNull();
    press(dialog, "n");
    expect(inspection.sidebarActionCalls).toEqual([
      {
        method: "openNewThread",
        options: { projectId: "proj_app", focusPrompt: true },
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters projects by name with / and clears the filter on Escape", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();

    press(dialog, "/");
    const input = screen.getByRole("textbox", { name: "Filter projects" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "wb" } });
    expect(leftLabels()).toEqual(["Web"]);
    expect(selected("Projects")).toBe("Web");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(leftLabels()).toEqual([]);
    expect(screen.getByText("No matching projects or threads.")).not.toBeNull();
    fireEvent.change(input, { target: { value: "web" } });
    press(input, "Enter");
    expect(selected(/Web threads/)).toContain("Web running");
    press(dialog, "Enter");
    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_web_running",
    });

    const reopened = await openPicker();
    press(reopened, "/");
    const again = screen.getByRole("textbox", { name: "Filter projects" });
    fireEvent.focus(again);
    fireEvent.change(again, { target: { value: "ap" } });
    press(again, "Escape");
    expect(leftLabels()).toEqual(["App"]);
    press(reopened, "Escape");
    // Opening the Web thread made Web the current project, so it leads.
    expect(leftLabels()).toEqual([
      "Open folder…",
      "Unassociated",
      "Pinned",
      "Unread",
      "Web",
      "App",
    ]);
    press(reopened, "Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds threads by title across projects while filtering", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPicker();

    press(dialog, "/");
    const input = screen.getByRole("textbox", { name: "Filter projects" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "later" } });
    expect(leftLabels()).toEqual(["Matching “later”"]);
    press(input, "Enter");
    expect(selected(/Matching/)).toContain("Later thread");
    press(dialog, "Enter");
    expect(inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_later",
    });
  });

  it("marks where you are: the routed thread's project leads and is labelled current", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker({ context: { threadId: "thr_later", projectId: "proj_web" } });
    const dialog = await openPicker();
    await waitFor(() =>
      expect(leftLabels()).toEqual([
        "Open folder…",
        "Unassociated",
        "Pinned",
        "Unread",
        "Web",
        "App",
      ]),
    );
    const projects = screen.getByRole("listbox", { name: "Projects" });
    expect(
      within(projects)
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-current") === "location")
        .map((option) => visibleText(option)),
    ).toEqual(["Web"]);
    expect(
      screen.getByLabelText("Current location").textContent,
    ).toBe("WWebLater thread");

    press(dialog, "j");
    expect(selected("Projects")).toBe("Web");
    const routed = within(screen.getByRole("listbox", { name: "Web threads" }))
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-current") === "page")
      .map((option) => option.getAttribute("data-picker-thread-id"));
    expect(routed).toEqual(["thr_later"]);
  });

  it("marks Unassociated as current for a personal thread", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker({ context: { threadId: "thr_personal" } });
    await openPicker();
    await waitFor(() => expect(leftLabels()).toContain("App"));
    expect(
      within(screen.getByRole("listbox", { name: "Projects" }))
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-current") === "location")
        .map((option) => visibleText(option)),
    ).toEqual(["Unassociated"]);
  });

  it("pins and unpins the highlighted thread with p", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();

    press(dialog, "p");
    expect(inspection.sidebarActionCalls).toEqual([]);
    press(dialog, "l");
    press(dialog, "p");
    press(dialog, "j");
    press(dialog, "p");
    expect(inspection.sidebarActionCalls).toEqual([
      { method: "setPinned", threadId: "thr_pinned", pinned: false },
      { method: "setPinned", threadId: "thr_parent", pinned: true },
    ]);
  });

  it("marks the highlighted unread thread read with r", async () => {
    setPreferencesMirrorStorageForTest(null);
    const unreadRoot = makeSidebarThread({
      id: "thr_unread",
      projectId: "proj_web",
      title: "Unread thread",
      latestAttentionAt: 3,
      lastReadAt: 1,
    });
    const readRoot = makeSidebarThread({
      id: "thr_read",
      projectId: "proj_web",
      providerId: "claude-code",
      status: "active",
      title: "Running read thread",
      latestAttentionAt: 1,
      lastReadAt: 1,
    });
    const { inspection } = renderPicker({
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: [...THREADS, webThread(), unreadRoot, readRoot],
      },
    });
    const dialog = await openPicker();
    await waitFor(() => expect(selected("Projects")).toBe("Unread"));

    press(dialog, "r");
    expect(inspection.sidebarActionCalls).toEqual([]);
    press(dialog, "l");
    expect(
      within(screen.getByRole("listbox", { name: "Unread threads" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("data-picker-thread-id")),
    ).toEqual(["thr_unread", "thr_read"]);
    press(dialog, "j");
    press(dialog, "r");
    press(dialog, "k");
    press(dialog, "r");
    expect(inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "thr_unread", read: true },
    ]);
  });

  it("archives the highlighted thread with d", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();

    press(dialog, "d");
    expect(inspection.sidebarActionCalls).toEqual([]);
    press(dialog, "l");
    press(dialog, "j");
    press(dialog, "d");
    expect(inspection.sidebarActionCalls).toEqual([
      { method: "archive", threadId: "thr_parent" },
    ]);
  });

  it("sits beneath bb's dialogs and takes focus back when they close", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker();
    const dialog = await openPickerOnApp();
    const layer = dialog.parentElement!;
    expect(layer.className).toContain("z-[60]");

    const confirm = document.createElement("div");
    confirm.setAttribute("role", "dialog");
    confirm.setAttribute("data-bb-portaled-overlay", "");
    document.body.append(confirm);
    await waitFor(() => expect(layer.className).toContain("z-40"));
    (document.activeElement as HTMLElement | null)?.blur();

    confirm.remove();
    await waitFor(() => expect(layer.className).toContain("z-[60]"));
    expect(document.activeElement).toBe(dialog);
  });

  it("highlights the thread under the mouse so p pins it", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderPicker();
    const dialog = await openPickerOnApp();
    const child = screen
      .getAllByRole("option")
      .find(
        (option) =>
          option.getAttribute("data-picker-thread-id") === "thr_child",
      )!;
    fireEvent.mouseMove(child);
    press(dialog, "p");
    expect(inspection.sidebarActionCalls).toEqual([
      { method: "setPinned", threadId: "thr_child", pinned: true },
    ]);
  });

  it("opens a typed folder path as a new project", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderPicker();
    const dialog = await openPicker();

    press(dialog, "/");
    const input = screen.getByRole("textbox", { name: "Filter projects" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "~/dev/new-repo" } });
    expect(
      await screen.findByText("Enter adds it as a project"),
    ).not.toBeNull();
    press(input, "Enter");

    await waitFor(() =>
      expect(rpcCalls).toContainEqual(
        expect.objectContaining({
          method: "openProjectFolder",
          input: { path: "/Users/me/dev/new-repo" },
        }),
      ),
    );
    await waitFor(() =>
      expect(rpcCalls).toContainEqual(
        expect.objectContaining({
          method: "setPreference",
          input: { key: "activeProject", value: "proj_new" },
        }),
      ),
    );
  });

  it("starts on Unread and lands on the routed thread with l when it is unread", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderPicker({
      context: { threadId: "thr_unread_older" },
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: [
          ...THREADS,
          makeSidebarThread({
            id: "thr_unread_newer",
            projectId: "proj_web",
            title: "Newer unread",
            latestAttentionAt: 4,
            lastReadAt: 1,
          }),
          makeSidebarThread({
            id: "thr_unread_older",
            projectId: "proj_app",
            title: "Older unread",
            latestAttentionAt: 3,
            lastReadAt: 1,
          }),
        ],
      },
    });
    const dialog = await openPicker();
    await waitFor(() => expect(selected("Projects")).toBe("Unread"));
    expect(selected(/Unread threads/)).toBe("");
    press(dialog, "l");
    expect(selected(/Unread threads/)).toContain("Older unread");
    press(dialog, "h");
    press(dialog, "j");
    expect(selected("Projects")).toBe("App");
    expect(selected(/App threads/)).toBe("");
  });

  it("starts on Unread even when an active project is stored", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderSlot(
      pickerRegistration!,
      {},
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: THREADS,
        },
        rpc: {
          listPreferences: () => ({
            preferences: { ...defaultPreferences(), activeProject: "proj_app" },
          }),
          setPreference: (input: unknown) => input,
        },
        context: { threadId: "thr_personal" },
      },
    );
    await openPicker();
    await waitFor(() => expect(leftLabels()).toContain("App"));
    expect(selected("Projects")).toBe("Unread");
  });
});
