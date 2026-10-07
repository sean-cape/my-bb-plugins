import { initVim, type CodeMirrorConstructor } from "@replit/codemirror-vim-core";
import type { TextHost } from "./host";
import { StringStream } from "./string-stream";
import { Change, diffText, MapMode, TextDoc } from "./text";

// Structural port of @replit/codemirror-vim's CodeMirror 6 adapter onto a
// plain-text TextHost. Method semantics (selection mapping, operation and
// change bookkeeping) follow that adapter so the shared vim engine behaves
// the same way it does in CodeMirror.

export class Pos {
  constructor(
    public line: number,
    public ch: number,
  ) {}
}

interface PosLike {
  line: number;
  ch: number;
}

interface Range {
  anchor: number;
  head: number;
}

interface ChangeSpec {
  from: number;
  to: number;
  insert: string;
}

type Handler = (...args: any[]) => void;
type PositionMapper = (pos: number, assoc: number) => number;

interface ChangeRecord {
  text: string[];
  next?: ChangeRecord;
}

interface Operation {
  $d: number;
  isVimOp?: boolean;
  cursorActivityHandlers?: Handler[];
  cursorActivity?: boolean;
  lastChange?: ChangeRecord;
  change?: ChangeRecord;
  changeHandlers?: Handler[];
  $changeStart?: number;
}

const INDENT_UNIT = "  ";
const UNDO_LIMIT = 200;
const TAB_SIZE = 4;

let wordChar: RegExp;
try {
  wordChar = new RegExp("[\\w\\p{Alphabetic}\\p{Number}_]", "u");
} catch {
  wordChar = /\w/;
}

function on(emitter: any, type: string, f: Handler): void {
  if (emitter.addEventListener) {
    emitter.addEventListener(type, f, false);
    return;
  }
  const map = emitter._handlers || (emitter._handlers = {});
  map[type] = (map[type] || []).concat(f);
}

function off(emitter: any, type: string, f: Handler): void {
  if (emitter.removeEventListener) {
    emitter.removeEventListener(type, f, false);
    return;
  }
  const handlers: Handler[] | undefined = emitter._handlers?.[type];
  if (!handlers) return;
  const index = handlers.indexOf(f);
  if (index > -1) emitter._handlers[type] = handlers.slice(0, index).concat(handlers.slice(index + 1));
}

function signal(emitter: any, type: string, ...args: unknown[]): void {
  const handlers: Handler[] | undefined = emitter._handlers?.[type];
  if (!handlers) return;
  for (const handler of handlers.slice()) handler(...args);
}

function signalTo(handlers: Handler[] | undefined, ...args: unknown[]): void {
  if (!handlers) return;
  for (const handler of handlers) handler(...args);
}

function mapRange(range: Range, map: PositionMapper): Range {
  if (range.anchor === range.head) {
    const pos = map(range.anchor, -1);
    return { anchor: pos, head: pos };
  }
  const forward = range.head > range.anchor;
  const from = map(Math.min(range.anchor, range.head), 1);
  const to = map(Math.max(range.anchor, range.head), -1);
  return forward ? { anchor: from, head: to } : { anchor: to, head: from };
}

class Marker {
  readonly id: number;

  constructor(
    readonly cm: VimEditor,
    public offset: number | null,
    readonly assoc: number,
  ) {
    this.id = cm.$mid++;
    cm.marks[this.id] = this;
  }

  clear(): void {
    delete this.cm.marks[this.id];
  }

  find(): Pos | null {
    return this.offset == null ? null : this.cm.posFromIndex(this.offset);
  }

  update(change: Change): void {
    if (this.offset != null) this.offset = change.mapPos(this.offset, this.assoc, MapMode.TrackDel);
  }
}

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")>",
  ")": "(<",
  "[": "]>",
  "]": "[<",
  "{": "}>",
  "}": "{<",
  "<": ">>",
  ">": "<<",
};

