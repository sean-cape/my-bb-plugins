export interface SettingsPage {
  href: string;
  title: string;
}

export interface SettingEntry {
  kind: "page" | "heading" | "setting";
  href: string;
  page: string;
  section: string | null;
  label: string;
  description: string | null;
  /** Which of the page's elements with this text it is, for pages that repeat a label. */
  occurrence: number;
}

// bb's settings markup has no plugin contract, so these selectors follow the
// shipped DOM: headings are h2/h3, a setting's label is a text-sm paragraph,
// and its description is a text-xs paragraph in the same text column.
export const PAGE_VIEWPORT = "[data-page-scroll-viewport]";
const TEXT_ELEMENTS = "h2, h3, p";
const SKIPPED_ANCESTORS = "button, a, [role='option'], [role='menu'], [role='listbox']";
const MAX_LABEL_LENGTH = 100;

export function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

function isLabel(element: Element): boolean {
  if (element.tagName !== "P") return true;
  return element.classList.contains("text-sm") && !element.classList.contains("text-xs");
}

/** The headings and setting labels on a page, in document order, that search can find and point back at. */
export function labelElements(viewport: Element): { element: Element; text: string }[] {
  const found: { element: Element; text: string }[] = [];
  for (const element of viewport.querySelectorAll(TEXT_ELEMENTS)) {
    if (!isLabel(element) || element.parentElement?.closest(SKIPPED_ANCESTORS)) continue;
    const text = normalizeText(element.textContent);
    if (text === "" || text.length > MAX_LABEL_LENGTH) continue;
    found.push({ element, text });
  }
  return found;
}

function descriptionOf(label: Element): string | null {
  const candidates =
    label.tagName === "P"
      ? [...(label.parentElement?.parentElement?.children ?? [])]
      : [label.nextElementSibling];
  const description = candidates.find(
    (element) => element !== label && element?.tagName === "P" && element.classList.contains("text-xs"),
  );
  return normalizeText(description?.textContent) || null;
}

/** An h3 groups the rows inside its parent's parent: a keyboard page section, a providers sub-panel. */
function headingScope(heading: Element): Element {
  return heading.parentElement?.parentElement ?? heading;
}

export function extractEntries(viewport: Element, page: SettingsPage): SettingEntry[] {
  const entries: SettingEntry[] = [];
  const seen = new Map<string, number>();
  let section: string | null = null;
  let subsection: Element | null = null;
  for (const { element, text } of labelElements(viewport)) {
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    if (element.tagName === "H2") {
      section = text === page.title ? null : text;
      subsection = null;
    }
    // The page's own entry already covers its title.
    if (text === page.title) continue;
    const inSubsection = subsection && headingScope(subsection).contains(element);
    const entrySection =
      element.tagName === "H2" ? null : inSubsection ? normalizeText(subsection!.textContent) : section;
    entries.push({
      kind: element.tagName === "P" ? "setting" : "heading",
      href: page.href,
      page: page.title,
      section: entrySection,
      label: text,
      description: descriptionOf(element),
      occurrence,
    });
    if (element.tagName === "H3") subsection = element;
  }
  return entries;
}

export function pageEntry(page: SettingsPage): SettingEntry {
  return {
    kind: "page",
    href: page.href,
    page: page.title,
    section: null,
    label: page.title,
    description: null,
    occurrence: -1,
  };
}

/** The element an entry was read from, on the page as it is rendered now. */
export function findEntryElement(viewport: Element, entry: SettingEntry): Element | null {
  if (entry.kind === "page") return null;
  return labelElements(viewport).filter(({ text }) => text === entry.label)[entry.occurrence]?.element ?? null;
}

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

function termScore(entry: SettingEntry, term: string): number | null {
  const label = entry.label.toLowerCase();
  const at = label.indexOf(term);
  if (at === 0 || (at > 0 && /[^\p{L}\p{N}]/u.test(label[at - 1]!))) return 0;
  if (at > 0) return 1;
  if (`${entry.section ?? ""} ${entry.page}`.toLowerCase().includes(term)) return 2;
  if (entry.description?.toLowerCase().includes(term)) return 3;
  return null;
}

/** Entries matching every term, best first: label word starts, then label text, then the page or section, then descriptions. */
export function searchEntries(entries: readonly SettingEntry[], query: string): SettingEntry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const whole = terms.join(" ");
  const scored: { entry: SettingEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    let score = 0;
    for (const term of terms) {
      const termScored = termScore(entry, term);
      if (termScored === null) return;
      score += termScored;
    }
    if (entry.label.toLowerCase().startsWith(whole)) score -= 1;
    if (entry.kind === "page" && score < terms.length) score -= 0.5;
    scored.push({ entry, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map(({ entry }) => entry);
}

/** Splits text into runs, flagging the ones that match a query term. */
export function markTerms(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      hits.fill(true, at, at + term.length);
    }
  }
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.hit === hits[i]) last.text += text[i];
    else runs.push({ text: text[i]!, hit: hits[i]! });
  }
  return runs;
}
