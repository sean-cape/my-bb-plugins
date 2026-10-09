import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Everything happens in the app window; bb requires a server entry anyway.
export default async function plugin(_bb: BbPluginApi) {}
