import { DEFAULT_OPTIONS, type VimModeOptions } from "./vim/controller";

export const SCOPE_ALL = "All text boxes";
export const SCOPE_COMPOSER = "Prompt box only";

/** Declarative settings, shared by the server (definition) and app (reading). */
export const settingDescriptors = {
  enabled: {
    type: "boolean" as const,
    label: "Enable vim keys",
    description: "Turn vim editing on or off without uninstalling the plugin.",
    default: true,
  },
  scope: {
    type: "select" as const,
    label: "Text boxes",
    description:
      "Where vim keys apply. Command palettes, pickers, terminals, and code editors are always left alone.",
    options: [SCOPE_ALL, SCOPE_COMPOSER],
    default: SCOPE_ALL,
  },
  startInInsertMode: {
    type: "boolean" as const,
    label: "Start in insert mode",
    description:
      "Text boxes enter insert mode whenever they gain focus, so typing works as usual until you press Escape. Turn off to start in normal mode.",
    default: true,
  },
};

export function optionsFromSettings(
  values: Record<string, string | number | boolean> | undefined,
): VimModeOptions {
  if (!values) return DEFAULT_OPTIONS;
  return {
    enabled: typeof values.enabled === "boolean" ? values.enabled : DEFAULT_OPTIONS.enabled,
    scope: values.scope === SCOPE_COMPOSER ? "composer" : "all",
    startInInsertMode:
      typeof values.startInInsertMode === "boolean"
        ? values.startInInsertMode
        : DEFAULT_OPTIONS.startInInsertMode,
  };
}
