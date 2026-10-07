import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CaptureOverlay, captureText, openCaptureDialog, openToday, startRoutine } from "./ui/capture";
import { backlinksTab, filesTab, outlineTab } from "./ui/fixed-tabs";
import { PANEL_PATH } from "./ui/state";
import { VaultPage } from "./ui/VaultPage";
import "./ui/vault.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "vault",
    title: "Vault",
    icon: "./assets/icon.svg",
    path: PANEL_PATH,
    component: VaultPage,
    fixedTabs: [filesTab, outlineTab, backlinksTab],
  });
  app.slots.experimental_appOverlay({ id: "capture", component: CaptureOverlay });
  app.slots.messageAction({
    id: "save-to-daily",
    title: "Save to today's daily note",
    icon: "obsidian/vault",
    run: ({ message, selectedText, threadId }) => captureText(selectedText ?? message.text, threadId),
  });
  app.commands.register({
    id: "log-to-today",
    title: "Vault: Log to today's daily note",
    defaultShortcut: { key: "l", mod: true, shift: true },
    run: ({ threadId }) => openCaptureDialog({ threadId: threadId ?? undefined }),
  });
  app.commands.register({ id: "open-today", title: "Vault: Open today's daily note", run: () => openToday() });
  app.commands.register({ id: "start-day", title: "Vault: Start day (/daily-note start)", run: () => startRoutine("start") });
  app.commands.register({ id: "wrap-day", title: "Vault: Wrap up day (/daily-note wrap)", run: () => startRoutine("wrap") });
});
