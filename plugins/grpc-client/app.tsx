import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ClientView } from "./ui/ClientView";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "client",
    title: "gRPC",
    icon: "grpc-client/brand",
    path: "client",
    component: ClientView,
  });
  app.slots.threadPanelAction({
    id: "client",
    title: "gRPC",
    icon: "grpc-client/brand",
    layout: "flush",
    component: ClientView,
  });
});
