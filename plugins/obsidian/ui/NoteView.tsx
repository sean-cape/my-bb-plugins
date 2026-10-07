import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { dirname, extension, isNotePath, noteTitle, type LinkKind, type LinkResolver } from "../shared/obsidian";
import { mergeText } from "../shared/merge";
import { startRoutine } from "./capture";
import { Editor } from "./Editor";
import { Reader } from "./Reader";
import {
  IMAGE_EXTENSIONS,
  errorMessage,
  previewUrl,
  publishLiveDoc,
  registerNoteFlusher,
  useLiveDoc,
  useNavigationRequest,
  useVaultChanges,
  type VaultRpc,
} from "./state";

export type ViewMode = "edit" | "read";

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

interface NoteViewProps {
  path: string;
  vaultPath: string;
  rpc: VaultRpc;
  resolver: LinkResolver;
  notePaths: readonly string[];
  previewBase: string | null;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  /** Set when this note is a daily note; enables the Start / Wrap up routines. */
  dailyKind: "today" | "past" | null;
  focusTitle: boolean;
  onOpenLink: (target: string, subpath: string | null, kind: LinkKind) => void;
  onTagClick: (tag: string) => void;
  onRename: (path: string, newName: string) => void;
  onDelete: (path: string) => void;
  onCreate: (path: string) => void;
}

const AUTOSAVE_DELAY_MS = 700;

function readDraft(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, content: string): void {
  try {
    window.localStorage.setItem(key, content);
  } catch {
    // Storage full or disabled; nothing more can be done synchronously.
  }
}

function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore: the draft simply lingers until the next successful save.
  }
}

function obsidianUrl(vaultPath: string, path: string): string {
  return `obsidian://open?path=${encodeURIComponent(`${vaultPath.replace(/\/+$/, "")}/${path}`)}`;
}

function TitleInput({ path, focus, onRename }: { path: string; focus: boolean; onRename: (name: string) => void }) {
  const title = noteTitle(path);
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => setValue(title), [title]);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [focus, path]);
  const commit = () => {
    const next = value.trim();
    if (next === "" || next === title) {
      setValue(title);
      return;
    }
    onRename(next);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Note title"
      className="ob-title-input"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          ref.current?.blur();
        }
        if (event.key === "Escape") {
          setValue(title);
          requestAnimationFrame(() => ref.current?.blur());
        }
      }}
    />
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = { saved: "Saved", dirty: "Edited", saving: "Saving…", conflict: "Conflict", error: "Save failed" }[state];
  return (
    <span className={cn("ob-save-state", (state === "conflict" || state === "error") && "text-destructive")} aria-live="polite">
      {label}
    </span>
  );
}

