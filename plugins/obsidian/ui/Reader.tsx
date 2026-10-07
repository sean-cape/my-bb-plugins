import { Children, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { parse as parseYaml } from "yaml";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { extension, isNotePath, noteTitle, parseFrontmatter, slugifyHeading, type LinkKind, type LinkResolver } from "../shared/obsidian";
import { remarkObsidian } from "./remark-obsidian";
import { IMAGE_EXTENSIONS, consumeNavigation, previewUrl, resolveTargetLine, type NavigationTarget, type VaultRpc } from "./state";

export interface ReaderLink {
  target: string;
  subpath: string | null;
  kind: LinkKind;
}

interface ReaderProps {
  path: string;
  content: string;
  resolver: LinkResolver;
  rpc: VaultRpc;
  previewBase: string | null;
  target?: { target: NavigationTarget; seq: number } | null;
  depth?: number;
  /** Notes already being rendered above this one, to stop embed cycles. */
  ancestors?: readonly string[];
  onOpenLink: (link: ReaderLink) => void;
  onTagClick?: (tag: string) => void;
  /** Present when the reader may edit the source (toggling task checkboxes). */
  onChange?: (content: string) => void;
}

const MAX_EMBED_DEPTH = 3;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The source line of the enclosing task list item. Carried by context because
 * a loose list wraps the checkbox in a paragraph, out of the item's direct children.
 */
const TaskContext = createContext<{ line?: number; toggle?: (line: number) => void }>({});

function TaskCheckbox({ checked }: { checked: boolean }) {
  const { line, toggle } = useContext(TaskContext);
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={toggle === undefined || line === undefined}
      onChange={() => line !== undefined && toggle?.(line)}
      className="ob-task-checkbox"
    />
  );
}
const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i;

const CALLOUT_ICONS: Record<string, string> = {
  note: "Edit",
  info: "Info",
  tip: "Star",
  hint: "Star",
  important: "AlertCircle",
  success: "CircleCheck",
  check: "CircleCheck",
  done: "CircleCheck",
  question: "CircleQuestion",
  help: "CircleQuestion",
  faq: "CircleQuestion",
  warning: "AlertTriangle",
  caution: "AlertTriangle",
  attention: "AlertTriangle",
  failure: "CircleX",
  fail: "CircleX",
  missing: "CircleX",
  danger: "Zap",
  error: "Zap",
  bug: "Bug",
  example: "ListView",
  quote: "AlignLeft",
  cite: "AlignLeft",
  abstract: "FileText",
  summary: "FileText",
  tldr: "FileText",
  todo: "CircleCheck",
};

function Properties({ content }: { content: string }) {
  const frontmatter = parseFrontmatter(content);
  const data = useMemo(() => {
    if (frontmatter === null) return null;
    try {
      const parsed: unknown = parseYaml(frontmatter.raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [frontmatter?.raw]);
  if (data === null || Object.keys(data).length === 0) return null;
  const format = (value: unknown): string =>
    Array.isArray(value) ? value.map(format).join(", ") : value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  return (
    <div className="ob-properties">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="ob-property">
          <span className="ob-property-key">{key}</span>
          <span className="ob-property-value">{format(value)}</span>
        </div>
      ))}
    </div>
  );
}

function NoteEmbed(props: { target: string; subpath: string | null; sourcePath: string } & Omit<ReaderProps, "content" | "path" | "target">) {
  const { target, subpath, sourcePath, resolver, rpc, depth = 0, ancestors = [] } = props;
  const resolved = resolver.resolve(target, sourcePath);
  const blocked = depth >= MAX_EMBED_DEPTH ? "Embed depth limit reached." : resolved !== null && subpath === null && (resolved === sourcePath || ancestors.includes(resolved)) ? "This note embeds itself." : null;
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (resolved === null || blocked !== null) return;
    let cancelled = false;
    rpc.call("read", { path: resolved }).then(
      (note) => !cancelled && setContent(note.content),
      (cause) => !cancelled && setError(String(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, resolved, blocked]);
  if (resolved === null) return <span className="ob-link ob-link-unresolved">{target}</span>;
  let body = content;
  if (body !== null && subpath !== null) body = sectionOf(body, subpath);
  return (
    <div className="ob-embed">
      <button
        type="button"
        className="ob-embed-title"
        onClick={() => props.onOpenLink({ target, subpath, kind: "wiki" })}
      >
        {noteTitle(resolved)}
        {subpath === null ? null : ` › ${subpath}`}
      </button>
      {blocked !== null ? (
        <p className="text-sm text-muted-foreground">{blocked}</p>
      ) : error !== null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : body === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Reader {...props} path={resolved} content={body} depth={depth + 1} ancestors={[...ancestors, sourcePath]} onChange={undefined} target={null} />
      )}
    </div>
  );
}

