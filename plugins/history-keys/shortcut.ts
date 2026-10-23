import { announceKeyCommand, chordToken } from "bb-vim-keys";

/**
 * Reports a command one of this plugin's shortcuts ran, so the activity log counts the key as this
 * plugin's rather than as a key nothing bound. bb hands `run` no event; `event` is the one being
 * dispatched (`window.event`), and anything but a keydown (the command palette's click) is skipped.
 */
export function announceShortcut(doc: Document, event: Event | undefined): void {
  if (!(event instanceof KeyboardEvent) || event.type !== "keydown") return;
  const keys = chordToken(event);
  if (keys !== null) announceKeyCommand(doc, { keys, count: null, event });
}
