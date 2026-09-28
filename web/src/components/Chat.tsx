import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatItem } from "../hooks/useIncident";
import { useVoice } from "../hooks/useVoice";
import type { Snapshot } from "../types";
import { Markdown } from "./Markdown";
import { StatusBadge } from "./StatusBadge";

interface Props {
  token: string;
  incidentId: string | null;
  snapshot: Snapshot | null;
  items: ChatItem[];
  connected: boolean;
  onSend(text: string): void;
  onStartInvestigation(): void;
}

function ToolChip({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const result = item.result === undefined ? "" : typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2);
  const args = item.args ? JSON.stringify(item.args) : "";
  return (
    <div className={`tool ${item.status}`} onClick={() => setOpen((o) => !o)}>
      <span>
        tool <strong>{item.name}</strong> {args.length > 160 ? `${args.slice(0, 160)}…` : args}
      </span>
      {open && result && <pre>{result.slice(0, 4000)}</pre>}
    </div>
  );
}

export function Chat({ token, incidentId, snapshot, items, connected, onSend, onStartInvestigation }: Props) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onTranscript = useCallback((t: string) => {
    setText(t);
    inputRef.current?.focus();
  }, []);
  const voice = useVoice(incidentId, token, onTranscript);
  const disabled = !incidentId;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const incident = snapshot?.incident;

  return (
    <section className="chat">
      <div className="chat-header">
        <div>
          <div className="title">{incident?.title ?? "Select or open an incident"}</div>
          {incident && (
            <div className="muted small">
              <StatusBadge status={incident.status} /> {incident.severity ?? ""} · {incident.service ?? "service unknown"} · scenario {incident.scenario}
            </div>
          )}
        </div>
        <div className="header-actions">
          <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "live" : "offline"}</span>
          <button className="secondary" onClick={onStartInvestigation} disabled={disabled}>
            Start investigation
          </button>
        </div>
      </div>

      <div className="messages" ref={scrollRef}>
        {items.map((item) =>
          item.kind === "tool" ? (
            <ToolChip key={item.key} item={item} />
          ) : (
            <div key={item.key} className={`msg ${item.role}`}>
              {item.streaming ? <span className="pre-wrap">{item.content}</span> : <Markdown>{item.content}</Markdown>}
            </div>
          ),
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <button
          type="button"
          className={`icon ${voice.recording ? "recording" : ""}`}
          title="Hold to talk"
          disabled={disabled || voice.transcribing}
          onMouseDown={voice.start}
          onMouseUp={voice.stop}
          onMouseLeave={() => voice.recording && voice.stop()}
        >
          {voice.transcribing ? "…" : "🎙️"}
        </button>
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the problem or ask a question…"
        />
        <button type="submit" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
