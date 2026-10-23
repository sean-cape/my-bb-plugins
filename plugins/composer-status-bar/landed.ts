import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Landed } from "./contract.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    // merge-tree exits 1 on a conflict but still prints the tree it wrote.
    return { ok: false, out: String((error as { stdout?: unknown }).stdout ?? "").trim() };
  }
}

/** Merging HEAD into `ref` changes nothing exactly when HEAD's work is already there, whatever commits carried it. */
async function mergedInto(cwd: string, ref: string): Promise<{ landed: boolean; files: number; conflicts: boolean } | null> {
  const target = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
  if (!target.ok) return null;
  const merge = await git(cwd, ["merge-tree", "--write-tree", "--no-messages", ref, "HEAD"]);
  const tree = merge.out.split("\n")[0] ?? "";
  if (tree === "") return null;
  if (merge.ok && tree === target.out) return { landed: true, files: 0, conflicts: false };
  const changed = await git(cwd, ["diff", "--name-only", target.out, tree]);
  return { landed: false, files: changed.out === "" ? 0 : changed.out.split("\n").length, conflicts: !merge.ok };
}

/** Where the checkout at `cwd` stands against `base` and its upstream, by content: see `landedSchema`. */
export async function landedStatus(cwd: string, base: string): Promise<Landed> {
  const [head, mergeBase] = await Promise.all([git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["merge-base", base, "HEAD"])]);
  if (!head.ok || !mergeBase.ok || head.out === mergeBase.out) return { state: "none" };
  const local = await mergedInto(cwd, base);
  if (local === null) return { state: "none" };
  if (!local.landed) return { state: "unlanded", base, files: local.files, conflicts: local.conflicts };
  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", `${base}@{upstream}`]);
  if (!upstream.ok || upstream.out === "") return { state: "landed", base, pushed: null };
  const remote = await mergedInto(cwd, upstream.out);
  return { state: "landed", base, pushed: remote?.landed ?? null };
}
