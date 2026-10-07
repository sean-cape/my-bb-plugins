import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { SearchResults } from "../contract";
import { basename, dirname, isNotePath, noteTitle } from "../shared/obsidian";
import { CaptureInput } from "./capture";
import { FileTree, type FileTreeActions } from "./FileTree";
import {
  PANEL_PATH,
  errorMessage,
  useLocalStorageState,
  useOpenNote,
  useSearchFocusRequest,
  useSearchQuery,
  useVault,
} from "./state";
import { useVaultActions, type Vault, type VaultActions } from "./vault-actions";

const SEARCH_DEBOUNCE_MS = 200;

function SearchResultsList({
  query,
  results,
  onOpen,
}: {
  query: string;
  results: SearchResults | null;
  onOpen: (path: string, line?: number) => void;
}) {
  if (results === null) return <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>;
  if (results.results.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">No matches for “{query}”.</p>;
  return (
    <div className="ob-search-results">
      {results.results.map((result) => (
        <div key={result.path} className="ob-search-result">
          <button type="button" className="ob-search-file" onClick={() => onOpen(result.path)}>
            <span className="truncate font-medium">{isNotePath(result.path) ? noteTitle(result.path) : basename(result.path)}</span>
            {dirname(result.path) === "" ? null : <span className="truncate text-muted-foreground">{dirname(result.path)}</span>}
          </button>
          {result.matches.map((match) => (
            <button key={match.line} type="button" className="ob-search-match" onClick={() => onOpen(result.path, match.line)}>
              {match.text}
            </button>
          ))}
        </div>
      ))}
      {results.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">More results not shown; refine your search.</p> : null}
    </div>
  );
}

/** Vault header, search, capture box, and file tree. */
function VaultExplorer({ vault, actions }: { vault: Vault; actions: VaultActions }) {
  const pluginId = experimental_usePluginId();
  const openNote = useOpenNote();
  const { rpc, status, tree, error } = vault;
  const { currentPath, folderExists } = actions;
  const [expanded, setExpanded] = useLocalStorageState<string[]>(`${pluginId}:expanded`, []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [query, setQuery] = useSearchQuery();
  const [results, setResults] = useState<SearchResults | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusRequest = useSearchFocusRequest();
  const mountedFocusRequest = useRef(focusRequest);

  useEffect(() => {
    if (focusRequest === mountedFocusRequest.current) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    const trimmed = query.trim();
    setResults(null);
    if (trimmed === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("search", { query: trimmed }).then(
        (next) => !cancelled && setResults(next),
        (cause) => !cancelled && toast.error(errorMessage(cause)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, query]);

  const currentFolder = currentPath === null ? "" : folderExists(currentPath) ? currentPath : dirname(currentPath);

  const treeActions: FileTreeActions = useMemo(
    () => ({
      open: (path) => openNote(path),
      newNote: actions.newNote,
      newFolder: async (folder) => {
        const path = await actions.newFolder(folder);
        if (path === null) return;
        setExpanded((current) => [...new Set([...current, folder, path].filter(Boolean))]);
        setRenaming(path);
      },
      rename: actions.rename,
      remove: actions.requestDelete,
      move: actions.move,
    }),
    [openNote, actions, setExpanded],
  );

  return (
    <div className="ob-explorer">
      <div className="ob-sidebar-header">
        <span className="truncate text-sm font-semibold" title={status?.vaultPath ?? undefined}>
          {status?.vaultName ?? "Vault"}
        </span>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon" className="size-7" aria-label="New note" onClick={() => treeActions.newNote(currentFolder)}>
            <Icon name="EditFile" fallback="Plus" className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="New folder" onClick={() => void treeActions.newFolder(currentFolder)}>
            <Icon name="FolderPlus" className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Collapse all folders" onClick={() => setExpanded([])}>
            <Icon name="ChevronsUp" fallback="ChevronUp" className="size-4" />
          </Button>
        </div>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Icon name="Search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="Search vault"
            aria-label="Search vault"
            className="ob-search-input"
          />
        </div>
        <CaptureInput className="mt-1.5" />
      </div>
      <div className="ob-sidebar-body">
        {error !== null ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
        {query.trim() !== "" ? (
          <SearchResultsList
            query={query.trim()}
            results={results}
            onOpen={(path, line) => openNote(path, { target: line === undefined ? undefined : { line } })}
          />
        ) : tree === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading files…</p>
        ) : (
          <FileTree
            tree={tree}
            currentPath={currentPath}
            expanded={expanded}
            setExpanded={setExpanded}
            renaming={renaming}
            setRenaming={setRenaming}
            actions={treeActions}
          />
        )}
      </div>
      {actions.deleteDialog}
    </div>
  );
}

/** The Vault page's "Files" tab in bb's right panel. */
export function FilesPanel() {
  const vault = useVault();
  const actions = useVaultActions(vault);
  const navigate = useBbNavigate();
  if (vault.status !== null && vault.status.vaultPath === null) {
    return (
      <div className="p-3 text-sm">
        <p className="text-muted-foreground">No vault is open yet.</p>
        <Button size="sm" className="mt-2" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          Choose a vault
        </Button>
      </div>
    );
  }
  return <VaultExplorer vault={vault} actions={actions} />;
}
