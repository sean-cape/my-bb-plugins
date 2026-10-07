import { useEffect } from "react";
import { definePluginApp, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import "./app.css";
import { optionsFromSettings } from "./src/settings";
import { DEFAULT_OPTIONS, mountVimMode, type Reporter, type VimModeOptions } from "./src/vim/controller";

let options: VimModeOptions = DEFAULT_OPTIONS;
let sendReport: Reporter | null = null;
const REPORT_LIMIT = 30;
const REPORT_WINDOW_MS = 60_000;
let reportTimes: number[] = [];

// Rate-limited so a loop of failures cannot flood the server log.
const report: Reporter = (level, message) => {
  const now = Date.now();
  reportTimes = reportTimes.filter((time) => now - time < REPORT_WINDOW_MS);
  if (reportTimes.length >= REPORT_LIMIT) return;
  reportTimes.push(now);
  sendReport?.(level, message);
};

// Content scripts have no hook access, so this always-mounted overlay feeds
// live settings and the server log channel to the vim controller.
function SettingsBridge() {
  const { values, isLoading } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    sendReport = (level, message) => {
      rpc.call("report", { level, message: message.slice(0, 4000) }).catch(() => {});
    };
    return () => {
      sendReport = null;
    };
  }, [rpc]);
  useEffect(() => {
    if (!isLoading) options = optionsFromSettings(values);
  }, [values, isLoading]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "settings-bridge", component: SettingsBridge });
  app.contentScripts.register({
    id: "vim-mode",
    mount({ signal }) {
      const dispose = mountVimMode(() => options, report);
      signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    },
  });
});