export class VimEditor {
  static isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  static Pos = Pos;
  static StringStream = StringStream;
  static commands: Record<string, ((cm: VimEditor) => void) | undefined> = {
    toggleLineComment: () => {},
    cursorCharLeft: (cm) => cm.moveH(-1, "char"),
    redo: (cm) => cm.runHistoryCommand(false),
    undo: (cm) => cm.runHistoryCommand(true),
    newlineAndIndent: (cm) => {
      const cursor = cm.getCursor();
      const indent = /^\s*/.exec(cm.getLine(cursor.line).slice(0, cursor.ch))![0];
      cm.replaceSelection("\n" + indent);
    },
    indentAuto: () => {},
    newlineAndIndentContinueComment: undefined,
    save: undefined,
  };
  static keys: Record<string, (cm: VimEditor) => void> = {
    Left: (cm) => cm.moveH(-1, "char"),
    Right: (cm) => cm.moveH(1, "char"),
    Up: (cm) => cm.moveV(-1),
    Down: (cm) => cm.moveV(1),
    Backspace: (cm) => cm.deleteH(-1),
    Delete: (cm) => cm.deleteH(1),
  };
  static isWordChar = (ch: string) => wordChar.test(ch);
  static addClass = () => {};
  static rmClass = () => {};
  static e_preventDefault = (e: Event) => e.preventDefault();
  static e_stop = (e?: Event) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
  };
  static lookupKey = (key: string, _map: string, handle: (fn: (cm: VimEditor) => void) => void) => {
    let result = VimEditor.keys[key];
    if (!result && /^Arrow/.test(key)) result = VimEditor.keys[key.slice(5)];
    if (result) handle(result);
  };
  static on = on;
  static off = off;
  static signal = signal;
  static findMatchingTag = () => null;
  static findEnclosingTag = () => undefined;
  static keyName = undefined;

  state: Record<string, any> = {};
  marks: Record<number, Marker> = Object.create(null);
  $mid = 0;
  options: Record<string, unknown> = {};
  _handlers: Record<string, Handler[]> = {};
  $lastChangeEndOffset = 0;
  $lineHandleChanges: Change[] | undefined;
  curOp: Operation | null = null;
  virtualSelection: { ranges: Range[]; primary: number } | null = null;
  readonly cm6 = undefined;
  /** Hosts dialogs (`:`/`/` prompts) and notifications; the UI decides where it lives. */
  readonly panel: HTMLElement;

  private doc: TextDoc;
  private docKey: unknown;
  private hostSelection: Range;
  private ranges: Range[] | null = null;
  private primary = 0;
  private applying = false;
  // Vim undo granularity: one entry per normal-mode command, where an insert
  // session belongs to the command that started it. Entries hold the text
  // before the group's first change.
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private commandOpen = false;
  private restoring = false;
  private readonly unsubscribe: () => void;

  constructor(readonly host: TextHost) {
    this.doc = new TextDoc(host.text());
    this.docKey = host.docKey();
    this.hostSelection = host.selection();
    this.panel = document.createElement("div");
    this.panel.className = "bb-vim-panel";
    this.unsubscribe = host.subscribe(() => {
      try {
        this.sync();
      } catch (error) {
        console.error("[vim-mode]", error);
      }
    });
  }

  /** True while the adapter itself is writing to the host. */
  get isApplying(): boolean {
    return this.applying;
  }

  /** Reconciles with edits and selection moves the host made on its own. */
  sync(): void {
    if (this.applying) return;
    const key = this.host.docKey();
    const selection = this.host.selection();
    let change: Change | null = null;
    if (key !== this.docKey) {
      const text = this.host.text();
      this.recordUndo(this.doc.text);
      change = diffText(this.doc.text, text, selection.head);
      this.doc = new TextDoc(text);
      this.docKey = key;
    }
    const selectionChanged =
      selection.anchor !== this.hostSelection.anchor || selection.head !== this.hostSelection.head;
    this.hostSelection = selection;
    if (!change && !selectionChanged) return;
    if (this.ranges && change && this.state.vim?.insertMode) {
      this.replicateToSecondaryCursors(change);
      return;
    }
    if (this.ranges && change) {
      const mapper = change;
      this.ranges = this.ranges.map((range) => mapRange(range, (pos, assoc) => mapper.mapPos(pos, assoc)!));
    }
    if (this.ranges) {
      const primary = this.ranges[this.primary];
      if (!primary || primary.anchor !== selection.anchor || primary.head !== selection.head) {
        this.ranges = null;
        this.primary = 0;
      }
    }
    this.afterUpdate(change ? [change] : [], selectionChanged);
  }

  /**
   * Hosts have one native caret, so text typed during a multi-cursor insert
   * (visual block `I`, `A`, `c`) lands at the primary cursor only. The same
   * edit is repeated at every other cursor, as CodeMirror would.
   */
  private replicateToSecondaryCursors(change: Change): void {
    const ranges = this.ranges!;
    const primary = ranges[this.primary]!;
    const before = change.from - primary.head;
    const after = change.to - primary.head;
    const secondary = ranges
      .map((range, index) => ({ index, at: change.mapPos(range.head, -1)! }))
      .filter((cursor) => cursor.index !== this.primary);
    const specs = secondary
      .map((cursor) => ({ from: cursor.at + before, to: cursor.at + after, insert: change.insert }))
      .filter((spec) => spec.from >= 0 && spec.to <= this.doc.length && spec.from <= spec.to);
    const { changes } = this.applySpecs(specs);
    const map: PositionMapper = (pos, assoc) =>
      changes.reduce((current, next) => next.mapPos(current, assoc)!, pos);
    const next = ranges.map((_, index) => {
      if (index === this.primary) {
        const head = map(this.hostSelection.head, 1);
        return { anchor: head, head };
      }
      const cursor = secondary.find((entry) => entry.index === index)!;
      const head = map(cursor.at + after, 1);
      return { anchor: head, head };
    });
    this.setRanges(next, this.primary);
    this.afterUpdate([change, ...changes], true);
  }

  dispose(): void {
    this.unsubscribe();
    this.removeOverlay();
  }

  // ---------------------------------------------------------------------------
  // Host bridging

  private currentRanges(): Range[] {
    return this.ranges ?? [this.hostSelection];
  }

  private mainRange(): Range {
    return this.currentRanges()[this.primary] ?? this.hostSelection;
  }

  private setRanges(ranges: Range[], primary = 0): void {
    const length = this.doc.length;
    const clamped = ranges.map((range) => ({
      anchor: Math.max(0, Math.min(length, range.anchor)),
      head: Math.max(0, Math.min(length, range.head)),
    }));
    const main = clamped[primary] ?? clamped[0]!;
    this.applying = true;
    try {
      this.host.setSelection(main.anchor, main.head);
    } finally {
      this.applying = false;
    }
    this.hostSelection = this.host.selection();
    if (clamped.length > 1) {
      clamped[primary] = { ...this.hostSelection };
      this.ranges = clamped;
      this.primary = primary;
    } else {
      this.ranges = null;
      this.primary = 0;
    }
  }

  private afterUpdate(changes: Change[], selectionSet: boolean): void {
    for (const change of changes) this.onChange(change);
    if (selectionSet) this.onSelectionChange();
    if (this.curOp && !this.curOp.isVimOp) this.onBeforeEndOperation();
  }

  /**
   * Applies non-overlapping changes expressed against the current text. With
   * no `nextSelection` the existing selection is mapped through the changes,
   * like a CodeMirror transaction without an explicit selection.
   */
  private transact(specs: ChangeSpec[], nextSelection?: (map: PositionMapper) => Range[]): void {
    if (!this.host.isEditable()) return;
    const sorted = specs
      .filter((spec) => spec.from !== spec.to || spec.insert !== "")
      .sort((a, b) => b.from - a.from);
    const previous = this.currentRanges();
    const previousPrimary = this.primary;
    if (sorted.length > 0) this.recordUndo(this.doc.text);
    const { changes, applied } = this.applySpecs(sorted);
    const map: PositionMapper = (pos, assoc) =>
      applied.reduce((current, change) => change.mapPos(current, assoc)!, pos);
    const ranges = nextSelection
      ? nextSelection(map)
      : previous.map((range) => mapRange(range, map));
    this.setRanges(ranges, ranges.length === previous.length ? previousPrimary : 0);
    this.afterUpdate(changes, nextSelection !== undefined);
  }

  /**
   * Writes changes to the host, last first so earlier offsets stay valid.
   * `changes` also carries any drift when the host normalized the result.
   */
  private applySpecs(specs: ChangeSpec[]): { changes: Change[]; applied: Change[] } {
    const sorted = [...specs].sort((a, b) => b.from - a.from);
    const applied: Change[] = [];
    let text = this.doc.text;
    this.applying = true;
    try {
      for (const spec of sorted) {
        const change = new Change(spec.from, spec.to, spec.insert);
        this.host.replace(change.from, change.to, change.insert);
        text = change.apply(text);
        applied.push(change);
      }
    } finally {
      this.applying = false;
    }
    const changes = applied.slice();
    const actual = this.host.text();
    if (actual !== text) {
      const drift = diffText(text, actual);
      if (drift) changes.push(drift);
      text = actual;
    }
    this.doc = new TextDoc(text);
    this.docKey = this.host.docKey();
    return { changes, applied };
  }

  /** Starts a new undo group; called before each key typed outside insert mode. */
  beginCommand(): void {
    this.commandOpen = true;
    this.host.closeHistoryGroup?.();
  }

  private recordUndo(textBefore: string): void {
    if (this.restoring || (!this.commandOpen && this.undoStack.length > 0)) return;
    this.undoStack.push(textBefore);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.commandOpen = false;
  }

  runHistoryCommand(revert: boolean): void {
    if (this.curOp) this.curOp.$changeStart = undefined;
    this.sync();
    const source = revert ? this.undoStack : this.redoStack;
    const target = source.pop();
    if (target === undefined) return;
    (revert ? this.redoStack : this.undoStack).push(this.doc.text);
    this.restoring = true;
    try {
      this.restoreText(target, revert);
    } finally {
      this.restoring = false;
    }
    const changeStart = this.curOp?.$changeStart;
    if (changeStart != null) {
      this.setRanges([{ anchor: changeStart, head: changeStart }]);
      this.afterUpdate([], true);
    }
  }

  // Prefers the host's own history so rich content (mention pills, marks)
  // comes back intact, stepping until the group's starting text is reached.
  private restoreText(target: string, revert: boolean): void {
    if (this.host.nativeHistory) {
      const before = this.doc.text;
      this.applying = true;
      try {
        for (let i = 0; i < UNDO_LIMIT && this.host.text() !== target; i++) {
          if (!(revert ? this.host.undo() : this.host.redo())) break;
        }
      } finally {
        this.applying = false;
      }
      const reached = this.host.text();
      const change = diffText(before, reached);
      this.doc = new TextDoc(reached);
      this.docKey = this.host.docKey();
      this.hostSelection = this.host.selection();
      if (this.ranges) this.ranges = null;
      this.afterUpdate(change ? [change] : [], true);
      if (reached === target) return;
    }
    const change = diffText(this.doc.text, target);
    if (change) this.transact([{ from: change.from, to: change.to, insert: change.insert }]);
  }

  private moveV(direction: number): void {
    const cursor = this.getCursor();
    this.setCursor(cursor.line + direction, cursor.ch);
  }

  private deleteH(direction: number): void {
    const range = this.mainRange();
    if (range.anchor !== range.head) {
      this.replaceSelection("");
      return;
    }
    const from = direction < 0 ? Math.max(0, range.head - 1) : range.head;
    const to = direction < 0 ? range.head : Math.min(this.doc.length, range.head + 1);
    this.transact([{ from, to, insert: "" }], () => [{ anchor: from, head: from }]);
  }

  // ---------------------------------------------------------------------------
  // CodeMirror 5 interface used by the vim engine

  openDialog(template: Node, callback: ((value: string) => void) | undefined, options: any) {
    return openDialog(this, template, callback, options);
  }

  openNotification(template: Node, options?: { bottom?: boolean; duration?: number }) {
    return openNotification(this, template, options);
  }

  on(type: string, f: Handler): void {
    on(this, type, f);
  }

  off(type: string, f: Handler): void {
    off(this, type, f);
  }

  signal(type: string, ...args: unknown[]): void {
    signal(this, type, ...args);
  }

  indexFromPos(pos: PosLike): number {
    let ch = pos.ch;
    let line = pos.line;
    if (line < 0) {
      line = 0;
      ch = 0;
    }
    if (line >= this.doc.lines) {
      line = this.doc.lines - 1;
      ch = Number.MAX_VALUE;
    }
    const info = this.doc.line(line);
    return Math.min(info.from + Math.max(0, ch), info.to);
  }

  posFromIndex(offset: number): Pos {
    const clamped = Math.max(0, Math.min(this.doc.length, offset));
    const line = this.doc.lineIndexAt(clamped);
    return new Pos(line, clamped - this.doc.lineStarts[line]!);
  }

  foldCode(): void {}

  firstLine(): number {
    return 0;
  }

  lastLine(): number {
    return this.doc.lines - 1;
  }

  lineCount(): number {
    return this.doc.lines;
  }

  setCursor(line: number | PosLike, ch?: number): void {
    if (typeof line === "object") {
      ch = line.ch;
      line = line.line;
    }
    const offset = this.indexFromPos({ line, ch: ch || 0 });
    this.setRanges([{ anchor: offset, head: offset }]);
    if (!this.curOp) this.host.scrollIntoView(offset);
    this.afterUpdate([], true);
  }

  getCursor(p?: "head" | "anchor" | "start" | "end"): Pos {
    const range = this.mainRange();
    let offset: number;
    if (p === undefined || p === "head") offset = range.head;
    else if (p === "anchor") offset = range.anchor;
    else if (p === "start") offset = Math.min(range.anchor, range.head);
    else if (p === "end") offset = Math.max(range.anchor, range.head);
    else throw new Error("Invalid cursor type");
    return this.posFromIndex(offset);
  }

  listSelections(): { anchor: Pos; head: Pos }[] {
    return this.currentRanges().map((range) => ({
      anchor: this.posFromIndex(range.anchor),
      head: this.posFromIndex(range.head),
    }));
  }

  setSelections(ranges: { anchor: PosLike; head: PosLike }[], primIndex?: number): void {
    const offsets = ranges.map((range) => ({
      anchor: this.indexFromPos(range.anchor),
      head: this.indexFromPos(range.head),
    }));
    if (offsets.length === 0) return;
    const primary = primIndex !== undefined && primIndex < offsets.length ? primIndex : offsets.length - 1;
    this.setRanges(offsets, primary);
    this.afterUpdate([], true);
  }

  setSelection(anchor: PosLike, head: PosLike, options?: { origin?: string }): void {
    this.setSelections([{ anchor, head }], 0);
    if (options?.origin === "*mouse") this.onBeforeEndOperation();
  }

  getLine(row: number): string {
    if (row < 0 || row >= this.doc.lines) return "";
    return this.doc.line(row).text;
  }

  getLineHandle(row: number): { row: number; index: number } {
    if (!this.$lineHandleChanges) this.$lineHandleChanges = [];
    return { row, index: this.indexFromPos(new Pos(row, 0)) };
  }

  getLineNumber(handle: { index: number }): number | null {
    const updates = this.$lineHandleChanges;
    if (!updates) return null;
    let offset: number | null = handle.index;
    for (const update of updates) {
      offset = update.mapPos(offset, 1, MapMode.TrackAfter);
      if (offset == null) return null;
    }
    const pos = this.posFromIndex(offset);
    return pos.ch === 0 ? pos.line : null;
  }

  releaseLineHandles(): void {
    this.$lineHandleChanges = undefined;
  }

  getRange(s: PosLike, e: PosLike): string {
    return this.doc.text.slice(this.indexFromPos(s), this.indexFromPos(e));
  }

  replaceRange(text: string, s: PosLike, e?: PosLike): void {
    const from = this.indexFromPos(s);
    const to = this.indexFromPos(e ?? s);
    this.transact([{ from: Math.min(from, to), to: Math.max(from, to), insert: text }]);
  }

  replaceSelection(text: string): void {
    const ranges = this.currentRanges();
    this.transact(
      ranges.map((range) => ({
        from: Math.min(range.anchor, range.head),
        to: Math.max(range.anchor, range.head),
        insert: text,
      })),
      (map) =>
        ranges.map((range) => {
          const end = map(Math.max(range.anchor, range.head), 1);
          return { anchor: end, head: end };
        }),
    );
  }

  replaceSelections(replacements: string[]): void {
    this.transact(
      this.currentRanges().map((range, index) => ({
        from: Math.min(range.anchor, range.head),
        to: Math.max(range.anchor, range.head),
        insert: replacements[index] || "",
      })),
    );
  }

  getSelection(): string {
    return this.getSelections().join("\n");
  }

  getSelections(): string[] {
    return this.currentRanges().map((range) =>
      this.doc.text.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)),
    );
  }

  somethingSelected(): boolean {
    return this.currentRanges().some((range) => range.anchor !== range.head);
  }

  getInputField(): HTMLElement {
    return this.host.element;
  }

  clipPos(p: PosLike): Pos {
    let line = p.line;
    let ch = p.ch;
    if (line < 0) {
      line = 0;
      ch = 0;
    }
    if (line >= this.doc.lines) {
      line = this.doc.lines - 1;
      ch = Number.MAX_VALUE;
    }
    const info = this.doc.line(line);
    return new Pos(line, Math.min(Math.max(0, ch), info.to - info.from));
  }

  getValue(): string {
    return this.doc.text;
  }

  setValue(text: string): void {
    this.transact([{ from: 0, to: this.doc.length, insert: text }], () => [{ anchor: 0, head: 0 }]);
  }

  focus(): void {
    this.host.focus();
  }

  blur(): void {
    this.host.element.blur();
  }

  defaultTextHeight(): number {
    return this.host.lineHeight();
  }

  findMatchingBracket(pos: PosLike): { to: Pos | undefined } {
    const bracket = this.getLine(pos.line).charAt(pos.ch);
    const match = BRACKET_PAIRS[bracket];
    if (!match || !/[(){}[\]]/.test(bracket)) return { to: undefined };
    const forward = match.charAt(1) === ">";
    const found = this.scanForBracket(new Pos(pos.line, pos.ch + (forward ? 1 : 0)), forward ? 1 : -1);
    return { to: found && found.ch === match.charAt(0) ? found.pos : undefined };
  }

  scanForBracket(
    where: PosLike,
    dir: 1 | -1,
    _style?: unknown,
    config?: { bracketRegex?: RegExp; maxScanLineLength?: number; maxScanLines?: number },
  ): false | null | { pos: Pos; ch: string } {
    const maxScanLen = config?.maxScanLineLength || 10000;
    const maxScanLines = config?.maxScanLines || 1000;
    const stack: string[] = [];
    const re = config?.bracketRegex || /[(){}[\]]/;
    const lineEnd =
      dir > 0
        ? Math.min(where.line + maxScanLines, this.lastLine() + 1)
        : Math.max(this.firstLine() - 1, where.line - maxScanLines);
    let lineNo = where.line;
    for (; lineNo !== lineEnd; lineNo += dir) {
      const line = this.getLine(lineNo);
      if (!line) continue;
      let pos = dir > 0 ? 0 : line.length - 1;
      const end = dir > 0 ? line.length : -1;
      if (line.length > maxScanLen) continue;
      if (lineNo === where.line) pos = where.ch - (dir < 0 ? 1 : 0);
      for (; pos !== end; pos += dir) {
        const ch = line.charAt(pos);
        if (!re.test(ch)) continue;
        const match = BRACKET_PAIRS[ch];
        if (match && (match.charAt(1) === ">") === dir > 0) stack.push(ch);
        else if (!stack.length) return { pos: new Pos(lineNo, pos), ch };
        else stack.pop();
      }
    }
    return lineNo - dir === (dir > 0 ? this.lastLine() : this.firstLine()) ? false : null;
  }

  indentLine(line: number, more?: boolean): void {
    const text = this.getLine(line);
    const from = this.indexFromPos(new Pos(line, 0));
    if (more) {
      if (text.length === 0) return;
      this.transact([{ from, to: from, insert: INDENT_UNIT }]);
      return;
    }
    const leading = /^[ \t]*/.exec(text)![0];
    let remove = 0;
    if (leading.startsWith("\t")) remove = 1;
    else while (remove < INDENT_UNIT.length && leading[remove] === " ") remove++;
    if (remove > 0) this.transact([{ from, to: from + remove, insert: "" }]);
  }

  execCommand(name: string): void {
    const command = VimEditor.commands[name];
    if (command) {
      command(this);
    } else if (name === "goLineLeft" || name === "goLineRight") {
      this.moveToDisplayLineEdge(name === "goLineRight");
    }
  }

  private moveToDisplayLineEdge(right: boolean): void {
    const head = this.mainRange().head;
    const coords = this.host.coordsAt(head);
    let target: number | null = null;
    if (coords) {
      const y = (coords.top + coords.bottom) / 2;
      target = this.host.offsetAt(right ? Number.MAX_SAFE_INTEGER / 4 : -Number.MAX_SAFE_INTEGER / 4, y);
    }
    if (target == null) {
      const line = this.posFromIndex(head).line;
      const info = this.doc.line(line);
      target = right ? info.to : info.from;
    }
    if (right && target > 0 && target < this.doc.length && this.doc.text[target] !== "\n") {
      const next = this.host.coordsAt(target);
      if (!coords || !next || Math.abs(next.top - coords.top) > 1) target -= 1;
    }
    this.setCursor(this.posFromIndex(target));
  }

  setBookmark(cursor: PosLike, options?: { insertLeft?: boolean }): Marker {
    return new Marker(this, this.indexFromPos(cursor), options?.insertLeft ? 1 : -1);
  }

  addOverlay(_overlay: { query: RegExp }): undefined {
    return undefined;
  }

  removeOverlay(_overlay?: unknown): void {}

  getSearchCursor(query: RegExp, pos: PosLike) {
    const cm = this;
    let last: { from: number; to: number; match: RegExpExecArray } | null = null;
    let lastResult: { from: Pos; to: Pos; match: RegExpExecArray } | null = null;
    let afterEmptyMatch = false;
    const startPos = pos.ch == undefined ? { line: pos.line, ch: Number.MAX_VALUE } : pos;
    const firstOffset = this.indexFromPos(startPos);
    const flags = "gm" + (query.ignoreCase ? "i" : "") + (query.unicode ? "u" : "");
    const regexp = new RegExp(query.source, flags);

    function matchFrom(from: number, text: string) {
      if (from > text.length) return null;
      regexp.lastIndex = from;
      const match = regexp.exec(text);
      if (!match) return null;
      return { from: match.index, to: match.index + match[0].length, match };
    }
    // Like CodeMirror's RegExpCursor: the range is cut at `end`, and an empty
    // match touching the previous match's end is skipped.
    function lastMatchBefore(end: number) {
      const text = cm.doc.text.slice(0, end);
      let found: { from: number; to: number; match: RegExpExecArray } | null = null;
      let from = 0;
      for (;;) {
        const next = matchFrom(from, text);
        if (!next) return found;
        if (next.from < next.to || !found || next.from > found.to) found = next;
        from = next.to > next.from ? next.to : next.from + 1;
      }
    }

    return {
      findNext() {
        return this.find(false);
      },
      findPrevious() {
        return this.find(true);
      },
      find(back?: boolean) {
        if (back) {
          const endAt = last ? (afterEmptyMatch ? last.to - 1 : last.from) : firstOffset;
          last = endAt < 0 ? null : lastMatchBefore(endAt);
        } else {
          const startFrom = last ? (afterEmptyMatch ? last.to + 1 : last.to) : firstOffset;
          last = matchFrom(startFrom, cm.doc.text);
        }
        lastResult = last && {
          from: cm.posFromIndex(last.from),
          to: cm.posFromIndex(last.to),
          match: last.match,
        };
        afterEmptyMatch = last ? last.from === last.to : false;
        return last && last.match;
      },
      from() {
        return lastResult?.from;
      },
      to() {
        return lastResult?.to;
      },
      replace(text: string) {
        if (!last) return;
        const from = last.from;
        const before = cm.doc.text;
        cm.transact([{ from, to: last.to, insert: text }]);
        // A refused edit must still move the cursor past the match, or
        // `:s///g` would find the same match forever.
        if (cm.doc.text === before) return;
        last = { ...last, to: from + text.length };
        if (lastResult) lastResult.to = cm.posFromIndex(last.to);
      },
      get match() {
        return lastResult && lastResult.match;
      },
    };
  }

  findPosV(start: PosLike, amount: number, unit: "page" | "line", goalColumn?: number) {
    const count = Math.round(Math.abs(amount));
    const direction = amount > 0 ? 1 : -1;
    const step = unit === "page" ? this.host.scrollElement().clientHeight : this.host.lineHeight();
    const logical = () => {
      const lines = unit === "page" ? Math.max(1, Math.floor(step / this.host.lineHeight())) : 1;
      const target = start.line + direction * count * lines;
      const pos = this.clipPos(new Pos(target, start.ch)) as Pos & { hitSide?: boolean };
      if (target < 0 || target > this.lastLine()) pos.hitSide = true;
      return pos;
    };
    let offset = this.indexFromPos(start);
    for (let i = 0; i < count; i++) {
      const coords = this.host.coordsAt(offset);
      if (!coords) return logical();
      const x = goalColumn != null ? goalColumn + this.host.contentOrigin().left : coords.left;
      const y = (coords.top + coords.bottom) / 2 + direction * step;
      const next = this.host.offsetAt(x, y);
      const nextCoords = next == null ? null : this.host.coordsAt(next);
      if (next == null || !nextCoords) return logical();
      if (Math.abs(nextCoords.top - coords.top) < 1) {
        const pos = this.posFromIndex(direction > 0 ? this.doc.length : 0) as Pos & { hitSide?: boolean };
        pos.hitSide = true;
        return pos;
      }
      offset = next;
    }
    return this.posFromIndex(offset);
  }

  charCoords(pos: PosLike, _mode?: "div" | "local") {
    const origin = this.host.contentOrigin();
    const coords = this.host.coordsAt(this.indexFromPos(pos));
    return {
      left: (coords?.left ?? origin.left) - origin.left,
      top: (coords?.top ?? origin.top) - origin.top,
      bottom: (coords?.bottom ?? origin.top) - origin.top,
    };
  }

  coordsChar(coords: { left: number; top: number }, _mode?: "div" | "local"): Pos {
    const origin = this.host.contentOrigin();
    const offset = this.host.offsetAt(coords.left + origin.left, coords.top + origin.top);
    return this.posFromIndex(offset ?? 0);
  }

  getScrollInfo() {
    const scroller = this.host.scrollElement();
    return {
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      width: scroller.scrollWidth,
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth,
    };
  }

  scrollTo(x?: number | null, y?: number | null): void {
    const scroller = this.host.scrollElement();
    if (x != null) scroller.scrollLeft = x;
    if (y != null) scroller.scrollTop = y;
  }

  scrollIntoView(pos?: PosLike): void {
    this.host.scrollIntoView(pos ? this.indexFromPos(pos) : this.mainRange().head);
  }

  getWrapperElement(): HTMLElement {
    return this.panel;
  }

  getMode() {
    return { name: this.getOption("mode") };
  }

  setSize(): void {}

  refresh(): void {}

  destroy(): void {
    this.removeOverlay();
  }

  getLastEditEnd(): Pos {
    return this.posFromIndex(this.$lastChangeEndOffset);
  }

  onChange(change: Change): void {
    this.$lineHandleChanges?.push(change);
    for (const id in this.marks) this.marks[id]!.update(change);
    if (this.virtualSelection) {
      this.virtualSelection.ranges = this.virtualSelection.ranges.map((range) =>
        mapRange(range, (pos, assoc) => change.mapPos(pos, assoc)!),
      );
    }
    const curOp = (this.curOp = this.curOp || { $d: 0 });
    change.iterChanges((_fromA, _toA, fromB, toB, text) => {
      if (curOp.$changeStart == null || curOp.$changeStart > fromB) curOp.$changeStart = fromB;
      this.$lastChangeEndOffset = toB;
      const record: ChangeRecord = { text };
      if (!curOp.lastChange) {
        curOp.lastChange = curOp.change = record;
      } else {
        curOp.lastChange.next = curOp.lastChange = record;
      }
    });
    if (!curOp.changeHandlers) curOp.changeHandlers = this._handlers.change?.slice();
  }

  onSelectionChange(): void {
    const curOp = (this.curOp = this.curOp || { $d: 0 });
    if (!curOp.cursorActivityHandlers) {
      curOp.cursorActivityHandlers = this._handlers.cursorActivity?.slice();
    }
    curOp.cursorActivity = true;
  }

  operation<T>(fn: () => T): T {
    if (!this.curOp) this.curOp = { $d: 0 };
    this.curOp.$d++;
    try {
      return fn();
    } finally {
      if (this.curOp) {
        this.curOp.$d--;
        if (!this.curOp.$d) this.onBeforeEndOperation();
      }
    }
  }

  onBeforeEndOperation(): void {
    const op = this.curOp;
    let scrollIntoView = false;
    if (op) {
      if (op.change) signalTo(op.changeHandlers, this, op.change);
      if (op.cursorActivity) {
        signalTo(op.cursorActivityHandlers, this, null);
        if (op.isVimOp) scrollIntoView = true;
      }
      this.curOp = null;
    }
    if (scrollIntoView) this.scrollIntoView();
  }

  moveH(increment: number, unit: string): void {
    if (unit !== "char") return;
    const cursor = this.getCursor();
    this.setCursor(cursor.line, cursor.ch + increment);
  }

  setOption(name: string, value: unknown): void {
    if (name === "keyMap") this.state.keyMap = value;
    else if (name === "textwidth") this.state.textwidth = value;
  }

  getOption(name: string): any {
    if (name in this.options) return this.options[name];
    switch (name) {
      case "firstLineNumber":
        return 1;
      case "tabSize":
        return TAB_SIZE;
      case "readOnly":
        return !this.host.isEditable();
      case "indentWithTabs":
        return false;
      case "indentUnit":
        return INDENT_UNIT.length;
      case "textwidth":
        return this.state.textwidth;
      case "keyMap":
        return this.state.keyMap || "vim";
    }
    return undefined;
  }

  toggleOverwrite(on: boolean): void {
    this.state.overwrite = on;
  }

  getTokenTypeAt(): "" {
    return "";
  }

  overWriteSelection(text: string): void {
    const length = this.doc.length;
    const ranges = this.currentRanges().map((range) => {
      if (range.anchor !== range.head) return range;
      const next = range.head < length ? this.doc.text.slice(range.head, range.head + 1) : "";
      return next && next !== "\n" ? { anchor: range.head, head: range.head + 1 } : range;
    });
    this.setRanges(ranges, this.primary);
    this.replaceSelection(text);
  }

  isInMultiSelectMode(): boolean {
    return this.currentRanges().length > 1;
  }

  virtualSelectionMode(): boolean {
    return !!this.virtualSelection;
  }

  forEachSelection(command: () => void): void {
    const virtual = { ranges: this.currentRanges().slice(), primary: this.primary };
    this.virtualSelection = virtual;
    for (let i = 0; i < virtual.ranges.length; i++) {
      const range = virtual.ranges[i];
      if (!range) continue;
      this.setRanges([range]);
      this.afterUpdate([], true);
      command();
      virtual.ranges[i] = this.currentRanges()[0]!;
    }
    this.setRanges(virtual.ranges, virtual.primary);
    this.afterUpdate([], true);
    this.virtualSelection = null;
  }

  hardWrap(options: { from: number; to: number; column?: number; allowMerge?: boolean }): number {
    return hardWrap(this, options);
  }
}

