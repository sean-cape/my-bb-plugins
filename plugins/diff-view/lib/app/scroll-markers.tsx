import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { cn } from "./utils";
import { scrollToElement } from "./scroll";
import { enter } from "./ui/motion";

interface Marker {
  /** Position along the scroller, as a fraction of its full height. */
  fraction: number;
  pending: boolean;
  element: Element;
}

/**
 * Where comments and findings sit along the scroller, for the marker track beside its scrollbar. Recomputed when
 * anything in `watch` changes, on DOM mutations inside the scroller, when a file's diff changes size, and on window
 * resize. Scrolling leaves the fractions as they are.
 */
export function useScrollMarkers(mainRef: RefObject<HTMLElement | null>, watch: readonly unknown[]): Marker[] {
  const [markers, setMarkers] = useState<Marker[]>([]);
  // An anchor's offset inside its file's diff, from when the diff was last rendered: measuring it while the diff is
  // skipped off screen (content-visibility) would force the whole file's style and layout.
  const offsets = useRef(new WeakMap<Element, number>());
  const recompute = () => {
    const main = mainRef.current;
    if (main === null) return;
    const mainTop = main.getBoundingClientRect().top;
    const total = main.scrollHeight;
    const topOf = (element: Element): number => {
      const container = element.closest("[data-lazy-mount]");
      if (container === null) return element.getBoundingClientRect().top;
      const containerTop = container.getBoundingClientRect().top;
      if (element.checkVisibility({ contentVisibilityAuto: true })) {
        const top = element.getBoundingClientRect().top;
        offsets.current.set(element, top - containerTop);
        return top;
      }
      return containerTop + (offsets.current.get(element) ?? 0);
    };
    const next = Array.from(main.querySelectorAll("[data-comment-anchor], [data-finding-anchor]")).map((element) => ({
      fraction: total === 0 ? 0 : (topOf(element) - mainTop + main.scrollTop) / total,
      pending: element.getAttribute("data-comment-state") === "pending" || element.hasAttribute("data-finding-anchor"),
      element,
    }));
    setMarkers((current) => (current.length === next.length && current.every((marker, index) => Math.abs(marker.fraction - next[index]!.fraction) < 0.001 && marker.pending === next[index]!.pending) ? current : next));
  };
  useEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recompute);
    };
    // Files' diffs change height as they mount, unfold and come into view (content-visibility) without any mutation.
    const resizes = new ResizeObserver(schedule);
    const sized = new WeakSet<Element>();
    const observeDiffs = () => {
      for (const container of Array.from(main.querySelectorAll("[data-lazy-mount]"))) {
        if (sized.has(container)) continue;
        sized.add(container);
        resizes.observe(container);
      }
    };
    observeDiffs();
    schedule();
    const observer = new MutationObserver(() => {
      observeDiffs();
      schedule();
    });
    observer.observe(main, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizes.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, watch);
  return markers;
}

export function ScrollMarkers({ markers, mainRef }: { markers: Marker[]; mainRef: RefObject<HTMLElement | null> }) {
  if (markers.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 w-2" aria-hidden="true">
      {markers.map((marker, index) => (
        <button
          key={index}
          type="button"
          tabIndex={-1}
          className={cn("pointer-events-auto absolute right-0 h-1 w-2 rounded-l-sm", enter.fade, marker.pending ? "bg-amber-500" : "bg-muted-foreground/50")}
          style={{ top: `calc(${marker.fraction * 100}% - 2px)` }}
          title={marker.pending ? "Pending comment" : "Comment"}
          onClick={() => {
            if (mainRef.current !== null) scrollToElement(mainRef.current, marker.element);
          }}
        />
      ))}
    </div>
  );
}
