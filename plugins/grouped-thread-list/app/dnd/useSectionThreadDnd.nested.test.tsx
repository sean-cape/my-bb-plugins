// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import type {
  CollisionDetection,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import type { SectionThreadDndState } from "./useSectionThreadDnd.js";

installTestPluginRuntime();
const { CHRONOLOGICAL_CONTAINER_ID } = await import(
  "../model/project-thread-groups.js"
);
const { useSectionThreadDnd } = await import("./useSectionThreadDnd.js");

const ORDER: SidebarSectionId[] = [
  "pinned",
  "projects",
  "project:a",
  "project:b",
  "threads",
];
const NESTED_SECTION_IDS = new Set<string>(["project:a", "project:b"]);
const RECT = { top: 0, left: 0, width: 200, height: 28, right: 200, bottom: 28 };

function renderNestedDnd() {
  const result: { current: SectionThreadDndState | null } = { current: null };
  const onTopLevelSectionOrderChange = vi.fn();
  function Harness() {
    result.current = useSectionThreadDnd({
      containerId: CHRONOLOGICAL_CONTAINER_ID,
      enabled: true,
      rootItems: [],
      topLevelSectionOrder: ORDER,
      onTopLevelSectionOrderChange,
      nestedSectionIds: NESTED_SECTION_IDS,
      pinnedReorderPending: false,
      pinnedThreads: [],
      onReorderPinnedThread: vi.fn(),
    });
    return null;
  }
  renderSlot({ component: Harness }, {});
  return { onTopLevelSectionOrderChange, result };
}

function collide(state: SectionThreadDndState, activeId: string): string[] {
  return state.dndContextProps.collisionDetection!({
    active: { id: activeId },
    collisionRect: RECT,
    droppableRects: new Map(ORDER.map((id) => [id, RECT])),
    droppableContainers: ORDER.map((id) => ({ id })),
    pointerCoordinates: { x: 20, y: 14 },
  } as unknown as Parameters<CollisionDetection>[0]).map(({ id }) =>
    String(id),
  );
}

const originalElementsFromPoint = document.elementsFromPoint;

beforeEach(() => {
  const sidebar = document.createElement("aside");
  sidebar.dataset.sidebar = "sidebar";
  const row = document.createElement("div");
  sidebar.append(row);
  document.body.append(sidebar);
  document.elementsFromPoint = vi.fn((): Element[] => [row]);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.elementsFromPoint = originalElementsFromPoint;
});

describe("useSectionThreadDnd nested sections", () => {
  it("lets a nested section collide only with its nested siblings", () => {
    const { result } = renderNestedDnd();
    const collisions = collide(result.current!, "project:a");
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.every((id) => NESTED_SECTION_IDS.has(id))).toBe(true);
  });

  it("keeps outer sections from colliding with nested ones", () => {
    const { result } = renderNestedDnd();
    const collisions = collide(result.current!, "projects");
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.some((id) => NESTED_SECTION_IDS.has(id))).toBe(false);
  });

  it("reorders nested sections through the top-level order", () => {
    const { onTopLevelSectionOrderChange, result } = renderNestedDnd();
    const props = () => result.current!.dndContextProps;
    act(() =>
      props().onDragStart?.({ active: { id: "project:b" } } as DragStartEvent),
    );
    act(() =>
      props().onDragEnd?.({
        active: { id: "project:b" },
        over: { id: "project:a" },
      } as DragEndEvent),
    );
    expect(onTopLevelSectionOrderChange).toHaveBeenCalledWith([
      "pinned",
      "projects",
      "project:b",
      "project:a",
      "threads",
    ]);
  });
});
