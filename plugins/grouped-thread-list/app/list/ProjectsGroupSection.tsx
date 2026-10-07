import { memo, useMemo, useState, type ReactNode } from "react";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  PROJECTS_GROUP_SECTION_ID,
  type SidebarSectionId,
} from "../model/sidebar-section-id.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import type { ConsumeDragClickSuppression } from "../ui/use-drag-click-suppression.js";
import { SidebarControlButton } from "../rows/SidebarRowControls.js";
import { SortableSidebarSection } from "./BuiltInSidebarSection.js";
import { SidebarHeaderControls } from "./SidebarHeaderControls.js";

const PROJECTS_GROUP_LABEL = "Projects";

interface ProjectsGroupSectionProps {
  allProjectsCollapsed: boolean;
  children: ReactNode;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  disabled: boolean;
  isCollapsed: boolean;
  onSetAllProjectsCollapsed: (collapsed: boolean) => void;
  onToggleCollapsed: () => void;
  projectSectionIds: readonly SidebarSectionId[];
  threads: readonly SidebarThread[];
}

export const ProjectsGroupSection = memo(function ProjectsGroupSection({
  allProjectsCollapsed,
  children,
  consumeClickSuppression,
  disabled,
  isCollapsed,
  onSetAllProjectsCollapsed,
  onToggleCollapsed,
  projectSectionIds,
  threads,
}: ProjectsGroupSectionProps) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const activity = useMemo(() => getCollapsedChildActivity(threads), [threads]);
  const sortableItems = useMemo(() => [...projectSectionIds], [projectSectionIds]);
  const toggleAllLabel = allProjectsCollapsed
    ? "Expand all projects"
    : "Collapse all projects";

  return (
    <SortableSidebarSection
      id={PROJECTS_GROUP_SECTION_ID}
      sectionId={PROJECTS_GROUP_SECTION_ID}
      disabled={disabled}
      label={PROJECTS_GROUP_LABEL}
      labelAdornment={
        <span
          className="shrink-0 tabular-nums text-subtle-foreground/60"
          aria-label={`${projectSectionIds.length} projects`}
        >
          {projectSectionIds.length}
        </span>
      }
      collapseControl={{ isCollapsed, onToggleCollapsed }}
      collapsedActivity={activity}
      collapsedThreads={threads}
      consumeClickSuppression={consumeClickSuppression}
      actionsMobileAlways
      actionsOpen={actionsOpen}
      actions={
        <SidebarHeaderControls
          label={PROJECTS_GROUP_LABEL}
          showNewThread={false}
          onOpenChange={setActionsOpen}
          primaryAction={
            isCollapsed ? null : (
              <SidebarControlButton
                label={toggleAllLabel}
                icon={allProjectsCollapsed ? "ChevronsDown" : "ChevronsUp"}
                onClick={() => onSetAllProjectsCollapsed(!allProjectsCollapsed)}
              />
            )
          }
        />
      }
    >
      <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
        <div className="space-y-1">{children}</div>
      </SortableContext>
    </SortableSidebarSection>
  );
});