export function NoteView(props: NoteViewProps) {
  const { path, rpc } = props;
  const isNote = isNotePath(path);
  const pluginId = experimental_usePluginId();
  const [doc, setDoc] = useState<{ content: string; version: number } | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [draft, setDraft] = useState<string | null>(null);
  const liveContent = useLiveDoc(path);
  const navigationRequest = useNavigationRequest(path);
  const draftKey = `${pluginId}:draft:${props.vaultPath}:${path}`;

  const baseSha = useRef<string | null>(null);
  const savedContent = useRef<string>("");
  const latest = useRef<string>("");
  const conflicted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = useRef(0);
  /** Saves run one at a time so each uses the sha its predecessor produced. */
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const savesPending = useRef(0);
  /** Bumped around every save so a read issued before one can be recognized as stale. */
  const generation = useRef(0);
  const recheckAfterSave = useRef(false);

  const isDirty = () => latest.current !== savedContent.current;

  const showDocument = useCallback(
    (content: string) => {
      versionRef.current += 1;
      setDoc({ content, version: versionRef.current });
      publishLiveDoc(path, content);
    },
    [path],
  );

  const adoptDisk = useCallback(
    (note: { content: string; sha256: string }) => {
      baseSha.current = note.sha256;
      savedContent.current = note.content;
      latest.current = note.content;
      conflicted.current = false;
      showDocument(note.content);
      setSaveState("saved");
    },
    [showDocument],
  );

  const load = useCallback(async () => {
    if (!isNote) return;
    generation.current += 1;
    const issued = generation.current;
    try {
      const note = await rpc.call("read", { path });
      if (issued !== generation.current) return;
      adoptDisk(note);
      setLoadError(null);
      const stored = readDraft(draftKey);
      if (stored !== null && stored !== note.content) setDraft(stored);
      else removeDraft(draftKey);
    } catch (cause) {
      const message = errorMessage(cause);
      setLoadError({ message, missing: /ENOENT|no such file|not exist/i.test(message) });
    }
  }, [rpc, path, isNote, adoptDisk, draftKey]);

  useEffect(() => {
    setDoc(null);
    setLoadError(null);
    void load();
  }, [load]);

  /**
   * Merges a disk change (a capture, an agent edit) into unsaved local edits.
   * The editor picks up the merged text, which schedules the next save.
   */
  const rebaseOnto = (note: { content: string; sha256: string }): boolean => {
    const merged = mergeText(latest.current, savedContent.current, note.content);
    if (merged === null) return false;
    baseSha.current = note.sha256;
    savedContent.current = note.content;
    showDocument(merged);
    latest.current = merged;
    return true;
  };

  const syncFromDisk = useCallback(async (): Promise<void> => {
    if (!isNote || conflicted.current) return;
    if (savesPending.current > 0) {
      recheckAfterSave.current = true;
      return;
    }
    const issued = generation.current;
    let note;
    try {
      note = await rpc.call("read", { path });
    } catch {
      return;
    }
    if (issued !== generation.current) {
      // A save ran while the read was in flight, so the response may predate it.
      void syncFromDisk();
      return;
    }
    if (note.sha256 === baseSha.current) return;
    if (note.content === latest.current) {
      baseSha.current = note.sha256;
      savedContent.current = note.content;
      setSaveState("saved");
    } else if (!isDirty()) {
      adoptDisk(note);
    } else if (!rebaseOnto(note)) {
      conflicted.current = true;
      setSaveState("conflict");
    }
  }, [rpc, path, isNote, adoptDisk]);

  const runSave = useCallback(async () => {
    const content = latest.current;
    if (conflicted.current || content === savedContent.current) {
      if (!conflicted.current) setSaveState("saved");
      return;
    }
    generation.current += 1;
    setSaveState("saving");
    try {
      const result = await rpc.call("write", { path, content, expectedSha256: baseSha.current });
      if (result.outcome === "written") {
        baseSha.current = result.sha256;
        savedContent.current = content;
        removeDraft(draftKey);
      } else {
        const disk = await rpc.call("read", { path }).catch(() => null);
        if (disk !== null && disk.content === content) {
          baseSha.current = disk.sha256;
          savedContent.current = content;
        } else if (disk === null || !rebaseOnto(disk)) {
          conflicted.current = true;
        }
      }
      setSaveState(conflicted.current ? "conflict" : isDirty() ? "dirty" : "saved");
    } catch (cause) {
      setSaveState("error");
      toast.error(`Couldn't save ${noteTitle(path)}: ${errorMessage(cause)}`);
    } finally {
      generation.current += 1;
    }
  }, [rpc, path, draftKey]);

  /** Saves pending edits now; resolves once every earlier save has finished too. */
  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    savesPending.current += 1;
    const next = saveChain.current.then(runSave).finally(() => {
      savesPending.current -= 1;
      if (savesPending.current === 0 && recheckAfterSave.current) {
        recheckAfterSave.current = false;
        void syncFromDisk();
      }
    });
    saveChain.current = next.catch(() => undefined);
    return next;
  }, [runSave, syncFromDisk]);

  useEffect(() => registerNoteFlusher(path, flush), [path, flush]);

  // Leaving the note saves what's pending. Edits that still can't be saved
  // (a conflict, or the window closing mid-save) are kept as a local draft.
  useEffect(() => {
    const keepDraft = () => {
      if (isNote && isDirty()) writeDraft(draftKey, latest.current);
    };
    window.addEventListener("pagehide", keepDraft);
    return () => {
      window.removeEventListener("pagehide", keepDraft);
      if (!isNote) return;
      keepDraft();
      void flush().then(() => {
        if (isDirty()) toast.error(`Couldn't save your last changes to ${noteTitle(path)}. They're kept as a draft; reopen the note to restore them.`);
        else removeDraft(draftKey);
      });
    };
  }, [isNote, flush, draftKey, path]);

  const onChange = useCallback(
    (content: string) => {
      latest.current = content;
      publishLiveDoc(path, content);
      if (conflicted.current) return;
      setSaveState("dirty");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [path, flush],
  );

  /** For edits made outside the editor (reading-view checkboxes, restoring a draft). */
  const onReaderChange = useCallback(
    (content: string) => {
      showDocument(content);
      onChange(content);
    },
    [showDocument, onChange],
  );

  useVaultChanges((payload) => {
    if (payload.paths.includes(path) || (payload.structural && payload.paths.length === 0)) void syncFromDisk();
  });

  const keepMine = async () => {
    const current = await rpc.call("read", { path }).catch(() => null);
    baseSha.current = current?.sha256 ?? null;
    savedContent.current = current?.content ?? "";
    conflicted.current = false;
    await flush();
  };

  const restoreDraft = () => {
    if (draft === null) return;
    setDraft(null);
    onReaderChange(draft);
  };

  const discardDraft = () => {
    setDraft(null);
    removeDraft(draftKey);
  };

  const header = (
    <div className="ob-note-header">
      <div className="min-w-0 flex-1">
        {dirname(path) === "" ? null : <div className="ob-breadcrumb">{dirname(path).split("/").join(" / ")}</div>}
        {isNote ? (
          <TitleInput path={path} focus={props.focusTitle} onRename={(name) => props.onRename(path, name)} />
        ) : (
          <div className="ob-title-input">{path.split("/").pop()}</div>
        )}
      </div>
      {isNote ? <SaveIndicator state={saveState} /> : null}
      {props.dailyKind === "today" ? (
        <>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void flush().then(() => startRoutine("start"))}>
            Start day
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void flush().then(() => startRoutine("wrap"))}>
            Wrap up
          </Button>
        </>
      ) : null}
      {isNote ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={props.mode === "edit" ? "Switch to reading view" : "Switch to editing view"}

          onClick={() => props.setMode(props.mode === "edit" ? "read" : "edit")}
        >
          <Icon name={props.mode === "edit" ? "Eye" : "Edit"} className="size-4" />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Note actions">
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={obsidianUrl(props.vaultPath, path)}>
              <Icon name="ExternalLink" aria-hidden />
              Open in Obsidian
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(path)}>
            <Icon name="Copy" aria-hidden />
            Copy vault path
          </DropdownMenuItem>
          {isNote ? (
            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(`[[${props.resolver.linkTextFor(path)}]]`)}>
              <Icon name="Link" aria-hidden />
              Copy wikilink
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => props.onDelete(path)}>
            <Icon name="Trash2" aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (!isNote) {
    const isImage = IMAGE_EXTENSIONS.has(extension(path));
    return (
      <div className="ob-note">
        {header}
        <div className="ob-note-body flex items-start justify-center overflow-auto p-6">
          {isImage && props.previewBase !== null ? (
            <img src={previewUrl(props.previewBase, path)} alt={path} className="max-w-full rounded-md" />
          ) : (
            <p className="text-sm text-muted-foreground">
              This file type can't be shown here.{" "}
              <a className="ob-link" href={obsidianUrl(props.vaultPath, path)}>
                Open it in Obsidian
              </a>
              .
            </p>
          )}
        </div>
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div className="ob-note">
        <div className="mx-auto mt-16 max-w-md space-y-3 px-4 text-center text-sm">
          {loadError.missing ? (
            <>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{noteTitle(path)}</span> doesn't exist yet.
              </p>
              <Button size="sm" onClick={() => props.onCreate(path)}>
                Create note
              </Button>
            </>
          ) : (
            <p className="text-destructive">{loadError.message}</p>
          )}
        </div>
      </div>
    );
  }

  if (doc === null) {
    return (
      <div className="ob-note">
        {header}
        <p className="p-6 text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="ob-note">
      {header}
      {draft !== null ? (
        <div role="alert" className="ob-conflict">
          <span>You have unsaved changes to this note from an earlier session. Restoring them replaces what's on disk now.</span>
          <Button size="sm" variant="outline" onClick={discardDraft}>
            Discard
          </Button>
          <Button size="sm" onClick={restoreDraft}>
            Restore my changes
          </Button>
        </div>
      ) : null}
      {saveState === "conflict" ? (
        <div role="alert" className="ob-conflict">
          <span>This note changed on disk while you were editing it.</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Load disk version
          </Button>
          <Button size="sm" onClick={() => void keepMine()}>
            Keep my version
          </Button>
        </div>
      ) : null}
      <div className={cn("ob-note-body", props.mode !== "edit" && "hidden")}>
        <Editor
          path={path}
          content={doc.content}
          version={doc.version}
          resolver={props.resolver}
          notePaths={props.notePaths}
          target={props.mode === "edit" ? navigationRequest : null}
          onChange={onChange}
          onOpenLink={(link) => props.onOpenLink(link.target, link.subpath, link.kind)}
        />
      </div>
      {props.mode === "read" ? (
        <div className="ob-note-body overflow-y-auto">
          <Reader
            path={path}
            content={liveContent ?? doc.content}
            resolver={props.resolver}
            rpc={rpc}
            previewBase={props.previewBase}
            target={navigationRequest}
            onOpenLink={(link) => props.onOpenLink(link.target, link.subpath, link.kind)}
            onTagClick={props.onTagClick}
            onChange={onReaderChange}
          />
        </div>
      ) : null}
    </div>
  );
}
