import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const MONOGRAM_WORD_SEPARATOR = /[\s._/-]+/u;

export function getProjectMonogramText(name: string): string {
  const words = name.split(MONOGRAM_WORD_SEPARATOR).filter(Boolean);
  const initials =
    words.length >= 2
      ? `${Array.from(words[0])[0]}${Array.from(words[1])[0]}`
      : (Array.from(words[0] ?? name)[0] ?? "?");
  return initials.toLocaleUpperCase();
}

/** Hashes the project id, not its name, so a rename keeps the color. */
export function getProjectMonogramHue(projectId: string): number {
  let hash = 0;
  for (const char of projectId) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % 360;
}

interface ProjectMonogramProps {
  projectId: string;
  name: string;
}

export function ProjectMonogram({ projectId, name }: ProjectMonogramProps) {
  const text = getProjectMonogramText(name);
  const style: CSSProperties = {
    backgroundColor: `oklch(0.58 0.11 ${getProjectMonogramHue(projectId)})`,
  };
  return (
    <span
      aria-hidden="true"
      data-sidebar-project-monogram=""
      className={cn(
        "inline-flex size-4 shrink-0 select-none items-center justify-center rounded-[4px] font-semibold leading-none tracking-tight text-white",
        text.length > 1 ? "text-[8.5px]" : "text-[10px]",
      )}
      style={style}
    >
      {text}
    </span>
  );
}
