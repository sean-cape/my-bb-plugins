// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLIDE_ATTR, INDICATOR_ATTR, nextIndicator, SNAP_ATTR, watchRailIndicator } from "./rail-indicator";

describe("nextIndicator", () => {
  it("appears in place on first sight", () => {
    expect(nextIndicator(null, { x: 8, y: 52 })).toEqual({ x: 8, y: 52, visible: true, slide: false });
  });

  it("slides between items", () => {
    const first = nextIndicator(null, { x: 8, y: 52 });
    expect(nextIndicator(first, { x: 8, y: 90 })).toEqual({ x: 8, y: 90, visible: true, slide: true });
  });

  it("fades out where it was when no rail item is current", () => {
    const shown = nextIndicator(null, { x: 8, y: 52 });
    expect(nextIndicator(shown, null)).toEqual({ x: 8, y: 52, visible: false, slide: false });
    expect(nextIndicator(null, null)).toEqual({ x: 0, y: 0, visible: false, slide: false });
  });

  it("fades in under the new item instead of sliding from where it hid", () => {
    const hidden = nextIndicator(nextIndicator(null, { x: 8, y: 52 }), null);
    expect(nextIndicator(hidden, { x: 8, y: 128 })).toEqual({ x: 8, y: 128, visible: true, slide: false });
  });
});

function boxAt(el: Element, top: number, left = 8) {
  el.getBoundingClientRect = () => ({ left, top, width: 28, height: 28, right: left + 28, bottom: top + 28, x: left, y: top, toJSON: () => ({}) });
}

function rail(...tops: number[]): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "app-nav-rail");
  boxAt(el, 0, 0);
  const items = document.createElement("div");
  for (const top of tops) {
    const button = document.createElement("button");
    boxAt(button, top);
    items.append(button);
  }
  el.append(items);
  return el;
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const indicatorOf = (el: Element) => el.querySelector<HTMLElement>(`[${INDICATOR_ATTR}]`);

function select(el: Element, index: number) {
  el.querySelectorAll("button").forEach((button, i) => {
    if (i === index) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

describe("watchRailIndicator", () => {
  let dispose: () => void;
  let snaps: boolean[];

  beforeEach(() => {
    snaps = [];
    document.body.replaceChildren();
  });

  afterEach(() => {
    dispose?.();
    document.body.replaceChildren();
  });

  const watch = () => {
    dispose = watchRailIndicator(document.body);
  };

  const recordSnaps = (indicator: HTMLElement) => {
    const set = indicator.toggleAttribute.bind(indicator);
    indicator.toggleAttribute = (name: string, force?: boolean) => {
      if (name === SNAP_ATTR && force) snaps.push(true);
      return set(name, force);
    };
  };

  it("puts the fill under the current item when the rail mounts", () => {
    const el = rail(52, 90);
    select(el, 1);
    document.body.append(el);
    watch();
    const indicator = indicatorOf(el)!;
    expect(el.hasAttribute(GLIDE_ATTR)).toBe(true);
    expect(indicator.style.transform).toBe("translate3d(8px, 90px, 0)");
    expect(indicator.style.opacity).toBe("1");
    expect(indicator.style.width).toBe("28px");
  });

  it("finds a rail mounted later", async () => {
    watch();
    const el = rail(52);
    select(el, 0);
    document.body.append(el);
    await flush();
    expect(indicatorOf(el)?.style.opacity).toBe("1");
  });

  it("slides to the item that becomes current", async () => {
    const el = rail(52, 90);
    select(el, 0);
    document.body.append(el);
    watch();
    const indicator = indicatorOf(el)!;
    recordSnaps(indicator);
    select(el, 1);
    await flush();
    expect(indicator.style.transform).toBe("translate3d(8px, 90px, 0)");
    expect(snaps).toEqual([]);
  });

  it("fades out when no item is current, then lands under the next one without sliding", async () => {
    const el = rail(52, 90);
    select(el, 0);
    document.body.append(el);
    watch();
    const indicator = indicatorOf(el)!;
    select(el, -1);
    await flush();
    expect(indicator.style.opacity).toBe("0");
    expect(indicator.style.transform).toBe("translate3d(8px, 52px, 0)");

    recordSnaps(indicator);
    select(el, 1);
    await flush();
    expect(indicator.style.transform).toBe("translate3d(8px, 90px, 0)");
    expect(indicator.style.opacity).toBe("1");
    expect(snaps).toEqual([true]);
    expect(indicator.hasAttribute(SNAP_ATTR)).toBe(false);
  });

  it("snaps when the rail scrolls", () => {
    const el = rail(52);
    select(el, 0);
    document.body.append(el);
    watch();
    const indicator = indicatorOf(el)!;
    recordSnaps(indicator);
    boxAt(el.querySelector("button")!, 40);
    el.querySelector("div")!.dispatchEvent(new Event("scroll"));
    expect(indicator.style.transform).toBe("translate3d(8px, 40px, 0)");
    expect(snaps).toEqual([true]);
  });

  it("moves to a remounted rail", async () => {
    const first = rail(52);
    select(first, 0);
    document.body.append(first);
    watch();
    first.remove();
    const second = rail(90);
    select(second, 0);
    document.body.append(second);
    await flush();
    expect(first.hasAttribute(GLIDE_ATTR)).toBe(false);
    expect(indicatorOf(first)).toBeNull();
    expect(indicatorOf(second)?.style.transform).toBe("translate3d(8px, 90px, 0)");
  });

  it("restores the stock rail on dispose", () => {
    const el = rail(52);
    select(el, 0);
    document.body.append(el);
    watch();
    dispose();
    expect(el.hasAttribute(GLIDE_ATTR)).toBe(false);
    expect(indicatorOf(el)).toBeNull();
  });
});
