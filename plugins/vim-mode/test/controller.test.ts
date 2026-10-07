import { EditorView } from "@codemirror/view";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_OPTIONS, mountVimMode } from "../src/vim/controller";
import { installLayoutStubs } from "./harness";

installLayoutStubs();
// jsdom has no requestAnimationFrame-driven layout; render synchronously enough for assertions.
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as never;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.replaceChildren();
});

function mount() {
  const reports: string[] = [];
  const dispose = mountVimMode(() => DEFAULT_OPTIONS, (level, message) => reports.push(`${level}: ${message}`));
  cleanups.push(dispose);
  return reports;
}

function promptBox(text: string): Editor {
  const form = document.createElement("form");
  form.setAttribute("data-promptbox", "");
  document.body.appendChild(form);
  return new Editor({ element: form, extensions: [StarterKit], content: `<p>${text}</p>` });
}

function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function isNormalMode(element: HTMLElement): boolean {
  return press(element, "l").defaultPrevented;
}

test("attaches to a new editor after bb destroys the previous prompt box", () => {
  const reports = mount();
  const first = promptBox("first");
  first.view.dom.focus();
  press(first.view.dom, "Escape");
  expect(isNormalMode(first.view.dom)).toBe(true);

  // Navigating to another thread unmounts the old editor.
  first.destroy();
  first.options.element && (first.options.element as HTMLElement).remove();

  const second = promptBox("second");
  second.view.dom.focus();
  press(second.view.dom, "Escape");
  expect(isNormalMode(second.view.dom)).toBe(true);
  expect(reports.filter((line) => line.startsWith("error"))).toEqual([]);
});

test("attaches to a CodeMirror editor after a prompt box was destroyed", () => {
  const reports = mount();
  const prompt = promptBox("prompt");
  prompt.view.dom.focus();
  prompt.destroy();

  const view = new EditorView({ doc: "a note", parent: document.body });
  view.contentDOM.focus();
  press(view.contentDOM, "Escape");
  expect(isNormalMode(view.contentDOM)).toBe(true);
  expect(reports.filter((line) => line.startsWith("error"))).toEqual([]);
  expect(reports.some((line) => line.includes("attach codemirror"))).toBe(true);
});

test("a key in an editor whose focus event was missed still attaches", () => {
  mount();
  const prompt = promptBox("text");
  // Simulate focus that arrived without a focusin event reaching the plugin.
  const stop = (event: Event) => event.stopImmediatePropagation();
  document.addEventListener("focusin", stop, true);
  window.addEventListener("focusin", stop, true);
  prompt.view.dom.focus();
  document.removeEventListener("focusin", stop, true);
  window.removeEventListener("focusin", stop, true);
  press(prompt.view.dom, "Escape");
  expect(isNormalMode(prompt.view.dom)).toBe(true);
});