// -----------------------------------------------------------------------------
// Dialogs and notifications (ported from @replit/codemirror-vim)

function closeNotification(cm: VimEditor, next?: () => void): void {
  cm.state.currentNotificationClose?.();
  cm.state.currentNotificationClose = next;
}

function showDialog(cm: VimEditor, dialog: HTMLElement): void {
  const old: HTMLElement | null | undefined = cm.state.dialog;
  cm.state.dialog = dialog;
  if (old === dialog) return;
  if (old?.contains(document.activeElement)) cm.focus();
  if (old?.parentElement) old.parentElement.replaceChild(dialog, old);
  else {
    old?.remove();
    cm.panel.appendChild(dialog);
  }
  signal(cm, "dialog");
}

function hideDialog(cm: VimEditor, dialog: HTMLElement): void {
  if (cm.state.dialog !== dialog) return;
  cm.state.dialog = null;
  dialog.remove();
  signal(cm, "dialog");
}

function dialogDiv(template: Node, className: string): HTMLElement {
  const dialog = document.createElement("div");
  dialog.className = className;
  dialog.appendChild(template);
  return dialog;
}

function openNotification(
  cm: VimEditor,
  template: Node,
  options?: { bottom?: boolean; duration?: number },
): () => void {
  closeNotification(cm, close);
  const dialog = dialogDiv(template, "bb-vim-notification");
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const duration = options?.duration !== undefined ? options.duration : 5000;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    hideDialog(cm, dialog);
  }
  dialog.onclick = (e) => {
    e.preventDefault();
    close();
  };
  showDialog(cm, dialog);
  if (duration) timer = setTimeout(close, duration);
  return close;
}

