import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { stepHistory } from "./history.js";
import { mountRailPills } from "./rail-pills.js";
import { announceShortcut } from "./shortcut.js";
import { activateRailSlot, RAIL_SLOT_COUNT, railSlotAvailable } from "./slots.js";
import { canReturnToThread, returnToThread, ThreadTrail } from "./thread-trail.js";

function announced<A extends unknown[]>(run: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    run(...args);
    announceShortcut(document, window.event);
  };
}

export default definePluginApp((app) => {
  app.commands.register({
    id: "history-back",
    title: "Go back",
    defaultShortcut: { key: "o", control: true },
    run: announced(() => stepHistory(document, window, "back")),
  });
  app.commands.register({
    id: "history-forward",
    title: "Go forward",
    defaultShortcut: { key: "i", control: true },
    run: announced(() => stepHistory(document, window, "forward")),
  });
  app.slots.experimental_appOverlay({ id: "thread-trail", component: ThreadTrail });
  // bb drops a plugin default on any key a built-in holds, even one scoped to splits: thread.jump.N (Mod+1–9) and
  // pane.focus.N (Mod+1–8) must be cleared in Settings → Keyboard before these bind.
  for (let slot = 1; slot <= RAIL_SLOT_COUNT; slot += 1) {
    app.commands.register({
      id: `rail-item-${slot}`,
      title: `Open sidebar item ${slot}`,
      defaultShortcut: { key: String(slot), mod: true },
      isAvailable: () => railSlotAvailable(document, slot),
      run: announced(() => activateRailSlot(document, slot)),
    });
  }
  app.commands.register({
    id: "return-to-thread",
    title: "Return to the last thread",
    defaultShortcut: { key: "0", mod: true },
    isAvailable: ({ threadId }) => canReturnToThread(threadId),
    run: announced(({ threadId }) => returnToThread(threadId)),
  });
  app.contentScripts.register({
    id: "rail-pills",
    mount: () => mountRailPills(document, window),
  });
});
