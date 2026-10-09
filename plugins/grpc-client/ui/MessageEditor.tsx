import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { CHEVRON, cx, enter, PRESS, REVEAL, REVEAL_HOST, stagger, STAGGER, EntranceScope } from "bb-motion";
import type { FieldInfo, ScalarName, TypeClosure } from "../shared/schema";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ChoiceSelect } from "./ChoiceSelect";
import { FIELD_ROW } from "./client-keys";
import { FOCUS_RING } from "./controls";
import { Appear, PresenceRow, usePresenceRemovals, usePresenceValues } from "./presence";
import {
  defaultElement,
  elementLabel,
  isInt64,
  isNumber,
  isObject,
  readField,
  typeLabel,
  wellKnown,
  writeField,
  type Json,
  type JsonObject,
} from "./proto-json";

const MAX_DEPTH = 12;

export const EditorOptionsContext = createContext({ showDocs: false });

export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

interface EditorProps<T> {
  value: T | undefined;
  onChange: (next: T | undefined) => void;
}

/**
 * Empty input normally unsets the field. Fields with explicit presence (oneof
 * members, `optional`, wrappers) keep "" instead, because unset and empty mean
 * different things there and the clear button already unsets.
 */
function TextInput({
  value,
  onChange,
  placeholder,
  inputMode,
  mono,
  keepEmpty,
}: EditorProps<string> & { placeholder?: string; inputMode?: "numeric" | "decimal" | "text"; mono?: boolean; keepEmpty?: boolean }) {
  return (
    <input
      className={cn(inputClass, mono && "font-mono text-[13px]")}
      value={value ?? ""}
      placeholder={placeholder}
      inputMode={inputMode}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value === "" && !keepEmpty ? undefined : event.target.value)}
    />
  );
}

const BOOL_CHOICES = [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
];

function ScalarInput({ scalar, value, onChange, keepEmpty }: EditorProps<Json> & { scalar: ScalarName; keepEmpty?: boolean }) {
  if (scalar === "bool") {
    return (
      <ChoiceSelect
        className="w-32"
        value={value === true ? "true" : value === false ? "false" : ""}
        choices={BOOL_CHOICES}
        onChange={(next) => onChange(next === "" ? undefined : next === "true")}
      />
    );
  }
  const text = value === undefined || value === null ? undefined : String(value);
  if (isNumber(scalar)) {
    return (
      <TextInput
        value={text}
        mono
        inputMode="decimal"
        placeholder={scalar}
        keepEmpty={keepEmpty}
        onChange={(next) => {
          if (next === undefined || next === "") return onChange(next);
          const number = Number(next);
          // Partial input like "1." or "-" stays text until it is a clean number.
          onChange(Number.isFinite(number) && String(number) === next ? number : next);
        }}
      />
    );
  }
  return (
    <TextInput
      value={text}
      mono={isInt64(scalar) || scalar === "bytes"}
      inputMode={isInt64(scalar) ? "numeric" : "text"}
      placeholder={scalar === "bytes" ? "base64" : scalar}
      keepEmpty={keepEmpty}
      onChange={onChange}
    />
  );
}

function EnumSelect({ typeName, closure, value, onChange }: EditorProps<Json> & { typeName: string; closure: TypeClosure }) {
  const values = closure.enums[typeName]?.values ?? [];
  const current = typeof value === "number" ? (values.find((candidate) => candidate.number === value)?.name ?? String(value)) : (value as string | undefined);
  const choices = values.map((option) => ({ value: option.name, label: option.name, title: option.comment }));
  if (current !== undefined && current !== "" && !values.some((option) => option.name === current)) choices.push({ value: current, label: current, title: undefined });
  return <ChoiceSelect value={current ?? ""} choices={choices} onChange={(next) => onChange(next === "" ? undefined : next)} />;
}

