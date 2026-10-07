import { EditorView } from "@codemirror/view";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Pos, Vim, VimEditor } from "../src/vim/adapter";
import { CodeMirrorHost, codeMirrorViewFor } from "../src/vim/codemirror-host";
import type { TextHost } from "../src/vim/host";
import { handleVimKey } from "../src/vim/keys";
import { ProseMirrorHost, type TiptapEditorLike } from "../src/vim/prosemirror-host";
import { TextFieldHost } from "../src/vim/text-field-host";

export type HostKind = "textarea" | "prosemirror-paragraphs" | "prosemirror-breaks" | "codemirror";

// jsdom has no layout; geometry-dependent motions degrade to no-ops.
export function installLayoutStubs(): void {
  const empty = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = function () {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = empty;
  if (!document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
}

function proseMirrorContent(value: string, kind: HostKind): JSONContent {
  const lines = value.split("\n");
  const inline = (line: string): JSONContent[] => (line ? [{ type: "text", text: line }] : []);
  if (kind === "prosemirror-paragraphs") {
    return { type: "doc", content: lines.map((line) => ({ type: "paragraph", content: inline(line) })) };
  }
  const content: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...inline(line));
  });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function createHost(kind: HostKind, place: HTMLElement, value: string): TextHost {
  if (kind === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    place.appendChild(textarea);
    textarea.setSelectionRange(0, 0);
    return new TextFieldHost(textarea);
  }
  if (kind === "codemirror") {
    const view = new EditorView({ doc: value, parent: place });
    const content = view.contentDOM as HTMLElement & { _handleInputEventForTest?: (text: string) => void };
    content._handleInputEventForTest = (text: string) => view.dispatch(view.state.replaceSelection(text));
    // Reach the view through the DOM, as the plugin does for other bundles' editors.
    return new CodeMirrorHost(codeMirrorViewFor(view.contentDOM)!);
  }
  const mount = document.createElement("div");
  place.appendChild(mount);
  const editor = new Editor({
    element: mount,
    extensions: [StarterKit],
    content: proseMirrorContent(value, kind),
  });
  const dom = editor.view.dom as HTMLElement & { _handleInputEventForTest?: (text: string) => void };
  dom._handleInputEventForTest = (text: string) => {
    editor.view.dispatch(editor.view.state.tr.insertText(text));
  };
  return new ProseMirrorHost(editor as unknown as TiptapEditorLike);
}

// The suite's own Backspace/Delete emulation is a no-op for collapsed
// selections, so the browser's default deletion is reproduced here.
function emulateDeletion(event: KeyboardEvent, host: TextHost): void {
  if (event.defaultPrevented || (event.key !== "Backspace" && event.key !== "Delete")) return;
  let { anchor: start, head: end } = host.selection();
  if (start > end) [start, end] = [end, start];
  if (start === end) {
    if (event.key === "Backspace") start = Math.max(0, start - 1);
    else end = Math.min(host.text().length, end + 1);
  }
  if (start === end) return;
  event.preventDefault();
  if (host.element instanceof HTMLTextAreaElement) {
    host.element.setRangeText("", start, end, "end");
    host.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    host.replace(start, end, "");
  }
}

/** The `CodeMirror(place, options)` factory the shared vim test suite expects. */
export function codeMirrorFactory(kind: HostKind) {
  const factory = function (place: HTMLElement, options: Record<string, unknown>) {
    const wrapper = document.createElement("div");
    place.appendChild(wrapper);
    const host = createHost(kind, wrapper, String(options.value ?? ""));
    const cm = new VimEditor(host);
    for (const name of ["indentUnit", "indentWithTabs", "tabSize", "textwidth"]) {
      if (name in options) cm.options[name] = options[name];
    }
    wrapper.appendChild(cm.panel);
    cm.getWrapperElement = () => wrapper;
    // Capture on the wrapper, like the plugin's window-level listener, so
    // vim sees keys before the editor's own keymap.
    wrapper.addEventListener(
      "keydown",
      (event) => {
        if (event.target === host.element) handleVimKey(cm, event);
      },
      true,
    );
    host.element.addEventListener("keydown", (event) => emulateDeletion(event, host));
    Vim.enterVimMode(cm as never);
    return cm;
  } as unknown as ((place: HTMLElement, options: Record<string, unknown>) => VimEditor) & Record<string, unknown>;
  factory.Vim = Vim;
  factory.Pos = Pos;
  factory.commands = VimEditor.commands;
  factory.version = "6.0.0";
  factory.on = VimEditor.on;
  factory.off = VimEditor.off;
  Object.defineProperty(factory, "isMac", {
    get: () => VimEditor.isMac,
    set: (value: boolean) => {
      VimEditor.isMac = value;
    },
  });
  return factory;
}
