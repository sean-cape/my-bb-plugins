import { cx, PRESS, EntranceScope } from "bb-motion";
import type { MetadataEntry } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { FIELD_ROW } from "./client-keys";
import { FOCUS_RING } from "./controls";
import { inputClass } from "./MessageEditor";
import { PresenceRow, usePresenceValues } from "./presence";

export interface MetadataRow extends MetadataEntry {
  enabled: boolean;
}

export function MetadataEditor({ rows, endpoint, onChange }: { rows: MetadataRow[]; endpoint: string; onChange: (rows: MetadataRow[]) => void }) {
  const update = (index: number, patch: Partial<MetadataRow>) => onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  const { rows: presence, onExited, forget } = usePresenceValues(rows);
  return (
    <EntranceScope>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Sent with every call to <span className="font-medium text-foreground">{endpoint}</span>. A row overrides an auth or endpoint header with the same name.
        </p>
        {presence.length > 0 ? (
          <div className="space-y-2">
            {presence.map(({ key, value: row, index, exiting }) => (
              <PresenceRow key={key} className={cn("flex items-center gap-2 rounded-md", FOCUS_RING)} fieldRow cascadeIndex={index} exiting={exiting} onExited={() => onExited(key)}>
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={row.enabled}
                  aria-label={`Send ${row.name || "this header"}`}
                  onChange={(event) => update(index, { enabled: event.target.checked })}
                />
                <input
                  className={cn(inputClass, "w-48 font-mono text-[13px]")}
                  placeholder="name"
                  value={row.name}
                  spellCheck={false}
                  onChange={(event) => update(index, { name: event.target.value.toLowerCase() })}
                />
                <input
                  className={cn(inputClass, "flex-1 font-mono text-[13px]")}
                  placeholder="value"
                  value={row.value}
                  spellCheck={false}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className={cx("rounded p-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
                  aria-label={`Remove ${row.name || "header"}`}
                  onClick={() => {
                    forget(index);
                    onChange(rows.filter((_row, position) => position !== index));
                  }}
                >
                  <Icon name="Trash2" className="size-4" />
                </button>
              </PresenceRow>
            ))}
          </div>
        ) : null}
        <Button variant="outline" size="sm" data-nav-row="item" onClick={() => onChange([...rows, { name: "", value: "", enabled: true }])}>
          <Icon name="Plus" className="size-4" />
          Add header
        </Button>
      </div>
    </EntranceScope>
  );
}
