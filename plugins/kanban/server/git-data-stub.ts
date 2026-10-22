import { vi } from "vitest";

/**
 * A pull request's head repository as GitHub's git data API serves it: a branch, commits, trees and blobs, with every
 * write recorded. The PR lives in `acme/widgets`; its head branch in a fork, or nowhere when `headRepo` is null.
 * Files are text, or bytes; `modes` gives a top-level entry's mode (run.sh is executable by default).
 */
export function stubGitData(files: Record<string, string | Uint8Array>, { headRepo = "fork/widgets", modes = {} }: { headRepo?: string | null; modes?: Record<string, string> } = {}) {
  let nextSha = 0;
  const sha = () => `sha${++nextSha}`;
  const blobs = new Map<string, string | Uint8Array>();
  const trees = new Map<string, Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string }>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const writeTree = (entries: Record<string, string | Uint8Array>): string => {
    const byDir = new Map<string, Record<string, string | Uint8Array>>();
    const tree: Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string }> = [];
    for (const [path, text] of Object.entries(entries)) {
      const [head, ...rest] = path.split("/");
      if (rest.length > 0) byDir.set(head!, { ...(byDir.get(head!) ?? {}), [rest.join("/")]: text });
      else {
        const blob = sha();
        blobs.set(blob, text);
        tree.push({ path: head!, mode: modes[head!] ?? (head === "run.sh" ? "100755" : "100644"), type: "blob", sha: blob });
      }
    }
    for (const [dir, inner] of byDir) tree.push({ path: dir, mode: "040000", type: "tree", sha: writeTree(inner) });
    const id = sha();
    trees.set(id, tree);
    return id;
  };
  const root = sha();
  commits.set(root, { tree: writeTree(files), parents: [], message: "initial" });
  const refs = new Map([["feature/x", root]]);
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/repos/acme/widgets/pulls/7") return json({ head: { ref: "feature/x", sha: root, repo: headRepo === null ? null : { full_name: headRepo } } });
    const base = "/repos/fork/widgets/git";
    if (method === "GET" && path.startsWith(`${base}/ref/heads/`)) {
      const at = refs.get(path.slice(`${base}/ref/heads/`.length));
      return at === undefined ? json({ message: "Not Found" }, 404) : json({ object: { sha: at } });
    }
    if (method === "GET" && path.startsWith(`${base}/commits/`)) return json({ tree: { sha: commits.get(path.slice(`${base}/commits/`.length))!.tree } });
    if (method === "GET" && path.startsWith(`${base}/trees/`)) return json({ tree: trees.get(path.slice(`${base}/trees/`.length)) });
    if (method === "GET" && path.startsWith(`${base}/blobs/`)) return json({ content: Buffer.from(blobs.get(path.slice(`${base}/blobs/`.length))!).toString("base64"), encoding: "base64" });
    if (method === "POST" && path === `${base}/blobs`) {
      const id = sha();
      blobs.set(id, body.content);
      return json({ sha: id });
    }
    if (method === "POST" && path === `${base}/trees`) {
      const id = sha();
      const replaced = new Set(body.tree.map((entry: { path: string }) => entry.path));
      trees.set(id, [...trees.get(body.base_tree)!.filter((entry) => !replaced.has(entry.path)), ...body.tree]);
      return json({ sha: id });
    }
    if (method === "POST" && path === `${base}/commits`) {
      const id = sha();
      commits.set(id, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha: id, html_url: `https://github.com/fork/widgets/commit/${id}` });
    }
    if (method === "PATCH" && path === `${base}/refs/heads/feature/x`) {
      refs.set("feature/x", body.sha);
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  });
  return { fetch, writes, refs, commits, blobs, trees, root };
}
