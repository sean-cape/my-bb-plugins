// bb-plugin-activity — frontend entry.
//
// A content script records clicks, keys, and pages across all of bb and
// posts them to the server in batches; the Activity page reads them back.
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import "bb-motion/motion.css";
import { useEffect } from "react";
import { mountCollector } from "./collector";
import type { ActivityEvent, rpcContract } from "./contract";
import { ActivityPage } from "./ui/ActivityPage";
import { PULSE_ICON, PulseIcon } from "./ui/icon";

let send: ((events: ActivityEvent[]) => Promise<void>) | null = null;

// Content scripts have no hook access, so this always-mounted overlay lends the collector its RPC channel.
function RpcBridge() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    send = async (events) => {
      await rpc.call("record", { events });
    };
    return () => {
      send = null;
    };
  }, [rpc]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: RpcBridge });
  app.contentScripts.register({
    id: "collector",
    mount() {
      // An agent's headless bb window (browser automation, UI tests) presses keys no one pressed.
      if (navigator.webdriver) return;
      const collector = mountCollector(document, window, {
        send: (events) => (send === null ? Promise.reject(new Error("The activity plugin's RPC bridge isn't mounted yet.")) : send(events)),
      });
      return () => collector.dispose();
    },
  });
  // bb's icon set has no pulse line, and an unknown name falls back to its generic bolt.
  app.experimental_icons.register({ name: PULSE_ICON, component: PulseIcon });
  app.slots.navPanel({ id: "activity", title: "Activity", icon: PULSE_ICON, path: "log", component: ActivityPage });
});
