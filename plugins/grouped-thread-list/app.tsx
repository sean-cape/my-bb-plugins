import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import "bb-motion/motion.css";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { useFollowNavigation } from "./app/model/use-follow-navigation.js";
import { ThreadIndicators } from "./app/indicators/ThreadIndicators.js";
import { ProjectPicker } from "./app/picker/ProjectPicker.js";
import {
  openProjectPicker,
  toggleProjectPicker,
  useToggleProjectPickerEvent,
} from "./app/picker/picker-store.js";
import { installUndoArchiveKey } from "./app/undo-archive.js";

// Owning the thread-list slot is what keeps bb's own list out of the sidebar;
// projects and threads live in the picker instead.
function SidebarThreadIndicators() {
  return (
    <>
      <PreferencesSync />
      <ThreadIndicators />
    </>
  );
}

function ProjectPickerOverlay() {
  useFollowNavigation();
  useToggleProjectPickerEvent();
  // The picker has no tooltips of its own; the provider stays because the
  // preview's ThreadChat is a host component rendered in this React root.
  return (
    <TooltipProvider>
      <PreferencesSync />
      <ProjectPicker />
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "thread-list",
    title: "Project switcher",
    description:
      "Leaves the sidebar free of projects and threads, apart from counts of threads that need you, are running, or are pinned; double Shift opens a keyboard-first project and thread picker.",
    component: SidebarThreadIndicators,
  });
  app.slots.experimental_appOverlay({
    id: "project-picker",
    component: ProjectPickerOverlay,
  });
  app.contentScripts.register({
    id: "undo-archive-key",
    mount: () => installUndoArchiveKey(document, window),
  });
  app.commands.register({
    id: "switch-project",
    title: "Switch project",
    run: () => toggleProjectPicker(),
  });
  app.commands.register({
    id: "show-unread-threads",
    title: "Show threads that need you",
    run: () => openProjectPicker({ entry: "unread", inThreads: true }),
  });
  app.commands.register({
    id: "show-recent-threads",
    title: "Show recently active threads",
    run: () => openProjectPicker({ entry: "recent", inThreads: true }),
  });
  app.commands.register({
    id: "show-pinned-threads",
    title: "Show pinned threads",
    run: () => openProjectPicker({ entry: "pinned", inThreads: true }),
  });
});
