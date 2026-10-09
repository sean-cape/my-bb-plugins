import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "bb-motion/motion.css";
import { mountSlimSidebar } from "./layout.js";
import { SlimNavigation } from "./rail.js";
import { activateRailSlot, RAIL_SLOT_COUNT, railSlotAvailable } from "./slots.js";
import { canReturnToThread, returnToThread, ThreadTrail } from "./thread-trail.js";

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "slim-navigation",
    title: "Slim icon rail",
    description: "Icon-only navigation with tooltips, for the slim sidebar.",
    component: ({ isCompactViewport, experimental_Original: Original }) => (
      <>
        <ThreadTrail />
        {isCompactViewport ? <Original /> : <SlimNavigation />}
      </>
    ),
  });
  // bb drops a plugin default on any key a built-in holds, even one scoped to splits: thread.jump.N (Mod+1–9) and
  // pane.focus.N (Mod+1–8) must be cleared in Settings → Keyboard before these bind.
  for (let slot = 1; slot <= RAIL_SLOT_COUNT; slot += 1) {
    app.commands.register({
      id: `rail-item-${slot}`,
      title: `Open sidebar item ${slot}`,
      defaultShortcut: { key: String(slot), mod: true },
      isAvailable: () => railSlotAvailable(slot),
      run: () => activateRailSlot(slot),
    });
  }
  app.commands.register({
    id: "return-to-thread",
    title: "Return to the last thread",
    defaultShortcut: { key: "0", mod: true },
    isAvailable: ({ threadId }) => canReturnToThread(threadId),
    run: ({ threadId }) => returnToThread(threadId),
  });
  app.contentScripts.register({
    id: "slim-sidebar-layout",
    mount: () => mountSlimSidebar(document, window),
  });
});
