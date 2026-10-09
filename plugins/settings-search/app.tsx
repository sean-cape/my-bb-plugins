import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "bb-motion/motion.css";
import { mountSettingsSearch } from "./search-bar.js";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "settings-search",
    mount: () => mountSettingsSearch(document, window),
  });
});
