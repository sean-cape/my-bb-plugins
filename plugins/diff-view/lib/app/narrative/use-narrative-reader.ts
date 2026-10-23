import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { patchLineKey, type PatchLine } from "../../narrative";
import type { NarrativeStory } from "../../types";
import { withMembers } from "../sets";
import { readPreference, useDiffPreferences, writePreference } from "../state";
import { affectedAddress, buildChapters, initialAddress, moveChapter, movePage, narratedFiles, pages, searchSteps, type NarrativeChapter, type StepAddress } from "./chapters";
import { stepExcerpts, type StepExcerpt } from "./excerpts";

function readJson<T>(raw: string | null, fallback: T): T {
  try {
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export type NarrativeReader = ReturnType<typeof useNarrativeReader>;

/**
 * Where the reader stands in the narrative and what that page shows: the chapter and step, its excerpts, which steps
 * have been read, the outline and the step search. The position and read marks are remembered per view instance.
 */
export function useNarrativeReader({ story, instanceKey, currentPaths, viewed }: { story: NarrativeStory | null; instanceKey: string; currentPaths: ReadonlySet<string>; viewed: ReadonlySet<string> }) {
  const chapters = useMemo(() => (story === null ? [] : buildChapters(story)), [story]);
  const positionKey = `narrativeAt:${instanceKey}` as const;
  const readKey = `narrativeRead:${instanceKey}` as const;
  const [address, setAddressState] = useState<StepAddress | null>(null);
  const [read, setRead] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(readPreference(readKey), [])));
  const [outline, setOutlineState] = useState(() => readPreference("narrativeOutline") !== "false");
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(new Set());
  // By path, the rows of each excerpt's gaps the reader opened on this page.
  const [revealed, setRevealed] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  // Bumped by every move to another page, with which end of it the reader arrives at, so the view can place its
  // cursor there once the page has rendered.
  const [arrival, setArrival] = useState<{ count: number; where: "start" | "end" }>({ count: 0, where: "start" });

  // Where the reader stands, by chapter and step id: a new story (a narrative finished, an old one left the window)
  // shifts indices, so it is re-resolved from these.
  const standing = useRef<{ chapterKey: string; stepId: string | null } | null>(null);
  const addressRef = useRef(address);
  addressRef.current = address;
  useEffect(() => {
    const saved = standing.current ?? readJson<{ chapterKey: string; stepId: string | null } | null>(readPreference(positionKey), null);
    const next = initialAddress(chapters, saved);
    const current = addressRef.current;
    // A refetched story resolves to the same page; only a different one is an arrival.
    if (current !== null && next !== null && current.chapter === next.chapter && current.step === next.step) return;
    setAddressState(next);
    if (next !== null) setArrival((arrival) => ({ count: arrival.count + 1, where: "start" }));
  }, [chapters, positionKey]);

  const chapter: NarrativeChapter | null = address === null ? null : (chapters[address.chapter] ?? null);
  const step = chapter === null || address === null || address.step < 0 ? null : (chapter.steps[address.step] ?? null);
  const { hideWhitespace } = useDiffPreferences();
  const excerpts: StepExcerpt[] = useMemo(() => (step === null || chapter === null ? [] : stepExcerpts(step.refs, chapter.files, hideWhitespace, revealed)), [step, chapter, hideWhitespace, revealed]);

  const go = (next: StepAddress | null, where: "start" | "end" = "start"): boolean => {
    if (next === null || address === null || (next.chapter === address.chapter && next.step === address.step)) return false;
    setAddressState(next);
    setCollapsedState(new Set());
    setRevealed(new Map());
    setArrival((arrival) => ({ count: arrival.count + 1, where }));
    const target = chapters[next.chapter];
    if (target === undefined) return true;
    const stepId = next.step < 0 ? null : (target.steps[next.step]?.id ?? null);
    standing.current = { chapterKey: target.key, stepId };
    writePreference(positionKey, JSON.stringify(standing.current));
    return true;
  };

  // A step counts as read once it has been on screen.
  useEffect(() => {
    if (chapter === null || step === null) return;
    const key = `${chapter.key}/${step.id}`;
    setRead((current) => {
      if (current.has(key)) return current;
      const next = new Set(current).add(key);
      writePreference(readKey, JSON.stringify([...next]));
      return next;
    });
  }, [chapter, step, readKey]);

  // Line numbers only mean today's lines in the current narrative of a diff that has not moved since.
  const describesCurrentDiff = chapter?.current === true && story?.stale === false;
  const readInChapter = useMemo(() => {
    if (chapter === null) return new Set<string>();
    return new Set([...read].filter((key) => key.startsWith(`${chapter.key}/`)).map((key) => key.slice(chapter.key.length + 1)));
  }, [read, chapter]);
  const narratedUnviewed = describesCurrentDiff && chapter !== null ? narratedFiles(chapter, readInChapter).filter((path) => currentPaths.has(path) && !viewed.has(path)) : [];

  const setOutline = (open: boolean) => {
    setOutlineState(open);
    writePreference("narrativeOutline", String(open));
  };
  const setCollapsed = (paths: readonly string[], isCollapsed: boolean) => setCollapsedState((current) => withMembers(current, paths, isCollapsed));
  const reveal = useCallback((path: string, lines: readonly PatchLine[]) => {
    setRevealed((current) => {
      const before = current.get(path) ?? new Set<string>();
      const after = withMembers(before, lines.map(patchLineKey), true);
      return after === before ? current : new Map(current).set(path, after);
    });
  }, []);

  const all = pages(chapters);
  const position = address === null ? 0 : all.findIndex((page) => page.chapter === address.chapter && page.step === address.step) + 1;

  /** The `count`th step matching the last search in `direction`, wrapping past either end as vim's search does; null when nothing matches. */
  const searchHit = (direction: 1 | -1, count: number): StepAddress | null => {
    if (lastSearch === null || address === null) return null;
    const here = position - 1;
    const hits = searchSteps(chapters, lastSearch).map((hit) => all.findIndex((page) => page.chapter === hit.chapter && page.step === hit.step));
    const order = direction === 1 ? [...hits.filter((index) => index > here), ...hits.filter((index) => index <= here)] : [...hits.filter((index) => index < here).reverse(), ...hits.filter((index) => index >= here).reverse()];
    const target = order[Math.min(count, order.length) - 1];
    return target === undefined ? null : (all[target] ?? null);
  };

  return {
    chapters,
    address,
    chapter,
    step,
    excerpts,
    read,
    outline,
    setOutline,
    lastSearch,
    setLastSearch,
    collapsed,
    setCollapsed,
    reveal,
    arrival,
    position,
    total: all.length,
    describesCurrentDiff,
    narratedUnviewed,
    go,
    movePage: (by: number) => (address === null ? null : movePage(chapters, address, by)),
    moveChapter: (by: 1 | -1) => (address === null ? null : moveChapter(chapters, address, by)),
    affected: (stepId: string) => (address === null ? null : affectedAddress(chapters, address, stepId)),
    searchHit,
  };
}