/** The heading section (or block) of a note an embed subpath points at. */
function sectionOf(content: string, subpath: string): string {
  const lines = content.split("\n");
  if (subpath.startsWith("^")) {
    const marker = subpath.toLowerCase();
    const line = lines.find((candidate) => candidate.trimEnd().toLowerCase().endsWith(` ${marker}`));
    return line === undefined ? content : line.replace(/\s+\^[\w-]+\s*$/, "");
  }
  const wanted = slugifyHeading(subpath);
  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match !== null && slugifyHeading(match[2]!.replace(/\s+#+\s*$/, "")) === wanted;
  });
  if (start === -1) return content;
  const level = /^(#{1,6})/.exec(lines[start]!)![1]!.length;
  let end = start + 1;
  while (end < lines.length) {
    const match = /^(#{1,6})\s/.exec(lines[end]!);
    if (match !== null && match[1]!.length <= level) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

export function Reader(props: ReaderProps) {
  const { path, content, resolver, previewBase, onOpenLink, onTagClick, onChange, target, depth = 0 } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || target === null || target === undefined) return;
    let element: Element | null = null;
    if (target.target.heading !== undefined) {
      const wanted = slugifyHeading(target.target.heading);
      element = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((heading) => slugifyHeading(heading.textContent ?? "") === wanted) ?? null;
    } else {
      const index = resolveTargetLine(content, target.target);
      if (index === null) return;
      const wantedLine = index + 1;
      let best: Element | null = null;
      for (const candidate of root.querySelectorAll("[data-line]")) {
        if (Number(candidate.getAttribute("data-line")) <= wantedLine) best = candidate;
        else break;
      }
      element = best;
    }
    element?.scrollIntoView({ block: "start" });
    consumeNavigation(target.seq);
  }, [target]);

  const toggleTask = (line: number) => {
    if (onChange === undefined) return;
    const lines = content.split("\n");
    const source = lines[line - 1];
    if (source === undefined) return;
    const toggled = source.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, (_, open: string, mark: string, close: string) => `${open}${mark === " " ? "x" : " "}${close}`);
    if (toggled === source) return;
    lines[line - 1] = toggled;
    onChange(lines.join("\n"));
  };

  const resolveFile = (target: string, kind: LinkKind) => resolver.resolve(target, path, kind);

  const renderImage = (target: string, kind: LinkKind, alt: string, sizing: string | null) => {
    const resolved = resolveFile(target, kind);
    if (resolved === null || previewBase === null) return <span className="ob-link ob-link-unresolved">{alt || target}</span>;
    const size = sizing !== null ? /^(\d+)(?:x(\d+))?$/.exec(sizing) : null;
    return (
      <img
        src={previewUrl(previewBase, resolved)}
        alt={alt}
        width={size?.[1] !== undefined ? Number(size[1]) : undefined}
        height={size?.[2] !== undefined ? Number(size[2]) : undefined}
        className="ob-image"
      />
    );
  };

  const lineOf = (node: unknown): number | undefined =>
    (node as { position?: { start?: { line?: number } } } | undefined)?.position?.start?.line;

  const components: Components = {
    a({ node: _node, href, children, ...rest }) {
      const attributes = rest as Record<string, unknown>;
      if (attributes["data-wikilink"] === "true") {
        const linkTarget = String(attributes["data-target"] ?? "");
        const subpath = String(attributes["data-subpath"] ?? "") || null;
        const resolved = linkTarget === "" || resolveFile(linkTarget, "wiki") !== null;
        return (
          <a
            href="#"
            className={cn("ob-link", !resolved && "ob-link-unresolved")}
            onClick={(event) => {
              event.preventDefault();
              onOpenLink({ target: linkTarget, subpath, kind: "wiki"});
            }}
          >
            {children}
          </a>
        );
      }
      if (href === undefined || EXTERNAL_URL.test(href)) {
        return <UrlLink href={href ?? "#"} className="ob-external-link">{children}</UrlLink>;
      }
      if (href.startsWith("#")) {
        return (
          <a
            href="#"
            className="ob-link"
            onClick={(event) => {
              event.preventDefault();
              onOpenLink({ target: "", subpath: safeDecode(href.slice(1)), kind: "markdown" });
            }}
          >
            {children}
          </a>
        );
      }
      const hash = href.indexOf("#");
      const linkTarget = safeDecode(hash === -1 ? href : href.slice(0, hash));
      const rawSubpath = hash === -1 ? undefined : safeDecode(href.slice(hash + 1));
      const resolved = resolveFile(linkTarget, "markdown") !== null;
      return (
        <a
          href="#"
          className={cn("ob-link", !resolved && "ob-link-unresolved")}
          onClick={(event) => {
            event.preventDefault();
            onOpenLink({ target: linkTarget, subpath: rawSubpath ?? null, kind: "markdown"});
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      const source = typeof src === "string" ? src : "";
      if (source === "" || EXTERNAL_URL.test(source)) return <img src={source} alt={alt ?? ""} referrerPolicy="no-referrer" className="ob-image" />;
      let decoded = source;
      try {
        decoded = decodeURIComponent(source);
      } catch {
        // Keep the raw path when it is not valid percent-encoding.
      }
      const sizing = alt !== undefined && /\|(\d+(?:x\d+)?)$/.exec(alt);
      return renderImage(decoded, "markdown", alt ?? "", sizing ? sizing[1]! : null);
    },
    span({ node: _node, children, ...rest }) {
      const attributes = rest as Record<string, unknown>;
      if (attributes["data-embed"] === "true") {
        const embedTarget = String(attributes["data-target"] ?? "");
        const subpath = String(attributes["data-subpath"] ?? "") || null;
        const alias = String(attributes["data-alias"] ?? "") || null;
        const resolved = resolveFile(embedTarget, "wiki");
        if (resolved !== null && IMAGE_EXTENSIONS.has(extension(resolved))) {
          return renderImage(embedTarget, "wiki", noteTitle(resolved), alias);
        }
        if (resolved === null || isNotePath(resolved)) {
          return <NoteEmbed {...props} sourcePath={path} target={embedTarget} subpath={subpath} depth={depth} />;
        }
        return (
          <a
            href="#"
            className="ob-link"
            onClick={(event) => {
              event.preventDefault();
              onOpenLink({ target: embedTarget, subpath, kind: "wiki"});
            }}
          >
            {alias ?? embedTarget}
          </a>
        );
      }
      if (attributes["data-tag"] !== undefined) {
        const tag = String(attributes["data-tag"]);
        return (
          <button type="button" className="ob-tag" onClick={() => onTagClick?.(tag)}>
            {children}
          </button>
        );
      }
      return <span {...(rest as object)}>{children}</span>;
    },
    blockquote({ node: _node, children, ...rest }) {
      const attributes = rest as Record<string, unknown>;
      const callout = attributes["data-callout"];
      if (typeof callout !== "string") return <blockquote>{children}</blockquote>;
      const title = String(attributes["data-callout-title"] ?? "") || callout.charAt(0).toUpperCase() + callout.slice(1);
      const foldable = attributes["data-callout-fold"] === "+" || attributes["data-callout-fold"] === "-";
      const body = (
        <div className="ob-callout-body">{Children.toArray(children).filter((child) => typeof child !== "string" || child.trim() !== "")}</div>
      );
      const icon = <Icon name={Object.hasOwn(CALLOUT_ICONS, callout) ? CALLOUT_ICONS[callout] : "Edit"} fallback="Edit" className="size-4" aria-hidden />;
      if (foldable) {
        return (
          <details className="ob-callout" data-callout={callout} open={attributes["data-callout-fold"] === "+"}>
            <summary className="ob-callout-title">
              {icon}
              {title}
            </summary>
            {body}
          </details>
        );
      }
      return (
        <div className="ob-callout" data-callout={callout}>
          <div className="ob-callout-title">
            {icon}
            {title}
          </div>
          {body}
        </div>
      );
    },
    li({ node, children, className }) {
      const line = lineOf(node);
      const isTask = className?.includes("task-list-item");
      if (!isTask) return <li data-line={line}>{children}</li>;
      return (
        <li data-line={line} className="ob-task">
          <TaskContext.Provider value={{ line, toggle: onChange === undefined ? undefined : toggleTask }}>{children}</TaskContext.Provider>
        </li>
      );
    },
    input({ node: _node, type, checked, ...rest }) {
      if (type === "checkbox") return <TaskCheckbox checked={checked ?? false} />;
      return <input type={type} checked={checked} {...rest} />;
    },
    p: ({ node, children }) => <p data-line={lineOf(node)}>{children}</p>,
    h1: ({ node, children }) => <h1 data-line={lineOf(node)}>{children}</h1>,
    h2: ({ node, children }) => <h2 data-line={lineOf(node)}>{children}</h2>,
    h3: ({ node, children }) => <h3 data-line={lineOf(node)}>{children}</h3>,
    h4: ({ node, children }) => <h4 data-line={lineOf(node)}>{children}</h4>,
    h5: ({ node, children }) => <h5 data-line={lineOf(node)}>{children}</h5>,
    h6: ({ node, children }) => <h6 data-line={lineOf(node)}>{children}</h6>,
    table: ({ children }) => (
      <div className="ob-table-wrap">
        <table>{children}</table>
      </div>
    ),
  };

  return (
    <div ref={rootRef} className={cn("ob-reader", depth > 0 && "ob-reader-nested")}>
      {depth === 0 ? <Properties content={content} /> : null}
      <ReactMarkdown
        remarkPlugins={[remarkFrontmatter, remarkGfm, remarkObsidian]}
        components={components}
        urlTransform={defaultUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
