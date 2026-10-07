import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, EditorState, RangeSetBuilder, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { dirname, parseLinks, type LinkResolver, type ParsedLink } from "../shared/obsidian";
import { frontmatter, frontmatterTag, livePreview } from "./live-preview";
import { consumeNavigation, resolveTargetLine, type NavigationTarget } from "./state";

interface EditorProps {
  path: string;
  /** Changing `version` replaces the document with `content` (an external reload). */
  content: string;
  version: number;
  resolver: LinkResolver;
  notePaths: readonly string[];
  target: { target: NavigationTarget; seq: number } | null;
  onChange: (content: string) => void;
  onOpenLink: (link: ParsedLink) => void;
}

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: "ob-cm-h1" },
  { tag: tags.heading2, class: "ob-cm-h2" },
  { tag: tags.heading3, class: "ob-cm-h3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "ob-cm-h4" },
  { tag: tags.strong, class: "ob-cm-strong" },
  { tag: tags.emphasis, class: "ob-cm-em" },
  { tag: tags.strikethrough, class: "ob-cm-strike" },
  { tag: [tags.link, tags.url], class: "ob-cm-url" },
  { tag: tags.monospace, class: "ob-cm-code" },
  { tag: tags.quote, class: "ob-cm-quote" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], class: "ob-cm-mark" },
  { tag: tags.list, class: "ob-cm-list" },
  { tag: frontmatterTag, class: "ob-cm-frontmatter" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.7", overflow: "auto" },
  ".cm-content": {
    maxWidth: "46rem",
    margin: "0 auto",
    padding: "1.5rem 1.25rem 40vh",
    caretColor: "var(--foreground)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 25%, transparent) !important",
  },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "0.25rem 0.75rem" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted-foreground)", marginLeft: "0.75rem", fontStyle: "normal" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--primary) 40%, transparent)" },
});

