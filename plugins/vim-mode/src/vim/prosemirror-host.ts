import type { TextHost } from "./host";

// Structural slices of the ProseMirror/TipTap objects bb already runs. The
// plugin never bundles its own ProseMirror: classes such as TextSelection
// must come from the host's copy, so they are reached through live objects.

interface PmNode {
  type: { name: string };
  isText: boolean;
  isTextblock: boolean;
  text?: string;
  nodeSize: number;
  content: { size: number };
  forEach(fn: (child: PmNode, offset: number) => void): void;
  descendants(fn: (node: PmNode, pos: number) => boolean | void): void;
  resolve(pos: number): { marks(): readonly unknown[] };
}

interface PmTransaction {
  steps: readonly unknown[];
  mapping: { slice(from: number): { map(pos: number, assoc?: number): number } };
  replaceWith(from: number, to: number, content: PmNode[]): PmTransaction;
  delete(from: number, to: number): PmTransaction;
  insertText(text: string, from: number): PmTransaction;
  split(pos: number): PmTransaction;
  setSelection(selection: unknown): PmTransaction;
  setMeta(key: string, value: unknown): PmTransaction;
}

interface PmSelection {
  anchor: number;
  head: number;
  toJSON(): { type: string };
}

interface PmState {
  doc: PmNode;
  selection: PmSelection;
  tr: PmTransaction;
  schema: {
    text(text: string, marks?: readonly unknown[]): PmNode;
    nodes: Record<string, { create(): PmNode } | undefined>;
  };
}

interface PmView {
  state: PmState;
  dom: HTMLElement;
  editable: boolean;
  dispatch(tr: PmTransaction): void;
  focus(): void;
  coordsAtPos(pos: number, side?: number): { left: number; right: number; top: number; bottom: number };
  posAtCoords(coords: { left: number; top: number }): { pos: number } | null;
}

export interface TiptapEditorLike {
  view: PmView;
  isEditable: boolean;
  isDestroyed?: boolean;
  commands: Record<string, ((...args: unknown[]) => boolean) | undefined>;
  on(event: "transaction", listener: () => void): unknown;
  off(event: "transaction", listener: () => void): unknown;
}

/** Inline atoms such as mention pills occupy one character of the text model. */
export const OBJECT_CHAR = "￼";

interface TextModel {
  doc: PmNode;
  text: string;
  /** `positions[i]` is the document position before character `i`; one extra entry marks the end. */
  positions: number[];
}

/** TipTap stores its editor on the view's DOM node. */
export function tiptapEditorFor(element: Element): TiptapEditorLike | null {
  const editor = (element as Element & { editor?: TiptapEditorLike }).editor;
  if (!editor || editor.isDestroyed) return null;
  try {
    // TipTap 3 throws on `view` once the editor is unmounted.
    return editor.view?.dom === element ? editor : null;
  } catch {
    return null;
  }
}

function isLineBreak(node: PmNode): boolean {
  return node.type.name === "hardBreak" || node.type.name === "hard_break";
}

function baseSelectionClass(selection: PmSelection): {
  fromJSON(doc: PmNode, json: { type: string; anchor: number; head: number }): unknown;
} {
  let ctor = selection.constructor as any;
  for (let parent = Object.getPrototypeOf(ctor); parent && parent !== Function.prototype; ) {
    ctor = parent;
    parent = Object.getPrototypeOf(ctor);
  }
  return ctor;
}

