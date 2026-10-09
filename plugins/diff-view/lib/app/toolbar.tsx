import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button, COMPACT } from "./ui/button";
import { cn } from "./utils";
import { PRESS } from "./ui/motion";
import { requestReload, setDiffPreferences, useDiffInstance, useDiffPreferences } from "./state";

/** Text or structural engine, and unified or split layout: preferences shared by every diff view. Long lines always wrap. */
export function DiffDisplayControls() {
  const preferences = useDiffPreferences();
  return (
    <>
      <div role="tablist" aria-label="Diff engine" className="flex rounded-md border border-border p-0.5">
        {(["text", "structural"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={preferences.mode === mode}
            title={mode === "structural" ? "Syntax-aware diff via difftastic" : "Line diff"}
            onClick={() => setDiffPreferences({ mode })}
            className={cn("rounded px-2 py-0.5 text-xs", PRESS, preferences.mode === mode ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {mode === "text" ? "Text" : "Structural"}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label="Diff layout" className={cn("flex rounded-md border border-border p-0.5", preferences.mode === "structural" && "hidden")}>
        {(["unified", "split"] as const).map((layout) => (
          <button
            key={layout}
            type="button"
            role="tab"
            aria-selected={preferences.layout === layout}
            onClick={() => setDiffPreferences({ layout })}
            className={cn("rounded px-2 py-0.5 text-xs", PRESS, preferences.layout === layout ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {layout === "unified" ? "Unified" : "Split"}
          </button>
        ))}
      </div>
    </>
  );
}

/** Refetches the diff of the view mounted with the same `instanceKey`, spinning while it loads. */
export function DiffRefreshButton({ instanceKey }: { instanceKey: string }) {
  const { loading } = useDiffInstance(instanceKey);
  return (
    <Button type="button" variant="ghost" className={cn(COMPACT, "px-1.5")} disabled={loading} onClick={() => requestReload(instanceKey)} aria-label="Refresh diff">
      <Icon name="diff-view-refresh" className={cn("size-3.5", loading && "animate-spin")} />
    </Button>
  );
}
