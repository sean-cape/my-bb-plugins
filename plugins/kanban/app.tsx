// bb-plugin-kanban — frontend entry.
//
// A kanban board page in the sidebar. Every card is a ticket; most tickets are
// backed by a thread, whose live status shows on the card. Cards drag between
// columns; the same moves are available to agents through `bb kanban move`.
import "bb-motion/motion.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerDiffViewIcons } from "bb-diff-view/app/icons";
import { TICKET_TAB } from "./ui/page-state";
import { withErrorBoundary } from "./ui/error-boundary";
import { TicketTab } from "./ui/ticket-details";
import { BoardPage } from "./ui/board-page";
import { BoardHeader } from "./ui/board-header";
import { LoopAlerts } from "./ui/loop-alerts";
import { OpenCardCount } from "./ui/open-card-count";
import { SettingsSection } from "./ui/settings-section";
import { PLUGIN_ICONS, pluginIcon } from "./ui/icons";

export default definePluginApp((app) => {
  registerDiffViewIcons(app);
  for (const [name, paths] of Object.entries(PLUGIN_ICONS)) {
    app.experimental_icons.register({ name, component: pluginIcon(paths) });
  }
  app.slots.navPanel({
    id: "board",
    title: "Kanban",
    icon: "kanban-board",
    path: "board",
    component: withErrorBoundary("board", BoardPage),
    headerContent: withErrorBoundary("header", BoardHeader),
    fixedTabs: [{ ...TICKET_TAB, title: "Card", icon: "PanelRight", component: withErrorBoundary("card panel", TicketTab), layout: "padded" }],
    experimental_sidebarAccessory: OpenCardCount,
  });
  app.slots.experimental_appOverlay({ id: "loop-alerts", component: LoopAlerts });
  app.slots.settingsSection({
    id: "github-sync",
    title: "GitHub sync",
    description: "Where PR cards come from and how the plugin authenticates.",
    component: withErrorBoundary("settings", SettingsSection),
  });
});
