import { cx, PRESS, EntranceScope } from "bb-motion";
import { errorMessage, isClientStreaming } from "../shared/common";
import type { MethodInfo, TypeClosure } from "../shared/schema";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Notice } from "./controls";
import { MessageEditor } from "./MessageEditor";
import { PresenceRow, usePresenceValues } from "./presence";
import { hasUnsafeIntegers, isObject, type Json } from "./proto-json";

function parseRequest(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function JsonEditor({ text, onText }: { text: string; onText: (text: string) => void }) {
  return (
    <textarea
      className="min-h-64 w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      value={text}
      spellCheck={false}
      onChange={(event) => onText(event.target.value)}
      aria-label="Request JSON"
    />
  );
}

/**
 * The request as a form generated from the input type, or as raw JSON. Text the
 * form cannot round-trip (invalid JSON, unsafe integers) stays in the JSON editor.
 */
function StreamMessages({ method, closure, messages, write }: { method: MethodInfo; closure: TypeClosure; messages: Json[]; write: (value: Json) => void }) {
  const { rows, onExited, forget } = usePresenceValues(messages);
  return (
    <EntranceScope>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Messages are sent in order, then the stream closes.</p>
        {rows.map(({ key, value: entry, index, exiting }) => (
          <PresenceRow key={key} className="rounded-lg border border-border" cascadeIndex={index} exiting={exiting} onExited={() => onExited(key)}>
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-sm">
              <span className="font-medium text-foreground">Message {index + 1}</span>
              <button
                type="button"
                className={cx("rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground", PRESS)}
                aria-label={`Remove message ${index + 1}`}
                onClick={() => {
                  forget(index);
                  write(messages.filter((_entry, position) => position !== index));
                }}
              >
                <Icon name="Trash2" className="size-3.5" />
              </button>
            </div>
            <div className="px-3 py-2">
              <MessageEditor
                typeName={method.input}
                closure={closure}
                cascade={false}
                value={isObject(entry) ? entry : {}}
                onChange={(next) => write(messages.map((existing, position) => (position === index ? next : existing)))}
              />
            </div>
          </PresenceRow>
        ))}
        <Button variant="outline" size="sm" data-nav-row="item" onClick={() => write([...messages, {}])}>
          <Icon name="Plus" className="size-4" />
          Add message
        </Button>
      </div>
    </EntranceScope>
  );
}

export function RequestBody({
  method,
  closure,
  closureError,
  mode,
  text,
  onText,
}: {
  method: MethodInfo;
  closure: TypeClosure | null;
  closureError: string | null;
  mode: "form" | "json";
  text: string;
  onText: (text: string) => void;
}) {
  if (mode === "json") return <JsonEditor text={text} onText={onText} />;
  const parsed = parseRequest(text);
  if (!parsed.ok) {
    return (
      <>
        <Notice tone="error">The request is not valid JSON ({parsed.error}). Fix it here to go back to the form.</Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (hasUnsafeIntegers(text)) {
    return (
      <>
        <Notice tone="warning">
          This request has integers too large to edit in the form without losing digits, so it stays as JSON. Write 64-bit values as strings to use the form.
        </Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (closureError !== null) {
    return (
      <>
        <Notice tone="error">{closureError}</Notice>
        <JsonEditor text={text} onText={onText} />
      </>
    );
  }
  if (closure === null) return <p className="text-sm text-muted-foreground">Loading the request type…</p>;

  const write = (value: Json) => onText(JSON.stringify(value, null, 2));
  if (isClientStreaming(method.kind)) {
    const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    return <StreamMessages method={method} closure={closure} messages={messages} write={write} />;
  }
  return <MessageEditor typeName={method.input} closure={closure} value={isObject(parsed.value) ? parsed.value : {}} onChange={write} />;
}
