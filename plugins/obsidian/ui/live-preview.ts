// Obsidian-style live preview for CodeMirror: markdown markup is hidden or
// replaced with widgets on every line the selection isn't touching.
import { syntaxTree } from "@codemirror/language";
import type { MarkdownConfig } from "@lezer/markdown";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { Tag } from "@lezer/highlight";
import { parseFrontmatter } from "../shared/obsidian";

export const frontmatterTag = Tag.define();

/** Parses a leading YAML block as one opaque node so its lines aren't read as markdown. */
export const frontmatter: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true, style: frontmatterTag }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trim() !== "---") return false;
        // BlockContext's input is untyped internals; it's the only way to look past
        // the next line, and without it an unclosed "---" would swallow the document.
        const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } }).input;
        if (input === undefined) return false;
        const head = input.read(0, Math.min(input.length, 64 * 1024));
        const parsed = parseFrontmatter(head);
        if (parsed === null) return false;
        const end = parsed.end > 0 && head[parsed.end - 1] === "\n" ? parsed.end - 1 : parsed.end;
        while (cx.lineStart + line.text.length < end && cx.nextLine()) {
          // Consume every line up to and including the closing fence.
        }
        cx.addElement(cx.elt("Frontmatter", 0, end));
        cx.nextLine();
        return true;
      },
    },
  ],
};

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "ob-cm-bullet";
    span.textContent = "•";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "ob-cm-checkbox";
    input.setAttribute("aria-label", this.checked ? "Mark task not done" : "Mark task done");
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return input;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "ob-cm-hr";
    return span;
  }
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const highlight = Decoration.mark({ class: "ob-cm-highlight" });
const quoteLine = Decoration.line({ class: "ob-cm-quote-line" });
const frontmatterLine = Decoration.line({ class: "ob-cm-frontmatter-line" });
const HIGHLIGHT = /==([^=\n]+)==/g;
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark"]);

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];
  const add = (from: number, to: number, decoration: Decoration) => ranges.push({ from, to, decoration });

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name === "Frontmatter") {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            add(line.from, line.from, frontmatterLine);
            pos = line.to + 1;
          }
          return false;
        }
        if (name === "FencedCode" || name === "CodeBlock") return false;
        if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            add(line.from, line.from, quoteLine);
            pos = line.to + 1;
          }
          return;
        }
        if (isActive(node.from)) return;
        if (name === "HeaderMark") {
          const after = state.doc.sliceString(node.to, node.to + 1);
          const parent = node.node.parent?.name ?? "";
          if (parent.startsWith("SetextHeading")) add(node.from, node.to, hidden);
          else add(node.from, after === " " ? node.to + 1 : node.to, hidden);
        } else if (INLINE_MARKS.has(name)) {
          add(node.from, node.to, hidden);
        } else if (name === "CodeMark" && node.node.parent?.name === "InlineCode") {
          add(node.from, node.to, hidden);
        } else if (name === "QuoteMark") {
          const after = state.doc.sliceString(node.to, node.to + 1);
          add(node.from, after === " " ? node.to + 1 : node.to, hidden);
        } else if (name === "HorizontalRule") {
          add(node.from, node.to, rule);
        } else if (name === "ListMark") {
          const listItem = node.node.parent;
          const task = listItem?.getChild("Task");
          const text = state.doc.sliceString(node.from, node.to);
          if (task) {
            const marker = task.getChild("TaskMarker");
            if (marker) {
              const checked = state.doc.sliceString(marker.from + 1, marker.from + 2).toLowerCase() === "x";
              const end = state.doc.sliceString(marker.to, marker.to + 1) === " " ? marker.to + 1 : marker.to;
              add(node.from, end, Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }));
            }
          } else if (listItem?.parent?.name === "BulletList" && /^[-*+]$/.test(text)) {
            add(node.from, node.to, bullet);
          }
        }
      },
    });

    const slice = state.doc.sliceString(from, to);
    for (const match of slice.matchAll(HIGHLIGHT)) {
      const start = from + match.index!;
      const end = start + match[0].length;
      const inCode = syntaxTree(state).resolveInner(start + 2, 1).name.includes("Code");
      if (inCode) continue;
      if (isActive(start)) {
        add(start, end, highlight);
      } else {
        add(start, start + 2, hidden);
        add(start + 2, end - 2, highlight);
        add(end - 2, end, hidden);
      }
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastHiddenEnd = -1;
  for (const range of ranges) {
    // Overlapping replacements (e.g. a mark nested in a hidden span) would throw.
    const isReplace = range.from !== range.to && range.decoration.spec.widget !== undefined || range.decoration === hidden;
    if (isReplace && range.from < lastHiddenEnd) continue;
    builder.add(range.from, range.to, range.decoration);
    if (isReplace) lastHiddenEnd = range.to;
  }
  return builder.finish();
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
