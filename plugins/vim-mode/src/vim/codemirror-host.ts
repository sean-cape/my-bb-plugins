import type { TextHost } from "./host";

// Structural slice of a CodeMirror 6 EditorView owned by another bundle (such
// as the Obsidian vault editor). Only plain-object transaction specs cross the
// boundary: extensions, facets, and annotations from a second copy of
// @codemirror/* would not be recognized by that view.

interface CmText {
  length: number;
  toString(): string;
}

interface CmState {
  doc: CmText;
  readOnly: boolean;
  selection: { main: { anchor: number; head: number } };
}

export interface CmViewLike {
  state: CmState;
  dom: HTMLElement;
  contentDOM: HTMLElement;
  scrollDOM: HTMLElement;
  defaultLineHeight: number;
  dispatch(spec: {
    changes?: { from: number; to?: number; insert?: string };
    selection?: { anchor: number; head?: number };
    scrollIntoView?: boolean;
    userEvent?: string;
    effects?: unknown;
  }): void;
  update(transactions: readonly unknown[]): void;
  focus(): void;
  coordsAtPos(pos: number, side?: -1 | 1): { left: number; right: number; top: number; bottom: number } | null;
  posAtCoords(coords: { x: number; y: number }): number | null;
}

/**
 * The EditorView behind a `.cm-content` element, found the way
 * `EditorView.findFromDOM` does: newer releases link DOM to views through
 * `cmTile`, older ones through `cmView`.
 */
export function codeMirrorViewFor(content: Element): CmViewLike | null {
  const node = content as Element & {
    cmTile?: { root?: { view?: CmViewLike } };
    cmView?: { rootView?: { view?: CmViewLike } };
  };
  const view = node.cmTile?.root?.view ?? node.cmView?.rootView?.view ?? null;
  return view && view.contentDOM === content ? view : null;
}

export class CodeMirrorHost implements TextHost {
  readonly kind = "codemirror";
  // The view's history extension belongs to its own bundle, so its undo
  // command is unreachable; the adapter keeps vim's history itself.
  readonly nativeHistory = false;
  private readonly listeners = new Set<() => void>();
  private patched = false;

  constructor(readonly view: CmViewLike) {}

  get element(): HTMLElement {
    return this.view.contentDOM;
  }

  docKey(): unknown {
    return this.view.state.doc;
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  selection(): { anchor: number; head: number } {
    const { anchor, head } = this.view.state.selection.main;
    return { anchor, head };
  }

  setSelection(anchor: number, head: number): void {
    const current = this.view.state.selection.main;
    if (current.anchor === anchor && current.head === head) return;
    this.view.dispatch({ selection: { anchor, head }, userEvent: "select" });
  }

  replace(from: number, to: number, insert: string): void {
    this.view.dispatch({ changes: { from, to, insert }, userEvent: "input" });
  }

  undo(): boolean {
    return false;
  }

  redo(): boolean {
    return false;
  }

  isEditable(): boolean {
    return !this.view.state.readOnly && this.view.contentDOM.getAttribute("contenteditable") !== "false";
  }

  focus(): void {
    this.view.focus();
  }

  coordsAt(offset: number) {
    const coords = this.view.coordsAtPos(offset, 1) ?? this.view.coordsAtPos(offset, -1);
    return coords && coords.bottom > coords.top ? coords : null;
  }

  offsetAt(x: number, y: number): number | null {
    const rect = this.view.contentDOM.getBoundingClientRect();
    return this.view.posAtCoords({ x: Math.max(rect.left + 1, Math.min(rect.right - 1, x)), y });
  }

  contentOrigin(): { left: number; top: number } {
    const rect = this.view.contentDOM.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  // An editor that grows with its content leaves scrolling to an ancestor.
  scrollElement(): HTMLElement {
    for (let current: HTMLElement | null = this.view.scrollDOM; current; current = current.parentElement) {
      const { overflowY } = getComputedStyle(current);
      const scrollable = current === this.view.scrollDOM || overflowY === "auto" || overflowY === "scroll";
      if (scrollable && current.scrollHeight > current.clientHeight) return current;
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  }

  scrollIntoView(offset: number): void {
    // The effect must come from the view's own EditorView class to be
    // recognized; it scrolls every ancestor that needs it.
    const EditorViewClass = this.view.constructor as {
      scrollIntoView?: (pos: number, options?: { y?: string }) => unknown;
    };
    const effect = EditorViewClass.scrollIntoView?.(offset, { y: "nearest" });
    if (effect) this.view.dispatch({ effects: effect });
  }

  lineHeight(): number {
    return this.view.defaultLineHeight || 16;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.patchUpdate();
    return () => {
      this.listeners.delete(listener);
    };
  }

  // A view only reports updates to extensions from its own bundle, so the
  // instance's `update` is wrapped to observe every transaction synchronously.
  private patchUpdate(): void {
    if (this.patched) return;
    this.patched = true;
    const view = this.view;
    const original = view.update;
    const listeners = this.listeners;
    view.update = function (this: CmViewLike, transactions: readonly unknown[]) {
      original.call(this, transactions);
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("[vim-mode]", error);
        }
      }
    };
  }

  destroy(): void {
    this.listeners.clear();
    if (this.patched) {
      delete (this.view as Partial<CmViewLike>).update;
      this.patched = false;
    }
  }
}