function findScrollParent(element: HTMLElement): HTMLElement {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export class ProseMirrorHost implements TextHost {
  readonly kind = "prosemirror";
  readonly nativeHistory = true;
  private cache: TextModel | null = null;

  // Captured once: after bb unmounts the editor, reading `editor.view` throws.
  readonly element: HTMLElement;

  constructor(readonly editor: TiptapEditorLike) {
    this.element = editor.view.dom;
  }

  private get view(): PmView {
    return this.editor.view;
  }

  private model(): TextModel {
    const doc = this.view.state.doc;
    if (this.cache?.doc === doc) return this.cache;
    let text = "";
    const positions: number[] = [];
    let seenBlock = false;
    let blockEnd = 0;
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (seenBlock) {
        text += "\n";
        positions.push(blockEnd);
      }
      seenBlock = true;
      const start = pos + 1;
      node.forEach((child, offset) => {
        const childPos = start + offset;
        if (child.isText) {
          const value = child.text ?? "";
          text += value;
          for (let i = 0; i < value.length; i++) positions.push(childPos + i);
        } else {
          text += isLineBreak(child) ? "\n" : OBJECT_CHAR;
          positions.push(childPos);
        }
      });
      blockEnd = start + node.content.size;
      return false;
    });
    positions.push(blockEnd);
    this.cache = { doc, text, positions };
    return this.cache;
  }

  private toPos(offset: number): number {
    const { positions } = this.model();
    return positions[Math.max(0, Math.min(positions.length - 1, offset))]!;
  }

  private toOffset(pos: number): number {
    const { positions } = this.model();
    let low = 0;
    let high = positions.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (positions[mid]! <= pos) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  docKey(): unknown {
    return this.view.state.doc;
  }

  text(): string {
    return this.model().text;
  }

  selection(): { anchor: number; head: number } {
    const { selection } = this.view.state;
    return { anchor: this.toOffset(selection.anchor), head: this.toOffset(selection.head) };
  }

  setSelection(anchor: number, head: number): void {
    const { state } = this.view;
    const anchorPos = this.toPos(anchor);
    const headPos = this.toPos(head);
    const current = state.selection;
    if (current.anchor === anchorPos && current.head === headPos && current.toJSON().type === "text") {
      return;
    }
    const selection = baseSelectionClass(current).fromJSON(state.doc, {
      type: "text",
      anchor: anchorPos,
      head: headPos,
    });
    this.view.dispatch(state.tr.setSelection(selection));
  }

  replace(from: number, to: number, insert: string): void {
    const { state } = this.view;
    const start = this.toPos(from);
    const end = this.toPos(to);
    const { schema } = state;
    const marks = state.doc.resolve(start).marks();
    const parts = insert.split(OBJECT_CHAR).join("").split("\n");
    const lineBreak = schema.nodes.hardBreak ?? schema.nodes.hard_break;
    let tr = state.tr;
    if (lineBreak) {
      const content: PmNode[] = [];
      parts.forEach((part, index) => {
        if (index > 0) content.push(lineBreak.create());
        if (part) content.push(schema.text(part, marks));
      });
      tr = content.length > 0 ? tr.replaceWith(start, end, content) : tr.delete(start, end);
    } else {
      tr = tr.delete(start, end);
      let pos = start;
      parts.forEach((part, index) => {
        if (index > 0) {
          tr = tr.split(pos);
          pos = tr.mapping.slice(tr.steps.length - 1).map(pos, 1);
        }
        if (part) {
          tr = tr.insertText(part, pos);
          pos += part.length;
        }
      });
    }
    this.view.dispatch(tr);
  }

  undo(): boolean {
    return this.editor.commands.undo?.() ?? false;
  }

  closeHistoryGroup(): void {
    // prosemirror-history reads closeHistory() through a PluginKey whose
    // string form is "closeHistory$"; the plugin cannot import the host's key.
    this.view.dispatch(this.view.state.tr.setMeta("closeHistory$", true).setMeta("addToHistory", false));
  }

  redo(): boolean {
    return this.editor.commands.redo?.() ?? false;
  }

  isEditable(): boolean {
    return this.editor.isEditable && this.view.editable;
  }

  focus(): void {
    this.view.focus();
  }

  coordsAt(offset: number) {
    try {
      const coords = this.view.coordsAtPos(this.toPos(offset), 1);
      return coords.bottom > coords.top ? coords : null;
    } catch {
      return null;
    }
  }

  offsetAt(x: number, y: number): number | null {
    const rect = this.element.getBoundingClientRect();
    const left = Math.max(rect.left + 1, Math.min(rect.right - 1, x));
    try {
      const result = this.view.posAtCoords({ left, top: y });
      return result ? this.toOffset(result.pos) : null;
    } catch {
      return null;
    }
  }

  contentOrigin(): { left: number; top: number } {
    const rect = this.element.getBoundingClientRect();
    const style = getComputedStyle(this.element);
    return {
      left: rect.left + parseFloat(style.paddingLeft || "0"),
      top: rect.top + parseFloat(style.paddingTop || "0"),
    };
  }

  scrollElement(): HTMLElement {
    return findScrollParent(this.element);
  }

  scrollIntoView(offset: number): void {
    const coords = this.coordsAt(offset);
    if (!coords) return;
    const scroller = this.scrollElement();
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = isRoot ? 0 : scroller.getBoundingClientRect().top;
    const bottom = isRoot ? window.innerHeight : scroller.getBoundingClientRect().bottom;
    if (coords.top < top) scroller.scrollTop -= top - coords.top;
    else if (coords.bottom > bottom) scroller.scrollTop += coords.bottom - bottom;
  }

  lineHeight(): number {
    const style = getComputedStyle(this.element);
    const lineHeight = parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight)) return lineHeight;
    const fontSize = parseFloat(style.fontSize);
    return Number.isFinite(fontSize) ? fontSize * 1.2 : 16;
  }

  subscribe(listener: () => void): () => void {
    this.editor.on("transaction", listener);
    return () => {
      try {
        this.editor.off("transaction", listener);
      } catch {
        // A destroyed editor has already dropped its listeners.
      }
    };
  }

  destroy(): void {
    this.cache = null;
  }
}
