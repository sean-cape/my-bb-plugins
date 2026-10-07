import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Backlinks } from "../contract";
import type { rpcContract } from "../server";
import { dirname, isNotePath, noteTitle, parseHeadings } from "../shared/obsidian";
import { decodeNotePath, errorMessage, requestNavigation, useLiveDoc, useOpenNote, useVaultChanges } from "./state";

function useCurrentNote(subPath: string): string | null {
  const path = subPath === "" ? null : decodeNotePath(subPath);
  return path !== null && isNotePath(path) ? path : null;
}

function PanelMessage({ children }: { children: string }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

export function OutlinePanel({ subPath }: { subPath: string }) {
  const path = useCurrentNote(subPath);
  const content = useLiveDoc(path);
  const headings = useMemo(() => (content === null ? [] : parseHeadings(content)), [content]);
  if (path === null) return <PanelMessage>Open a note to see its outline.</PanelMessage>;
  if (headings.length === 0) return <PanelMessage>No headings in this note.</PanelMessage>;
  const minLevel = Math.min(...headings.map((heading) => heading.level));
  return (
    <nav aria-label="Outline" className="ob-panel-list">
      {headings.map((heading) => (
        <button
          key={`${heading.line}`}
          type="button"
          className="ob-outline-item"
          style={{ paddingLeft: `${0.75 + (heading.level - minLevel) * 0.85}rem` }}
          onClick={() => requestNavigation(path, { line: heading.line })}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  );
}

export function BacklinksPanel({ subPath }: { subPath: string }) {
  const path = useCurrentNote(subPath);
  const rpc = useRpc<typeof rpcContract>();
  const openNote = useOpenNote();
  const [data, setData] = useState<Backlinks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (path === null) return;
    rpc.call("backlinks", { path }).then(
      (next) => {
        setData(next);
        setError(null);
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc, path]);

  useEffect(() => {
    setData(null);
    refresh();
  }, [refresh]);
  useVaultChanges(() => refresh());

  if (path === null) return <PanelMessage>Open a note to see what links to it.</PanelMessage>;
  if (error !== null) return <PanelMessage>{error}</PanelMessage>;
  if (data === null) return <PanelMessage>Loading…</PanelMessage>;
  if (data.backlinks.length === 0) return <PanelMessage>{`No notes link to ${noteTitle(path)}.`}</PanelMessage>;
  return (
    <div className="ob-panel-list">
      <p className="px-3 pb-1 pt-3 text-xs text-muted-foreground">
        {data.backlinks.length} linked mention{data.backlinks.length === 1 ? "" : "s"}
      </p>
      {data.backlinks.map((backlink) => (
        <div key={backlink.path} className="ob-search-result">
          <button type="button" className="ob-search-file" onClick={() => openNote(backlink.path)}>
            <span className="truncate font-medium">{noteTitle(backlink.path)}</span>
            {dirname(backlink.path) === "" ? null : <span className="truncate text-muted-foreground">{dirname(backlink.path)}</span>}
          </button>
          {backlink.matches.map((match) => (
            <button
              key={match.line}
              type="button"
              className="ob-search-match"
              onClick={() => openNote(backlink.path, { target: { line: match.line } })}
            >
              {match.text}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