function openDialog(
  cm: VimEditor,
  template: Node,
  callback: ((value: string) => void) | undefined,
  options: any = {},
): (newVal?: string) => void {
  closeNotification(cm, undefined);
  const dialog = dialogDiv(template, "bb-vim-dialog");
  let closed = false;
  const input = dialog.getElementsByTagName("input")[0];
  if (input?.parentElement) {
    input.parentElement.classList.add("bb-vim-prompt");
    input.parentElement.nextElementSibling?.classList.add("bb-vim-prompt-hint");
  }
  showDialog(cm, dialog);
  function close(newVal?: string) {
    if (typeof newVal === "string") {
      if (input) input.value = newVal;
      return;
    }
    if (closed) return;
    closed = true;
    hideDialog(cm, dialog);
    if (!cm.state.dialog) cm.focus();
    options.onClose?.(dialog);
  }
  if (input) {
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    if (options.value) {
      input.value = options.value;
      if (options.selectValueOnOpen !== false) input.select();
    }
    if (options.onInput) on(input, "input", (e: Event) => options.onInput(e, input.value, close));
    if (options.onKeyUp) on(input, "keyup", (e: Event) => options.onKeyUp(e, input.value, close));
    on(input, "keydown", (e: KeyboardEvent) => {
      if (options.onKeyDown?.(e, input.value, close)) return;
      if (e.keyCode === 13) callback?.(input.value);
      if (e.keyCode === 27 || (options.closeOnEnter !== false && e.keyCode === 13)) {
        input.blur();
        VimEditor.e_stop(e);
        close();
      }
    });
    if (options.closeOnBlur !== false) {
      on(input, "blur", () => {
        setTimeout(() => {
          if (document.activeElement === input) return;
          close();
        });
      });
    }
    input.focus();
  }
  return close;
}

