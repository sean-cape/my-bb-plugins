// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRailSlot, railItems, railSlotAvailable, railSlotLabel } from "./slots.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderRail() {
  document.body.innerHTML = `
    <nav data-testid="sidebar-navigation-rail">
      <div data-bb-plugin-root data-bb-plugin="navigation">
        <div data-testid="app-nav-rail">
          <div>
            <button id="home" aria-label="Home"></button>
            <span data-nav-rail-item="kanban/board"><button id="kanban"></button></span>
            <span data-nav-rail-item="__bb__/automations"><button id="automations" disabled></button></span>
            <span data-nav-rail-item="__bb__/extensions"><button id="plugins"></button></span>
            <button id="more"><svg data-icon="MoreHorizontal"></svg></button>
            <div data-bb-plugin-root data-bb-plugin="grouped-thread-list"><button id="inbox"></button></div>
          </div>
        </div>
      </div>
    </nav>
    <div data-sidebar="footer"><button id="settings"></button></div>`;
}

describe("rail slots", () => {
  it("numbers Home and the visible items, leaving out More, plugin buttons, and the footer", () => {
    renderRail();
    expect(railItems(document).map((button) => button.id)).toEqual([
      "home",
      "kanban",
      "automations",
      "plugins",
    ]);
  });

  it("presses the item at the digit and skips disabled ones without renumbering", () => {
    renderRail();
    const pressed = vi.fn();
    document.body.addEventListener("click", (event) => pressed((event.target as Element).id));
    expect([1, 2, 3, 4, 5].map((slot) => railSlotAvailable(document, slot))).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
    activateRailSlot(document, 4);
    activateRailSlot(document, 3);
    activateRailSlot(document, 5);
    expect(pressed.mock.calls).toEqual([["plugins"]]);
  });

  it("has nothing to press before the rail renders", () => {
    expect(railSlotAvailable(document, 1)).toBe(false);
    expect(() => activateRailSlot(document, 1)).not.toThrow();
  });

  it("labels the first nine items for the platform", () => {
    expect(railSlotLabel(0, "MacIntel")).toBe("⌘1");
    expect(railSlotLabel(8, "Win32")).toBe("Ctrl+9");
    expect(railSlotLabel(9, "MacIntel")).toBeNull();
  });
});
