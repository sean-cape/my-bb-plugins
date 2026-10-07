import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { INVALID_NAME_CHARS, NOTE_EXTENSION, basename, dirname, extension, joinPath, noteTitle } from "../shared/obsidian";
import {
  PANEL_PATH,
  errorMessage,
  flushOpenNotes,
  requestTitleFocus,
  useCurrentNotePath,
  useOpenNote,
  type useVault,
} from "./state";

export type Vault = ReturnType<typeof useVault>;

function uniquePath(existing: (path: string) => boolean, folder: string, stem: string, ext: string): string {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = joinPath(folder, `${stem}${attempt === 0 ? "" : ` ${attempt}`}${ext}`);
    if (!existing(candidate)) return candidate;
  }
}

/** File operations shared by the Vault page and the sidebar explorer. */
export function useVaultActions(vault: Vault) {
  const { rpc, tree, resolver, refreshTree } = vault;
  const navigate = useBbNavigate();
  const openNote = useOpenNote();
  const currentPath = useCurrentNotePath();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const exists = useCallback((path: string) => resolver.has(path), [resolver]);
  const folderExists = useCallback((path: string) => tree?.folders.includes(path) ?? false, [tree]);

  const createNote = useCallback(
    async (path: string, options: { focusTitle?: boolean } = {}) => {
      try {
        const result = await rpc.call("write", { path, content: "", expectedSha256: null });
        if (result.outcome === "conflict") toast.message(`${noteTitle(path)} already exists.`);
        await refreshTree();
        if (options.focusTitle) requestTitleFocus(path);
        openNote(path);
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [rpc, refreshTree, openNote],
  );

  const newNote = useCallback(
    (folder: string) => void createNote(uniquePath(exists, folder, "Untitled", NOTE_EXTENSION), { focusTitle: true }),
    [createNote, exists],
  );

  /** Creates an "Untitled" folder and returns its path so the caller can start renaming it. */
  const newFolder = useCallback(
    async (folder: string): Promise<string | null> => {
      const path = uniquePath((candidate) => folderExists(candidate) || exists(candidate), folder, "Untitled", "");
      try {
        await rpc.call("mkdir", { path });
        await refreshTree();
        return path;
      } catch (cause) {
        toast.error(errorMessage(cause));
        return null;
      }
    },
    [rpc, refreshTree, exists, folderExists],
  );

  const movePath = useCallback(
    async (from: string, to: string) => {
      try {
        await flushOpenNotes();
        const result = await rpc.call("move", { from, to, updateLinks: true });
        await refreshTree();
        const updated = result.updatedNotes.length;
        toast.success(updated === 0 ? `Moved to ${result.path}` : `Moved to ${result.path} and updated links in ${updated} note${updated === 1 ? "" : "s"}`);
        if (result.skippedNotes.length > 0) {
          const names = result.skippedNotes.slice(0, 5).map(noteTitle).join(", ");
          const more = result.skippedNotes.length > 5 ? ` and ${result.skippedNotes.length - 5} more` : "";
          toast.warning(`Links in ${names}${more} weren't updated because those notes changed or couldn't be read. Check them by hand.`);
        }
        if (currentPath !== null && (currentPath === from || currentPath.startsWith(from + "/"))) {
          openNote(result.path + currentPath.slice(from.length), { replace: true });
        }
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [rpc, refreshTree, currentPath, openNote],
  );

  const rename = useCallback(
    (path: string, newName: string) => {
      if (INVALID_NAME_CHARS.test(newName)) {
        toast.error('Names can\'t contain \\ / : * ? " < > | # ^ [ ]');
        return;
      }
      if (newName.startsWith(".")) {
        toast.error("Names can't start with a dot; Obsidian hides those files.");
        return;
      }
      const isFolder = folderExists(path);
      const ext = isFolder ? "" : extension(path);
      const name = isFolder || ext === "" || newName.toLowerCase().endsWith(`.${ext}`) ? newName : `${newName}.${ext}`;
      const to = joinPath(dirname(path), name);
      if (to === path) return;
      void movePath(path, to);
    },
    [folderExists, movePath],
  );

  const move = useCallback((path: string, toFolder: string) => void movePath(path, joinPath(toFolder, basename(path))), [movePath]);

  const confirmDelete = async () => {
    const path = pendingDelete;
    setPendingDelete(null);
    if (path === null) return;
    try {
      await flushOpenNotes();
      await rpc.call("trash", { path });
      await refreshTree();
      toast.success(`Moved ${basename(path)} to the vault's .trash folder`);
      if (currentPath !== null && (currentPath === path || currentPath.startsWith(path + "/"))) {
        navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  const deleteDialog = (
    <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pendingDelete === null ? "" : basename(pendingDelete)}?</AlertDialogTitle>
          <AlertDialogDescription>
            It moves to the vault's .trash folder, where Obsidian can restore it. Links to it are left as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    currentPath,
    exists,
    folderExists,
    createNote,
    newNote,
    newFolder,
    rename,
    move,
    requestDelete: setPendingDelete,
    deleteDialog,
  };
}

export type VaultActions = ReturnType<typeof useVaultActions>;