const hiddenSyntax = Decoration.replace({});
const resolverChanged = Annotation.define<boolean>();
const TAG = /(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * Lightweight live preview: links render as their display text, with the
 * markup revealed only while the caret is inside them.
 */
function obsidianDecorations(getResolver: () => LinkResolver, path: string) {
  const build = (view: EditorView): { decorations: DecorationSet; links: ParsedLink[] } => {
    const { state } = view;
    const text = state.doc.toString();
    const links = parseLinks(text);
    const ranges: { from: number; to: number; decoration: Decoration }[] = [];
    const resolver = getResolver();

    for (const link of links) {
      const resolved = link.target === "" || resolver.resolve(link.target, path, link.kind) !== null;
      const className = `ob-cm-link${resolved ? "" : " ob-cm-link-unresolved"}${link.embed ? " ob-cm-embed" : ""}`;
      const active = selectionTouches(state, link.from, link.to);
      if (link.kind === "wiki") {
        const open = link.from + (link.embed ? 3 : 2);
        const close = link.to - 2;
        const pipe = text.indexOf("|", open);
        const labelStart = link.alias !== null && pipe !== -1 && pipe < close ? pipe + 1 : open;
        if (!active) {
          ranges.push({ from: link.from, to: labelStart, decoration: hiddenSyntax });
          ranges.push({ from: close, to: link.to, decoration: hiddenSyntax });
        }
        ranges.push({ from: active ? open : labelStart, to: close, decoration: Decoration.mark({ class: className }) });
      } else {
        const labelStart = link.from + (link.embed ? 2 : 1);
        const labelEnd = text.indexOf("](", labelStart);
        if (labelEnd === -1 || labelEnd === labelStart) continue;
        if (!active) {
          ranges.push({ from: link.from, to: labelStart, decoration: hiddenSyntax });
          ranges.push({ from: labelEnd, to: link.to, decoration: hiddenSyntax });
        }
        ranges.push({ from: labelStart, to: labelEnd, decoration: Decoration.mark({ class: className }) });
      }
    }

    for (const { from, to } of view.visibleRanges) {
      const slice = state.doc.sliceString(from, to);
      for (const match of slice.matchAll(TAG)) {
        const start = from + match.index! + match[1]!.length;
        const end = start + match[2]!.length;
        const inLink = links.some((link) => link.from <= start && link.to >= end);
        const node = state.doc.lineAt(start);
        if (inLink || /^#{1,6}\s/.test(node.text.slice(start - node.from))) continue;
        ranges.push({ from: start, to: end, decoration: Decoration.mark({ class: "ob-cm-tag" }) });
      }
    }

    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ranges) builder.add(range.from, range.to, range.decoration);
    return { decorations: builder.finish(), links };
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      links: ParsedLink[];
      constructor(view: EditorView) {
        ({ decorations: this.decorations, links: this.links } = build(view));
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some((tr) => tr.annotation(resolverChanged))) {
          ({ decorations: this.decorations, links: this.links } = build(update.view));
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function wikilinkCompletion(getResolver: () => LinkResolver, getNotePaths: () => readonly string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]|#\n]*$/);
    if (before === null) return null;
    const from = before.from + 2;
    const resolver = getResolver();
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    return {
      from,
      options: getNotePaths().map((notePath) => {
        const label = resolver.linkTextFor(notePath);
        const folder = dirname(notePath);
        return {
          label,
          detail: folder === "" ? undefined : folder,
          type: "text",
          apply: after === "]]" ? label : `${label}]]`,
        };
      }),
      validFor: /^[^[\]|#\n]*$/,
    };
  };
}

export function Editor({ path, content, version, resolver, notePaths, target, onChange, onOpenLink }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const resolverRef = useRef(resolver);
  const notePathsRef = useRef(notePaths);
  const onChangeRef = useRef(onChange);
  const onOpenLinkRef = useRef(onOpenLink);
  const versionRef = useRef(version);
  resolverRef.current = resolver;
  notePathsRef.current = notePaths;
  onChangeRef.current = onChange;
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const decorations = obsidianDecorations(() => resolverRef.current, path);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          // Keep CRLF notes CRLF so a keystroke doesn't rewrite every line ending.
          content.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
          history(),
          drawSelection(),
          closeBrackets(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, extensions: [frontmatter] }),
          syntaxHighlighting(markdownHighlight),
          editorTheme,
          placeholder("Start writing…"),
          decorations,
          livePreview,
          autocompletion({
            override: [wikilinkCompletion(() => resolverRef.current, () => notePathsRef.current)],
            icons: false,
          }),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.sliceDoc());
          }),
          EditorView.domEventHandlers({
            mousedown(event, view) {
              if (event.button !== 0) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return false;
              const plugin = view.plugin(decorations);
              // Require the click to land on the link text: past the end of a line maps to the link's end too.
              if (!(event.target instanceof Element) || event.target.closest(".ob-cm-link") === null) return false;
              const link = plugin?.links.find((candidate) => candidate.from <= pos && pos <= candidate.to);
              if (link === undefined) return false;
              const modified = event.metaKey || event.ctrlKey;
              const rendered = !selectionTouches(view.state, link.from, link.to);
              if (!modified && !rendered) return false;
              event.preventDefault();
              onOpenLinkRef.current(link);
              return true;
            },
          }),
          editorAttributes,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once per note; later prop changes flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || versionRef.current === version) return;
    versionRef.current = version;
    const current = view.state.doc.toString();
    const next = view.state.toText(content).toString();
    if (current === next) return;
    // Replace only the span that differs so the caret and scroll position map through the change.
    let start = 0;
    while (start < current.length && start < next.length && current[start] === next[start]) start += 1;
    let endCurrent = current.length;
    let endNext = next.length;
    while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
      endCurrent -= 1;
      endNext -= 1;
    }
    view.dispatch({
      changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) },
      // An external reload shouldn't be something Cmd+Z quietly reverts.
      annotations: Transaction.addToHistory.of(false),
    });
  }, [content, version]);

  useEffect(() => {
    viewRef.current?.dispatch({ annotations: resolverChanged.of(true) });
  }, [resolver]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || target === null) return;
    const doc = view.state.doc;
    consumeNavigation(target.seq);
    const index = resolveTargetLine(doc.toString(), target.target);
    if (index === null || index + 1 > doc.lines) return;
    const line = doc.line(index + 1);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }),
    });
    view.focus();
  }, [target]);

  return <div ref={hostRef} className="ob-editor h-full min-h-0" />;
}

const editorAttributes = EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" });
