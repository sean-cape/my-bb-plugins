/**
 * The editing surface the vim adapter drives. Offsets index the host's plain
 * text, in which every line break (of any underlying kind) is one `\n`.
 */
export interface TextHost {
  readonly kind: "text-field" | "prosemirror" | "codemirror";
  /** The focusable element that receives keyboard input. */
  readonly element: HTMLElement;
  /** Cheap identity that changes whenever the text may have changed. */
  docKey(): unknown;
  text(): string;
  selection(): { anchor: number; head: number };
  setSelection(anchor: number, head: number): void;
  replace(from: number, to: number, insert: string): void;
  /**
   * True when `undo`/`redo` step the host's own history; otherwise the
   * adapter restores text itself.
   */
  readonly nativeHistory: boolean;
  /** Returns false when the host has nothing to undo/redo. */
  undo(): boolean;
  redo(): boolean;
  /** Keeps the next change out of the host history group of earlier changes. */
  closeHistoryGroup?(): void;
  isEditable(): boolean;
  focus(): void;
  /** Viewport rectangle of the character starting at `offset`. */
  coordsAt(offset: number): { left: number; right: number; top: number; bottom: number } | null;
  /** Offset nearest to a viewport point. */
  offsetAt(x: number, y: number): number | null;
  /** Viewport position of the content's top-left corner (moves with scrolling). */
  contentOrigin(): { left: number; top: number };
  scrollElement(): HTMLElement;
  scrollIntoView(offset: number): void;
  lineHeight(): number;
  /** Calls `listener` synchronously after any text or selection change. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}
