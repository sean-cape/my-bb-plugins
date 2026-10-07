import { FilesPanel } from "./Explorer";
import { BacklinksPanel, OutlinePanel } from "./Panels";

/** Right-panel tabs of the Vault page. The objects double as references for openFixedTab. */
export const filesTab = { panelId: "vault", id: "files", title: "Files", icon: "Folder", component: FilesPanel, layout: "flush" } as const;
export const outlineTab = { panelId: "vault", id: "outline", title: "Outline", icon: "ListView", component: OutlinePanel, layout: "flush" } as const;
export const backlinksTab = { panelId: "vault", id: "backlinks", title: "Backlinks", icon: "Link", component: BacklinksPanel, layout: "flush" } as const;
