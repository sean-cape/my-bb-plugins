import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { experimental_useAppPanel, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NOTE_EXTENSION, dirname, extension, isNotePath, joinPath, normalizePath, noteTitle, type LinkKind } from "../shared/obsidian";
import { dateKeyOfDailyPath } from "../shared/daily";
import { Dashboard } from "./Dashboard";
import { filesTab } from "./fixed-tabs";
import { NoteView, type ViewMode } from "./NoteView";
import {
  IMAGE_EXTENSIONS,
  decodeNotePath,
  errorMessage,
  requestNavigation,
  requestSearchFocus,
  setCurrentNotePath,
  targetFromSubpath,
  useLocalStorageState,
  useOpenNote,
  usePreviewBase,
  useSearchQuery,
  useTitleFocusPath,
  useVault,
  type VaultRpc,
} from "./state";
import { useVaultActions } from "./vault-actions";

const ATTACHMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf", "canvas", "base", "mp3", "m4a", "wav", "ogg", "mp4", "webm", "mov", "zip", "csv", "json"]);
const RECENT_LIMIT = 12;
function SetupScreen({ rpc, onConfigured }: { rpc: VaultRpc; onConfigured: () => void }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "" || pending) return;
    setPending(true);
    try {
      const result = await rpc.call("configure", { vaultPath: value.trim() });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.message !== null) toast.message(result.message);
      onConfigured();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <form onSubmit={submit} className="mx-auto mt-20 w-full max-w-lg space-y-3 px-4">
        <h2 className="text-lg font-semibold">Open an Obsidian vault</h2>
        <p className="text-sm text-muted-foreground">
          Enter the absolute path of your vault folder on the bb server machine. You can change it later in the plugin's settings.
        </p>
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="/Users/me/Documents/My Vault"
            aria-label="Vault folder"
            autoFocus
          />
          <Button type="submit" disabled={pending || value.trim() === ""}>
            Open
          </Button>
        </div>
        {message === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}

export function VaultPage({ subPath }: { subPath: string }) {
  const pluginId = experimental_usePluginId();
  const openNote = useOpenNote();
  const vault = useVault();
  const { rpc, status, tree, resolver, notePaths, error, refreshTree } = vault;
  const actions = useVaultActions(vault);
  const previewBase = usePreviewBase(rpc);
  const currentPath = subPath === "" ? null : decodeNotePath(subPath);
  const titleFocusPath = useTitleFocusPath();
  const [, setQuery] = useSearchQuery();

  const [mode, setMode] = useLocalStorageState<ViewMode>(`${pluginId}:mode`, "edit");
  const appPanel = experimental_useAppPanel();

  useEffect(() => {
    setCurrentNotePath(currentPath);
  }, [currentPath]);
  useEffect(() => () => setCurrentNotePath(null), []);

  /** Opens the Files tab in bb's right panel. */
  const showExplorer = useCallback(() => {
    appPanel.openFixedTab({ surface: { kind: "current" }, tab: filesTab });
  }, [appPanel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setMode((current) => (current === "edit" ? "read" : "edit"));
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        showExplorer();
        requestAnimationFrame(() => requestSearchFocus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setMode, showExplorer]);

  const { createNote, folderExists } = actions;

  const openLink = useCallback(
    (target: string, subpath: string | null, kind: LinkKind) => {
      if (currentPath === null) return;
      const navigationTarget = targetFromSubpath(subpath);
      if (target === "") {
        if (navigationTarget !== undefined) requestNavigation(currentPath, navigationTarget);
        return;
      }
      const resolved = resolver.resolve(target, currentPath, kind);
      if (resolved !== null) {
        openNote(resolved, { target: navigationTarget });
        return;
      }
      const base = kind === "markdown" ? normalizePath(joinPath(dirname(currentPath), target)) : normalizePath(target);
      if (base === null || base === "") return;
      // "Meeting 2024.01.05" is a note name, not a file with a ".05" extension.
      if (ATTACHMENT_EXTENSIONS.has(extension(base))) {
        toast.error(`${target} isn't in this vault.`);
        return;
      }
      const path = isNotePath(base) ? base : base + NOTE_EXTENSION;
      void createNote(path);
    },
    [currentPath, resolver, openNote, createNote],
  );

  const recent = useMemo(
    () => (tree === null ? [] : tree.files.filter((file) => isNotePath(file.path)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECENT_LIMIT)),
    [tree],
  );

  if (status === null) {
    return <p className="p-6 text-sm text-muted-foreground">{error ?? "Loading vault…"}</p>;
  }
  if (status.vaultPath === null) {
    return <SetupScreen rpc={rpc} onConfigured={() => void refreshTree()} />;
  }

  return (
    <div className="ob-vault">
      <main className="ob-main">
        {currentPath === null || folderExists(currentPath) ? (
          <Dashboard vault={vault} recent={recent} />
        ) : (
          <NoteView
            key={currentPath}
            path={currentPath}
            vaultPath={status.vaultPath}
            rpc={rpc}
            resolver={resolver}
            notePaths={notePaths}
            previewBase={previewBase}
            mode={mode}
            setMode={setMode}
            dailyKind={(() => {
              const key = dateKeyOfDailyPath(status.dailyFolder, currentPath);
              return key === null ? null : key === status.todayKey ? "today" : "past";
            })()}
            focusTitle={titleFocusPath === currentPath}
            onOpenLink={openLink}
            onTagClick={(tag) => {
              setQuery(`#${tag}`);
              showExplorer();
            }}
            onRename={actions.rename}
            onDelete={actions.requestDelete}
            onCreate={(path) => void createNote(path)}
          />
        )}
      </main>
      {actions.deleteDialog}
    </div>
  );
}
