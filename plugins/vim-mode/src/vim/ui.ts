import type { VimEditor } from "./adapter";
import { vimState } from "./keys";

export const UI_ATTRIBUTE = "data-bb-vim-ui";
const NORMAL_CLASS = "bb-vim-normal";

function modeLabel(cm: VimEditor): string | null {
  const vim = vimState(cm);
  if (!vim) return null;
  if (vim.insertMode) return cm.state.overwrite ? "REPLACE" : null;
  if (vim.visualMode) {
    if (vim.visualBlock) return "VISUAL BLOCK";
    return vim.visualLine ? "VISUAL LINE" : "VISUAL";
  }
  return "NORMAL";
}

/**
 * Draws the block cursor, a quiet mode indicator in the focused editor's
 * bottom-right corner, and a bar above it for `:`/`/` prompts and messages. Everything lives in fixed-position
 * nodes on `document.body` so no host DOM is restructured.
 */
export class VimUi {
  private readonly cursorLayer: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly indicator: HTMLDivElement;
  private readonly modeNode: HTMLSpanElement;
  private readonly keysNode: HTMLSpanElement;
  private frame = 0;
  private visible = false;

  constructor(private readonly cm: VimEditor) {
    this.cursorLayer = document.createElement("div");
    this.cursorLayer.className = "bb-vim-cursor-layer";
    this.cursorLayer.setAttribute(UI_ATTRIBUTE, "");
    this.cursorLayer.setAttribute("aria-hidden", "true");

    this.bar = document.createElement("div");
    this.bar.className = "bb-vim-bar";
    this.bar.setAttribute(UI_ATTRIBUTE, "");
    this.bar.append(cm.panel);

    this.indicator = document.createElement("div");
    this.indicator.className = "bb-vim-indicator";
    this.indicator.setAttribute(UI_ATTRIBUTE, "");
    this.indicator.setAttribute("aria-hidden", "true");
    this.modeNode = document.createElement("span");
    this.modeNode.className = "bb-vim-mode";
    this.keysNode = document.createElement("span");
    this.keysNode.className = "bb-vim-keys";
    this.indicator.append(this.keysNode, this.modeNode);

    const schedule = () => this.schedule();
    cm.on("vim-mode-change", schedule);
    cm.on("vim-command-done", () => {
      const vim = vimState(cm);
      if (vim) vim.status = "";
      schedule();
    });
    cm.on("vim-keypress", schedule);
    // Vim focuses the prompt's input right after this signal, which fails
    // while the bar is still hidden, so render synchronously.
    cm.on("dialog", () => this.render());
    cm.on("cursorActivity", schedule);
    cm.on("change", schedule);
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    document.body.append(this.cursorLayer, this.indicator, this.bar);
    this.schedule();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.cursorLayer.remove();
    this.indicator.remove();
    this.bar.remove();
    this.cm.host.element.classList.remove(NORMAL_CLASS);
  }

  contains(node: Node | null): boolean {
    return (
      !!node &&
      (this.bar.contains(node) || this.indicator.contains(node) || this.cursorLayer.contains(node))
    );
  }

