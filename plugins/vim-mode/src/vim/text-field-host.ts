import type { TextHost } from "./host";

export type TextField = HTMLTextAreaElement | HTMLInputElement;

const MIRRORED_PROPERTIES = [
  "direction",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "fontFeatureSettings",
  "fontKerning",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "wordBreak",
] as const;

// Measures character geometry, which text fields do not expose, by laying the
// value out in an invisible clone with the same box and typography.
class Mirror {
  private readonly root: HTMLDivElement;
  private readonly node: Text;
  private key = "";

  constructor(private readonly field: TextField) {
    this.root = document.createElement("div");
    this.root.setAttribute("aria-hidden", "true");
    this.root.dataset.bbVimUi = "";
    this.node = document.createTextNode("");
    this.root.appendChild(this.node);
  }

  private update(): void {
    const field = this.field;
    const style = getComputedStyle(field);
    const isInput = field instanceof HTMLInputElement;
    const width =
      field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const key = [
      field.value,
      width,
      style.font,
      style.lineHeight,
      style.letterSpacing,
      style.paddingTop,
      style.paddingLeft,
    ].join("\u0000");
    if (key === this.key && this.root.isConnected) return;
    this.key = key;
    const target = this.root.style;
    for (const property of MIRRORED_PROPERTIES) target[property] = style[property];
    target.position = "absolute";
    target.visibility = "hidden";
    target.pointerEvents = "none";
    target.top = "0";
    target.left = "-100000px";
    target.overflow = "hidden";
    target.boxSizing = "content-box";
    target.width = `${Math.max(0, width)}px`;
    target.height = "auto";
    target.whiteSpace = isInput ? "pre" : "pre-wrap";
    target.overflowWrap = isInput ? "normal" : "break-word";
    // The zero-width sentinel gives the end-of-text caret a measurable box.
    this.node.data = field.value + "​";
    if (!this.root.isConnected) document.body.appendChild(this.root);
  }

  /** Character box relative to the field's border box, ignoring scroll. */
  rect(offset: number): { left: number; right: number; top: number; bottom: number } | null {
    this.update();
    const length = this.node.data.length - 1;
    const at = Math.max(0, Math.min(length, offset));
    const range = document.createRange();
    range.setStart(this.node, at);
    range.setEnd(this.node, at + 1);
    const rects = Array.from(range.getClientRects());
    const box = rects.findLast((rect) => rect.width > 0) ?? rects.at(-1) ?? range.getBoundingClientRect();
    if (box.bottom <= box.top) return null;
    const origin = this.root.getBoundingClientRect();
    return {
      left: box.left - origin.left,
      right: Math.max(box.right, box.left + 1) - origin.left,
      top: box.top - origin.top,
      bottom: box.bottom - origin.top,
    };
  }

  destroy(): void {
    this.root.remove();
  }
}

export class TextFieldHost implements TextHost {
  readonly kind = "text-field";
  // Native text-field undo steps per execCommand, which is finer than vim's
  // per-command undo, so the adapter keeps its own history.
  readonly nativeHistory = false;
  private readonly mirror: Mirror;

  constructor(readonly element: TextField) {
    this.mirror = new Mirror(element);
  }

  docKey(): unknown {
    return this.element.value;
  }

  text(): string {
    return this.element.value;
  }

  selection(): { anchor: number; head: number } {
    const field = this.element;
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    return field.selectionDirection === "backward"
      ? { anchor: end, head: start }
      : { anchor: start, head: end };
  }

  setSelection(anchor: number, head: number): void {
    this.element.setSelectionRange(
      Math.min(anchor, head),
      Math.max(anchor, head),
      head < anchor ? "backward" : "forward",
    );
  }

  replace(from: number, to: number, insert: string): void {
    if (from === to && insert === "") return;
    const field = this.element;
    const before = field.value;
    const expected = before.slice(0, from) + insert + before.slice(to);
    field.setSelectionRange(from, to);
    // execCommand keeps the edit on the native undo stack and notifies
    // framework-controlled inputs the same way typing does.
    if (document.activeElement === field && typeof document.execCommand === "function") {
      try {
        if (insert === "") document.execCommand("delete", false);
        else document.execCommand("insertText", false, insert);
      } catch {
        // Fall through to the direct edit below.
      }
    }
    if (field.value !== before || field.value === expected) return;
    field.setRangeText(insert, from, to, "end");
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: insert === "" ? "deleteContent" : "insertText",
        data: insert === "" ? null : insert,
      }),
    );
  }

  undo(): boolean {
    return this.runNativeCommand("undo");
  }

  redo(): boolean {
    return this.runNativeCommand("redo");
  }

  private runNativeCommand(command: "undo" | "redo"): boolean {
    if (typeof document.execCommand !== "function") return false;
    try {
      return document.execCommand(command, false);
    } catch {
      return false;
    }
  }

  isEditable(): boolean {
    return !this.element.readOnly && !this.element.disabled;
  }

  focus(): void {
    this.element.focus();
  }

  private borderBoxOrigin(): { left: number; top: number } {
    const rect = this.element.getBoundingClientRect();
    return {
      left: rect.left - this.element.scrollLeft,
      top: rect.top - this.element.scrollTop,
    };
  }

  coordsAt(offset: number) {
    const box = this.mirror.rect(offset);
    if (!box) return null;
    const origin = this.borderBoxOrigin();
    return {
      left: origin.left + box.left,
      right: origin.left + box.right,
      top: origin.top + box.top,
      bottom: origin.top + box.bottom,
    };
  }

  offsetAt(x: number, y: number): number | null {
    const length = this.element.value.length;
    if (!this.coordsAt(0)) return null;
    const isAfter = (offset: number) => {
      const box = this.coordsAt(offset);
      if (!box) return true;
      if (box.top > y) return true;
      if (box.bottom <= y) return false;
      return (box.left + box.right) / 2 > x;
    };
    let low = 0;
    let high = length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (isAfter(mid)) high = mid;
      else low = mid + 1;
    }
    const landed = this.coordsAt(low);
    if (low > 0 && landed && landed.top > y) {
      const previous = this.coordsAt(low - 1);
      if (previous && previous.top <= y && previous.bottom > y) return low - 1;
    }
    return low;
  }

  contentOrigin(): { left: number; top: number } {
    const style = getComputedStyle(this.element);
    const origin = this.borderBoxOrigin();
    return {
      left: origin.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      top: origin.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
    };
  }

  scrollElement(): HTMLElement {
    return this.element;
  }

  scrollIntoView(offset: number): void {
    const field = this.element;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    const box = this.coordsAt(offset);
    if (!box) return;
    const top = rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const bottom = rect.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    if (box.top < top) field.scrollTop -= top - box.top;
    else if (box.bottom > bottom) field.scrollTop += box.bottom - bottom;
    const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    if (box.left < left) field.scrollLeft -= left - box.left;
    else if (box.right > right) field.scrollLeft += box.right - right;
  }

  lineHeight(): number {
    const style = getComputedStyle(this.element);
    const lineHeight = parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight)) return lineHeight;
    const fontSize = parseFloat(style.fontSize);
    return Number.isFinite(fontSize) ? fontSize * 1.2 : 16;
  }

  subscribe(listener: () => void): () => void {
    const field = this.element;
    const onSelectionChange = () => {
      if (document.activeElement === field) listener();
    };
    const fieldEvents = ["input", "select", "keyup", "mouseup", "selectionchange"] as const;
    for (const type of fieldEvents) field.addEventListener(type, listener);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      for (const type of fieldEvents) field.removeEventListener(type, listener);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }

  destroy(): void {
    this.mirror.destroy();
  }
}
