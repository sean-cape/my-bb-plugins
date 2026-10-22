// A relative path rather than the `bb-vim-keys` package: this library is bundled by other plugins, so a bare import
// here would resolve from the wrong node_modules. The diff-view plugin still depends on `bb-vim-keys`, so bb's Tailwind
// pass scans the classes of the library's components it renders.
export {
  focusRow,
  focusWhenShown,
  KeyHelp,
  type Keymap,
  runListMotion,
  runListScroll,
  useKeyHandler,
  useKeyScope,
  usePickerKeys,
  useSearchBoxKeys,
  textRanges,
  createSearchHighlights,
  useMenuKeys,
} from "../../../../vim-mode/lib/react.ts";