  schedule(): void {
    if (!this.visible || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (!this.visible) return;
    const { cm } = this;
    const vim = vimState(cm);
    const element = cm.host.element;
    const label = modeLabel(cm);
    const blockCursor = !!vim && (!vim.insertMode || !!cm.state.overwrite);
    element.classList.toggle(NORMAL_CLASS, blockCursor);
    this.renderCursors(blockCursor);

    const pending = vim?.status ?? "";
    this.modeNode.textContent = label ?? "";
    this.modeNode.hidden = !label;
    this.keysNode.textContent = pending;
    this.keysNode.hidden = !pending;
    const box = this.visibleBox();
    const toolbar = this.promptToolbarRow();
    const hasPanel = cm.panel.childElementCount > 0;
    // The command line takes over the indicator's spot while it is open.
    this.indicator.hidden = hasPanel || (!label && !pending);
    if (!this.indicator.hidden) {
      const height = this.indicator.offsetHeight || 14;
      const right = toolbar ? toolbar.right : box.right - 6;
      const bottom = toolbar ? toolbar.centerY + height / 2 : box.bottom - 4;
      this.indicator.style.right = `${Math.max(4, window.innerWidth - right)}px`;
      this.indicator.style.bottom = `${Math.max(4, window.innerHeight - bottom)}px`;
    }

    this.bar.hidden = !hasPanel;
    if (!hasPanel) return;
    const height = this.bar.offsetHeight || 26;
    if (toolbar) {
      this.bar.style.left = `${toolbar.left}px`;
      this.bar.style.width = `${Math.max(180, toolbar.right - toolbar.left)}px`;
      this.bar.style.top = `${toolbar.centerY - height / 2}px`;
      return;
    }
    const gap = 6;
    const below = box.bottom + gap;
    const top = below + height <= window.innerHeight - 4 ? below : box.top - height - gap;
    this.bar.style.left = `${Math.max(4, box.left)}px`;
    this.bar.style.width = `${Math.max(220, box.right - box.left)}px`;
    this.bar.style.top = `${Math.max(4, top)}px`;
  }

  /**
   * The free stretch of bb's prompt box toolbar row, between the leading
   * controls (attach, model picker) and the trailing buttons (voice, send).
   * The indicator and command line live there so they never cover text.
   */
  private promptToolbarRow(): { left: number; right: number; centerY: number } | null {
    const form = this.cm.host.element.closest("[data-promptbox]");
    if (!form) return null;
    const formRect = form.getBoundingClientRect();
    const middle = (formRect.left + formRect.right) / 2;
    const buttons = Array.from(form.querySelectorAll("button"))
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.bottom > formRect.bottom - 56);
    const trailing = buttons.filter((rect) => rect.left > middle);
    if (trailing.length === 0) return null;
    const firstTrailing = trailing.reduce((a, b) => (b.left < a.left ? b : a));
    const leading = buttons.filter((rect) => rect.right <= middle);
    const leadingEnd = leading.reduce((end, rect) => Math.max(end, rect.right), formRect.left + 8);
    return {
      left: leadingEnd + 12,
      right: firstTrailing.left - 10,
      centerY: (firstTrailing.top + firstTrailing.bottom) / 2,
    };
  }

  /** The editor's on-screen box, clipped to the container that scrolls it. */
  private visibleBox(): { left: number; top: number; right: number; bottom: number } {
    const { host } = this.cm;
    const rect = host.element.getBoundingClientRect();
    const scroller = host.scrollElement();
    if (scroller === host.element || scroller === document.scrollingElement) return rect;
    const clip = scroller.getBoundingClientRect();
    return {
      left: Math.max(rect.left, clip.left),
      top: Math.max(rect.top, clip.top),
      right: Math.min(rect.right, clip.right),
      bottom: Math.min(rect.bottom, clip.bottom),
    };
  }

  private renderCursors(blockCursor: boolean): void {
    const { cm } = this;
    const vim = vimState(cm);
    const pieces: HTMLDivElement[] = [];
    if (blockCursor && vim) {
      const text = cm.getValue();
      const selections = cm.listSelections();
      selections.forEach((selection, index) => {
        if (vim.visualBlock && index !== selections.length - 1) return;
        let head = cm.indexFromPos(selection.head);
        const anchor = cm.indexFromPos(selection.anchor);
        if (anchor < head && text[head] !== "\n") head--;
        const piece = this.cursorPiece(head, text, vim.status ? 0.5 : cm.state.overwrite ? 0.2 : 1);
        if (piece) pieces.push(piece);
      });
    }
    this.cursorLayer.replaceChildren(...pieces);
  }

  private cursorPiece(offset: number, text: string, heightRatio: number): HTMLDivElement | null {
    const host = this.cm.host;
    const coords = host.coordsAt(offset);
    if (!coords) return null;
    const bounds = host.scrollElement().getBoundingClientRect();
    const height = coords.bottom - coords.top;
    if (coords.bottom < bounds.top || coords.top > bounds.bottom) return null;
    let width = coords.right - coords.left;
    const char = text[offset];
    if (!char || char === "\n" || char === "\t" || width < 2) {
      width = Math.max(width, parseFloat(getComputedStyle(host.element).fontSize) * 0.6 || 8);
    }
    const piece = document.createElement("div");
    piece.className = "bb-vim-cursor";
    piece.style.left = `${coords.left}px`;
    piece.style.top = `${coords.top + height * (1 - heightRatio)}px`;
    piece.style.width = `${width}px`;
    piece.style.height = `${height * heightRatio}px`;
    return piece;
  }

  destroy(): void {
    this.hide();
  }
}