function hardWrap(
  cm: VimEditor,
  options: { from: number; to: number; column?: number; allowMerge?: boolean },
): number {
  const max = options.column || cm.getOption("textwidth") || 80;
  const allowMerge = options.allowMerge !== false;
  let row = Math.min(options.from, options.to);
  let endRow = Math.max(options.from, options.to);
  while (row <= endRow) {
    const line = cm.getLine(row);
    if (line.length > max) {
      const space = findSpace(line, max, 5);
      if (space) {
        const indentation = /^\s*/.exec(line)?.[0] ?? "";
        cm.replaceRange("\n" + indentation, new Pos(row, space.start), new Pos(row, space.end));
      }
      endRow++;
    } else if (allowMerge && /\S/.test(line) && row !== endRow) {
      const nextLine = cm.getLine(row + 1);
      if (nextLine && /\S/.test(nextLine)) {
        const trimmedLine = line.replace(/\s+$/, "");
        const trimmedNextLine = nextLine.replace(/^\s+/, "");
        const mergedLine = trimmedLine + " " + trimmedNextLine;
        const space = findSpace(mergedLine, max, 5);
        if ((space && space.start > trimmedLine.length) || mergedLine.length < max) {
          cm.replaceRange(
            " ",
            new Pos(row, trimmedLine.length),
            new Pos(row + 1, nextLine.length - trimmedNextLine.length),
          );
          row--;
          endRow--;
        } else if (trimmedLine.length < line.length) {
          cm.replaceRange("", new Pos(row, trimmedLine.length), new Pos(row, line.length));
        }
      }
    }
    row++;
  }
  return row;

  function findSpace(text: string, limit: number, min: number) {
    if (text.length < limit) return undefined;
    const before = text.slice(0, limit);
    const after = text.slice(limit);
    const spaceAfter = /^(?:(\s+)|(\S+)(\s+))/.exec(after);
    const spaceBefore = /(?:(\s+)|(\s+)(\S+))$/.exec(before);
    let start = 0;
    let end = 0;
    if (spaceBefore && !spaceBefore[2]) {
      start = limit - spaceBefore[1]!.length;
      end = limit;
    }
    if (spaceAfter && !spaceAfter[2]) {
      if (!start) start = limit;
      end = limit + spaceAfter[1]!.length;
    }
    if (start) return { start, end };
    if (spaceBefore && spaceBefore[2] && spaceBefore.index > min) {
      return { start: spaceBefore.index, end: spaceBefore.index + spaceBefore[2].length };
    }
    if (spaceAfter && spaceAfter[2]) {
      start = limit + spaceAfter[2].length;
      return { start, end: start + spaceAfter[3]!.length };
    }
    return undefined;
  }
}

export const Vim = initVim(VimEditor as unknown as CodeMirrorConstructor);
export type VimApi = typeof Vim;
