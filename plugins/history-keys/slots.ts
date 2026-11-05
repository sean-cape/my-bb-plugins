/** Mod+1 through Mod+9 open the rail's visible items in order. */
export const RAIL_SLOT_COUNT = 9;

// bb's rail markup has no plugin contract; a bb update that renames it just
// leaves the commands with nothing to press.
export const RAIL = '[data-testid="app-nav-rail"]';
const MORE_ICON = 'svg[data-icon="MoreHorizontal"]';
// Plugins that portal their own buttons into the rail, such as the Project
// switcher's thread indicators, aren't navigation items. bb renders the rail
// itself from a built-in plugin, so only roots inside the rail's own count.
const PLUGIN_ROOT = "[data-bb-plugin-root]";

/**
 * The rail's item buttons in order: Home and the visible navigation items,
 * without the More menu or plugin buttons. Hidden items live in More, so they
 * get no number.
 */
export function railItems(doc: Document): HTMLButtonElement[] {
  const rail = doc.querySelector(RAIL);
  if (rail === null) return [];
  const railRoot = rail.closest(PLUGIN_ROOT);
  return [...rail.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.querySelector(MORE_ICON) === null && button.closest(PLUGIN_ROOT) === railRoot,
  );
}

/** `slot` is 1-based, matching the digit pressed. */
export function railSlotAvailable(doc: Document, slot: number): boolean {
  const item = railItems(doc)[slot - 1];
  return item !== undefined && !item.disabled;
}

export function activateRailSlot(doc: Document, slot: number): void {
  const item = railItems(doc)[slot - 1];
  if (item !== undefined && !item.disabled) item.click();
}

/** The default binding's label; a user rebinding in Settings → Keyboard isn't visible to plugins. */
export function railSlotLabel(index: number, platform: string): string | null {
  if (index < 0 || index >= RAIL_SLOT_COUNT) return null;
  return isMac(platform) ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/iu.test(platform);
}
