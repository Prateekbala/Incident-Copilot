import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, newClientMsgId } from "../api";
import { useToast } from "../components/Toast";
import type { ServerEvent, Snapshot, StoredMessage, ToolStatus } from "../types";

export type ChatItem =
  | { kind: "message"; key: string; id: number | null; role: "user" | "assistant"; content: string; streaming: boolean }
  | { kind: "tool"; key: string; name: string; args?: unknown; status: ToolStatus; result?: unknown };

type ChatAction =
  | { type: "replace"; messages: StoredMessage[] }
  | { type: "message"; message: StoredMessage }
  | { type: "delta"; messageId: number; text: string }
  | { type: "tool"; id: string; name: string; args: unknown; status: ToolStatus; result?: unknown };

function fromStored(m: StoredMessage): ChatItem {
  if (m.role === "tool") {
    return { kind: "tool", key: `stored-${m.id}`, name: m.tool_name ?? "tool", status: /"error"/.test(m.content) ? "error" : "ok", result: m.content };
  }
  return { kind: "message", key: `m-${m.id}`, id: m.id, role: m.role, content: m.content, streaming: false };
}

function chatReducer(items: ChatItem[], action: ChatAction): ChatItem[] {
  switch (action.type) {
    case "replace":
      return action.messages.map(fromStored);
    case "message": {
      const item = fromStored(action.message);
      const idx = items.findIndex((i) => i.key === item.key);
      if (idx === -1) return [...items, item];
      const next = [...items];
      next[idx] = item;
      return next;
    }
    case "delta": {
      const key = `m-${action.messageId}`;
      const idx = items.findIndex((i) => i.key === key);
      if (idx === -1) return [...items, { kind: "message", key, id: action.messageId, role: "assistant", content: action.text, streaming: true }];
      const current = items[idx];
      if (current.kind !== "message" || !current.streaming) return items;
      const next = [...items];
      next[idx] = { ...current, content: current.content + action.text };
      return next;
    }
    case "tool": {
      const key = `t-${action.id}`;
      const item: ChatItem = { kind: "tool", key, name: action.name, args: action.args, status: action.status, result: action.result };
      const idx = items.findIndex((i) => i.key === key);
      if (idx === -1) return [...items, item];
      const next = [...items];
      next[idx] = item;
      return next;
    }
  }
}

const ACTIVE = new Set(["running", "awaiting_approval"]);

export function useIncident(incidentId: string | null, token: string) {
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [items, dispatch] = useReducer(chatReducer, []);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(
    async (withMessages = false) => {
      if (!incidentId) return;
      try {
        const snap = await api<Snapshot>(token, `/incidents/${incidentId}`);
        setSnapshot(snap);
        if (withMessages) dispatch({ type: "replace", messages: snap.messages });
      } catch (err) {
        toast.error(`Could not load incident: ${(err as Error).message}`);
      }
    },
    [incidentId, token, toast],
  );

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(false), 300);
  }, [refresh]);

  useEffect(() => {
    setSnapshot(null);
    dispatch({ type: "replace", messages: [] });
    if (incidentId) void refresh(true);
  }, [incidentId, refresh]);

  useEffect(() => {
    if (!incidentId) return;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handle = (evt: ServerEvent) => {
      switch (evt.type) {
        case "history":
          dispatch({ type: "replace", messages: evt.messages });
          break;
        case "user_message":
        case "assistant_message":
          dispatch({ type: "message", message: evt.message });
          break;
        case "assistant_delta":
          dispatch({ type: "delta", messageId: evt.messageId, text: evt.text });
          break;
        case "assistant_done":
          if (evt.message) dispatch({ type: "message", message: evt.message });
          break;
        case "tool_call":
          dispatch({ type: "tool", id: evt.id, name: evt.name, args: evt.args, status: evt.status, result: evt.result });
          if (evt.status !== "running") scheduleRefresh();
          break;
        case "approval_request":
          toast.info(`Approval required: ${evt.action.type} ${evt.action.target}`);
          scheduleRefresh();
          break;
        case "investigation_progress":
        case "state_update":
          scheduleRefresh();
          break;
        case "error":
          toast.error(evt.message);
          break;
      }
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/incidents/${incidentId}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEvent);
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(() => {
          void refresh(false);
          connect();
        }, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [incidentId, token, refresh, scheduleRefresh, toast]);

  const investigationActive = !!snapshot?.investigation && ACTIVE.has(snapshot.investigation.status);
  useEffect(() => {
    if (!investigationActive) return;
    const id = setInterval(() => void refresh(!connected), 5000);
    return () => clearInterval(id);
  }, [investigationActive, connected, refresh]);

  const wsSend = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const send = useCallback(
    async (text: string) => {
      if (!incidentId) return;
      const clientMsgId = newClientMsgId();
      if (wsSend({ type: "user_message", clientMsgId, text })) return;
      try {
        await api(token, `/incidents/${incidentId}/messages`, { method: "POST", body: JSON.stringify({ text, clientMsgId }) });
        setTimeout(() => void refresh(true), 1500);
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [incidentId, token, refresh, toast],
  );

  const decide = useCallback(
    async (actionId: string, approved: boolean) => {
      if (!incidentId) return;
      try {
        if (!wsSend({ type: "approval_decision", clientMsgId: newClientMsgId(), actionId, approved })) {
          await api(token, `/incidents/${incidentId}/actions/${encodeURIComponent(actionId)}/decision`, {
            method: "POST",
            body: JSON.stringify({ approved }),
          });
        }
        scheduleRefresh();
      } catch (err) {
        toast.error((err as Error).message);
        throw err;
      }
    },
    [incidentId, token, scheduleRefresh, toast],
  );

  const startInvestigation = useCallback(async () => {
    if (!incidentId) return;
    try {
      const res = await api<{ investigationId: string; status: string }>(token, `/incidents/${incidentId}/investigations`, { method: "POST", body: "{}" });
      toast.info(res.status === "already_running" ? "An investigation is already running" : `Investigation ${res.investigationId} started`);
      scheduleRefresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [incidentId, token, scheduleRefresh, toast]);

  return { snapshot, items, connected, send, decide, startInvestigation, refresh };
}
