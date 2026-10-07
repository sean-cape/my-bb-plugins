import { describe, test } from "vitest";
// @ts-expect-error The shared suite ships as untyped JavaScript.
import { vimTests } from "@replit/codemirror-vim-core/test/vim_test.js";
import { codeMirrorFactory, installLayoutStubs, type HostKind } from "./harness";

// Tests that depend on capabilities a prompt box does not have.
const UNSUPPORTED = new Set([
  // Code folding.
  "vim_j_with_folding",
  "vim_k_with_folding",
  // A language syntax tree: string/comment tokens, tags, comments, indentation.
  "vim_%_seek_skip",
  "vim_%_skip_string",
  "vim_%_skip_comment",
  'vim_ci" for two strings',
  "vim_dat_open_tag",
  "vim_dat_inside_tag",
  "vim_dat_close_tag",
  "vim_dit_open_tag",
  "vim_dit_inside_tag",
  "vim_dit_close_tag",
  "vim_gcc",
  "vim_=",
  "vim_s_visual_block",
  "vim_._insert_o_indent",
  "vim_ex_set_filetype",
  "vim_ex_set_filetype_null",
  // Real layout, which jsdom does not compute.
  "vim_gj_gk_clipping",
  "vim_j_k_and_gj_gk",
  "vim_gj_gk",
  "vim_g0_g$",
  "vim_page_motions",
  "vim_HML",
  "vim_zb<zz",
  "vim_zz<zt",
  "vim_scrollMotion",
  // Browser-default caret movement and Tab insertion inside insert mode.
  "vim_._insert",
  "vim_r_visual_block",
  "vim_><visualblock",
  // CodeMirror's own copy handling for Ctrl-C on non-Mac platforms.
  "vim_<C-c>copy",
  // Multi-cursor insert-mode mapping (`jj` with visual block `c`).
  "vim_ex_imap",
]);

// jsdom's DOM selection lags CodeMirror's after the harness's emulated Delete
// key, and CodeMirror re-reads it; real browsers keep them in sync.
const UNSUPPORTED_BY_HOST: Partial<Record<HostKind, Set<string>>> = {
  codemirror: new Set(["vim_i_forward_delete"]),
};

installLayoutStubs();
const place = document.createElement("div");
place.id = "testground";
document.body.appendChild(place);

const kind = (process.env.VIM_HOST as HostKind | undefined) ?? "textarea";

describe(`vim suite (${kind})`, () => {
  vimTests(codeMirrorFactory(kind), (name: string, run: () => Promise<void>) => {
    const skip = UNSUPPORTED.has(name) || UNSUPPORTED_BY_HOST[kind]?.has(name);
    (skip ? test.skip : test)(name, run);
  });
});
