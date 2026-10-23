/**
 * What of one file changed since the point new code counts from: whether the file did at all (a binary file has no
 * lines to name), its new-side lines that did, that point's name, and whether the rest folds away ("Only new").
 */
export interface NewSince {
  changed: boolean;
  ranges: Array<[number, number]>;
  /** "r2", "your last GitHub review", "you last looked". */
  label: string;
  only: boolean;
}

export const NOTHING_NEW: NewSince = { changed: false, ranges: [], label: "", only: false };