function JsonInput({ value, onChange }: EditorProps<Json>) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText((current) => {
      try {
        if (current.trim() !== "" && JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
      } catch {
        return current;
      }
      return value === undefined ? "" : JSON.stringify(value, null, 2);
    });
  }, [value]);
  return (
    <textarea
      className={cn(inputClass, "h-24 py-1.5 font-mono text-[13px]", invalid && "border-destructive")}
      value={text}
      placeholder="JSON"
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value);
        if (event.target.value.trim() === "") {
          setInvalid(false);
          onChange(undefined);
          return;
        }
        try {
          onChange(JSON.parse(event.target.value) as Json);
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

/** Message-typed values (other than JSON-ish well-known types) get a card of their own. */
function isMessageEditor(field: FieldInfo): boolean {
  if (field.kind !== "message") return false;
  const wkt = wellKnown(field.typeName);
  return wkt === null;
}

/** An inline editor for one value of the field's element type, ignoring repeated/map. */
function ElementEditor({
  field,
  closure,
  depth,
  value,
  onChange,
  keepEmpty,
}: EditorProps<Json> & { field: FieldInfo; closure: TypeClosure; depth: number; keepEmpty?: boolean }) {
  if (field.kind === "scalar") return <ScalarInput scalar={field.scalar ?? "string"} value={value} onChange={onChange} keepEmpty={keepEmpty} />;
  if (field.kind === "enum") return <EnumSelect typeName={field.typeName ?? ""} closure={closure} value={value} onChange={onChange} />;
  const wkt = wellKnown(field.typeName);
  switch (wkt?.kind) {
    case "wrapper":
      return <ScalarInput scalar={wkt.scalar} value={value} onChange={onChange} keepEmpty />;
    case "timestamp":
      return (
        <div className="flex min-w-0 gap-1.5">
          <TextInput value={value as string | undefined} mono placeholder="2006-01-02T15:04:05Z" onChange={onChange} />
          <button
            type="button"
            className={cx("h-8 shrink-0 rounded-md border border-input px-2.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
            onClick={() => onChange(new Date().toISOString())}
          >
            Now
          </button>
        </div>
      );
    case "duration":
      return <TextInput value={value as string | undefined} mono placeholder="1.5s" onChange={onChange} />;
    case "fieldmask":
      return <TextInput value={value as string | undefined} mono placeholder="path.one,path.two" onChange={onChange} />;
    case "empty":
      return <span className="text-sm text-muted-foreground">{"{}"}</span>;
    case "json":
      return <JsonInput value={value} onChange={onChange} />;
    case undefined:
      break;
  }
  if (depth >= MAX_DEPTH) return <JsonInput value={value} onChange={onChange} />;
  return (
    <MessageEditor typeName={field.typeName ?? ""} closure={closure} depth={depth + 1} value={isObject(value) ? value : {}} onChange={(next) => onChange(next)} />
  );
}

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cx("rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", REVEAL)}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name="X" className="size-3.5" />
    </button>
  );
}

function FieldName({ field, set }: { field: FieldInfo; set: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={cn("truncate text-sm", set ? "font-medium text-foreground" : "text-foreground/80", field.deprecated && "line-through")}>{field.jsonName}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{typeLabel(field)}</span>
    </span>
  );
}

function Docs({ field }: { field: FieldInfo }) {
  const { showDocs } = useContext(EditorOptionsContext);
  if (!showDocs || !field.comment) return null;
  return <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-xs leading-snug text-muted-foreground">{field.comment}</p>;
}

/** A labelled single-line row: name and type on the left, the input on the right. */
function InlineRow({ field, set, onClear, children }: { field: FieldInfo; set: boolean; onClear: () => void; children: ReactNode }) {
  return (
    <div {...FIELD_ROW} className={cn("grid grid-cols-[minmax(8rem,15rem)_minmax(0,1fr)_1.5rem] items-start gap-x-3 rounded-md py-1", REVEAL_HOST, FOCUS_RING)} title={field.comment}>
      <div className="min-w-0 pt-1.5">
        <FieldName field={field} set={set} />
        <Docs field={field} />
      </div>
      <div className="min-w-0">{children}</div>
      <div className="pt-1">{set ? <ClearButton label={`Clear ${field.jsonName}`} onClick={onClear} /> : null}</div>
    </div>
  );
}

