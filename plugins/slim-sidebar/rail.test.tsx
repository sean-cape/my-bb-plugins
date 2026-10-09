// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { activateRailSlot } from "./slots.js";

const app = await loadPluginApp(() => import("./app"));
const registration = app.experimentalSidebarNavigations[0];
if (!registration) throw new Error("sidebar navigation not registered");

function item(id: string, overrides: Partial<ExperimentalSidebarNavigationItem> = {}): ExperimentalSidebarNavigationItem {
  return {
    id,
    label: id,
    icon: { kind: "plugin", pluginId: "test", icon: null },
    action: { kind: "open-plugin-panel", pluginId: "test", panelId: id },
    isDisabled: false,
    isVisible: true,
    isLoading: false,
    pluginId: "test",
    shortcut: null,
    experimental_Accessory: null,
    ...overrides,
  };
}

const ITEMS = [
  item("__bb__/new-thread", { shortcut: { label: "⌘N", ariaKeyShortcuts: "Meta+N" } }),
  item("test/kanban"),
  item("test/hidden", { isVisible: false }),
];

let rendered: RenderedSlot | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function renderRail(isShortcutModifierHeld: boolean): RenderedSlot {
  rendered = renderSlot(
    registration!,
    { isCompactViewport: false, experimental_Original: () => null },
    { sidebarNavigation: { items: ITEMS, activeItemId: null, isShortcutModifierHeld } },
  );
  return rendered;
}

const pills = (slot: RenderedSlot) => [...slot.container.querySelectorAll("kbd[aria-hidden]")].map((kbd) => kbd.textContent);

describe("rail shortcut pills", () => {
  it("label each visible item with its number while the modifier is held", () => {
    expect(pills(renderRail(true))).toEqual([expect.stringMatching(/1$/u), expect.stringMatching(/2$/u)]);
  });

  it("stay hidden the rest of the time", () => {
    expect(pills(renderRail(false))).toEqual([]);
  });

  it("match the items the number keys open", () => {
    const slot = renderRail(false);
    act(() => activateRailSlot(2));
    expect(slot.inspection.sidebarNavigationCalls).toEqual([{ method: "activate", itemId: "test/kanban", openInSplit: false }]);
  });
});