/** A collapsible card for message, repeated and map fields. */
function Section({
  field,
  set,
  summary,
  onClear,
  children,
}: {
  field: FieldInfo;
  set: boolean;
  summary?: string;
  onClear: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Appear className="py-1">
      <div className="rounded-lg border border-border" data-nav-group="">
        <div {...FIELD_ROW} data-nav-row="group" className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5", REVEAL_HOST, FOCUS_RING)} title={field.comment}>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open} data-bbm-open={open} onClick={() => setOpen(!open)}>
            <Icon name="ChevronRight" className={cx("size-3.5 shrink-0 text-muted-foreground", CHEVRON)} />
            <FieldName field={field} set={set} />
            {summary ? <span className="shrink-0 text-xs text-muted-foreground">{summary}</span> : null}
          </button>
          {set ? <ClearButton label={`Clear ${field.jsonName}`} onClick={onClear} /> : null}
        </div>
        {open ? (
          <Appear className="border-t border-border px-3 py-2">
            <Docs field={field} />
            {children}
          </Appear>
        ) : null}
      </div>
    </Appear>
  );
}

/** `navRow` off when the button sits in a field row that is already the cursor's stop. */
function AddButton({ label, onClick, disabled, navRow = true }: { label: string; onClick: () => void; disabled?: boolean; navRow?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-nav-row={navRow ? "item" : undefined}
      className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50", PRESS, FOCUS_RING)}
      onClick={onClick}
    >
      <Icon name="Plus" className="size-3.5" />
      {label}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={cx("mt-1 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)} aria-label={label} title={label} onClick={onClick}>
      <Icon name="Trash2" className="size-3.5" />
    </button>
  );
}

function ListEditor({ field, closure, depth, value, onChange }: EditorProps<Json> & { field: FieldInfo; closure: TypeClosure; depth: number }) {
  const items = Array.isArray(value) ? value : [];
  const update = (next: Json[]) => onChange(next.length === 0 ? undefined : next);
  const messages = isMessageEditor(field);
  const { rows, onExited, forget } = usePresenceValues(items);
  return (
    <div className="space-y-2">
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">No items.</p> : null}
      {rows.map(({ key, value: item, index, exiting }) => (
        <PresenceRow
          key={key}
          className={cn("flex items-start gap-2 rounded-md", FOCUS_RING, messages && "bg-muted/30 p-2")}
          fieldRow={messages ? "fixedGroup" : "item"}
          exiting={exiting}
          onExited={() => onExited(key)}
        >
          <span className="mt-1.5 w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{index}</span>
          <div className="min-w-0 flex-1">
            <ElementEditor
              field={field}
              closure={closure}
              depth={depth}
              value={item}
              keepEmpty
              onChange={(next) => update(items.map((current, position) => (position === index ? (next ?? defaultElement(field, closure)) : current)))}
            />
          </div>
          <RemoveButton
            label={`Remove item ${index}`}
            onClick={() => {
              forget(index);
              update(items.filter((_item, position) => position !== index));
            }}
          />
        </PresenceRow>
      ))}
      <AddButton label={`Add ${elementLabel(field)}`} onClick={() => update([...items, defaultElement(field, closure)])} />
    </div>
  );
}

interface MapRow {
  id: number;
  key: string;
  value: Json;
}

function serializeRows(rows: MapRow[]): JsonObject | undefined {
  if (rows.length === 0) return undefined;
  const result: JsonObject = {};
  for (const row of rows) if (!Object.hasOwn(result, row.key)) result[row.key] = row.value;
  return result;
}

/**
 * Rows live in local state with stable ids: a JS object would merge duplicate
 * keys while typing and reorder integer-like keys, moving focus between rows.
 */
function MapEditor({ field, closure, depth, value, onChange }: EditorProps<Json> & { field: FieldInfo; closure: TypeClosure; depth: number }) {
  const nextId = useRef(0);
  const toRows = (source: Json | undefined): MapRow[] =>
    Object.entries(isObject(source) ? source : {}).map(([key, item]) => ({ id: nextId.current++, key, value: item }));
  const [rows, setRows] = useState<MapRow[]>(() => toRows(value));
  useEffect(() => {
    if (JSON.stringify(serializeRows(rows)) !== JSON.stringify(isObject(value) ? value : undefined)) setRows(toRows(value));
    // Only external changes resync; our own writes already match the rows.
  }, [value]);
  const update = (next: MapRow[]) => {
    setRows(next);
    onChange(serializeRows(next));
  };
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  const { entries, onExited, remove } = usePresenceRemovals(rows, (row) => String(row.id));
  return (
    <div className="space-y-2">
      {entries.length === 0 ? <p className="text-xs text-muted-foreground">No entries.</p> : null}
      {entries.map(({ key, item: row, exiting }) => {
        const duplicate = !exiting && (counts.get(row.key) ?? 0) > 1;
        return (
          <PresenceRow key={key} className={cn("flex items-start gap-2 rounded-md", FOCUS_RING)} fieldRow="item" exiting={exiting} onExited={() => onExited(key)}>
            <input
              className={cn(inputClass, "w-40 shrink-0 font-mono text-[13px]", duplicate && "border-destructive")}
              value={row.key}
              placeholder={`key (${field.mapKey})`}
              title={duplicate ? "Duplicate key: only the first entry is sent" : undefined}
              spellCheck={false}
              onChange={(event) => update(rows.map((current) => (current.id === row.id ? { ...current, key: event.target.value } : current)))}
            />
            <div className="min-w-0 flex-1">
              <ElementEditor
                field={field}
                closure={closure}
                depth={depth}
                value={row.value}
                keepEmpty
                onChange={(next) => update(rows.map((current) => (current.id === row.id ? { ...current, value: next ?? defaultElement(field, closure) } : current)))}
              />
            </div>
            <RemoveButton
              label={`Remove ${row.key || "entry"}`}
              onClick={() => {
                remove(key);
                update(rows.filter((current) => current.id !== row.id));
              }}
            />
          </PresenceRow>
        );
      })}
      <AddButton label="Add entry" onClick={() => update([...rows, { id: nextId.current++, key: "", value: defaultElement(field, closure) }])} />
    </div>
  );
}

function FieldRow({
  field,
  closure,
  depth,
  message,
  onChange,
  inOneof,
}: {
  field: FieldInfo;
  closure: TypeClosure;
  depth: number;
  message: JsonObject;
  onChange: (next: JsonObject) => void;
  inOneof?: boolean;
}) {
  const value = readField(message, field);
  const set = value !== undefined;
  const update = (next: Json | undefined) => onChange(writeField(message, field, next));
  const clear = () => update(undefined);

  if (field.cardinality === "list") {
    const count = Array.isArray(value) ? value.length : 0;
    return (
      <Section field={field} set={set} summary={count > 0 ? `${count} item${count === 1 ? "" : "s"}` : undefined} onClear={clear}>
        <ListEditor field={field} closure={closure} depth={depth} value={value} onChange={update} />
      </Section>
    );
  }
  if (field.cardinality === "map") {
    const count = isObject(value) ? Object.keys(value).length : 0;
    return (
      <Section field={field} set={set} summary={count > 0 ? `${count} entr${count === 1 ? "y" : "ies"}` : undefined} onClear={clear}>
        <MapEditor field={field} closure={closure} depth={depth} value={value} onChange={update} />
      </Section>
    );
  }
  if (isMessageEditor(field)) {
    if (!set) {
      return (
        <InlineRow field={field} set={false} onClear={clear}>
          <AddButton label={`Set ${elementLabel(field)}`} navRow={false} onClick={() => update({})} />
        </InlineRow>
      );
    }
    return (
      <Section field={field} set onClear={clear}>
        <ElementEditor field={field} closure={closure} depth={depth} value={value} onChange={(next) => update(next ?? {})} />
      </Section>
    );
  }
  return (
    <InlineRow field={field} set={set} onClear={clear}>
      <ElementEditor field={field} closure={closure} depth={depth} value={value} onChange={update} keepEmpty={inOneof || field.optional} />
    </InlineRow>
  );
}

function OneofEditor({
  name,
  members,
  closure,
  depth,
  message,
  onChange,
}: {
  name: string;
  members: FieldInfo[];
  closure: TypeClosure;
  depth: number;
  message: JsonObject;
  onChange: (next: JsonObject) => void;
}) {
  const chosen = members.find((member) => readField(message, member) !== undefined);
  const choose = (jsonName: string) => {
    let next = message;
    for (const member of members) next = writeField(next, member, undefined);
    const member = members.find((candidate) => candidate.jsonName === jsonName);
    onChange(member === undefined ? next : writeField(next, member, defaultElement(member, closure)));
  };
  return (
    <div className="py-1">
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
        <div {...FIELD_ROW} className={cn("grid grid-cols-[minmax(8rem,15rem)_minmax(0,1fr)_1.5rem] items-center gap-x-3 rounded-md", REVEAL_HOST, FOCUS_RING)}>
          <span className="flex items-baseline gap-2 text-sm">
            <span className="text-foreground/80">{name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">one of</span>
          </span>
          <ChoiceSelect
            value={chosen?.jsonName ?? ""}
            choices={members.map((member) => ({ value: member.jsonName, label: `${member.jsonName} · ${typeLabel(member)}`, title: member.comment }))}
            onChange={choose}
          />
          <div>{chosen !== undefined ? <ClearButton label={`Clear ${name}`} onClick={() => choose("")} /> : null}</div>
        </div>
        {chosen !== undefined ? (
          <Appear key={chosen.jsonName} className="mt-1">
            <FieldRow field={chosen} closure={closure} depth={depth} message={message} onChange={onChange} inOneof />
          </Appear>
        ) : null}
      </div>
    </div>
  );
}

export function MessageEditor({
  typeName,
  closure,
  depth = 0,
  cascade = depth === 0,
  value,
  onChange,
}: {
  typeName: string;
  closure: TypeClosure;
  depth?: number;
  /** Cascade the fields in when the editor mounts; for the top of a form. */
  cascade?: boolean;
  value: JsonObject;
  onChange: (next: JsonObject) => void;
}) {
  const message = closure.messages[typeName];
  if (message === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {typeName} is not in the loaded descriptors{closure.truncated ? " (type list truncated)" : ""}.
      </p>
    );
  }
  if (message.fields.length === 0) return <p className="py-1 text-sm text-muted-foreground">This message has no fields.</p>;
  const seenOneofs = new Set<string>();
  const rows: ReactElement[] = [];
  for (const field of message.fields) {
    if (field.oneof === undefined) {
      rows.push(<FieldRow key={field.number} field={field} closure={closure} depth={depth} message={value} onChange={onChange} />);
      continue;
    }
    if (seenOneofs.has(field.oneof)) continue;
    seenOneofs.add(field.oneof);
    const members = message.fields.filter((candidate) => candidate.oneof === field.oneof);
    rows.push(<OneofEditor key={`oneof:${field.oneof}`} name={field.oneof} members={members} closure={closure} depth={depth} message={value} onChange={onChange} />);
  }
  if (depth > 0) return <div>{rows}</div>;
  return (
    <EntranceScope>
      {/* Form boxes are typed into, not edited: one Escape returns to the field cursor. */}
      <div data-vim-ignore="">
        {cascade
          ? rows.map((row, index) => (
              <div key={row.key} className={cx(enter.rise, STAGGER)} style={stagger(index)}>
                {row}
              </div>
            ))
          : rows}
      </div>
    </EntranceScope>
  );
}
