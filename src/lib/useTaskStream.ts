import { useEffect } from "react";
import { TerminalEvent, useEmployer } from "./store";

const EVENT_KINDS = [
  "thinking_start",
  "thinking_delta",
  "text_start",
  "text_delta",
  "tool_call_start",
  "tool_input_delta",
  "tool_exec",
  "usage",
  "turn_usage",
  "log",
  "run_started",
  "run_finished",
  "run_failed",
  "approval_request",
  "ping",
  "stream_attached",
] as const;

/**
 * Subscribes to /api/tasks/{id}/stream (SSE) for every task that is
 * pending/running/waiting_approval. EventSource's built-in reconnect uses the
 * ORIGINAL url (since=0) and would replay duplicates, so we reconnect
 * manually from the last-seen event id instead.
 */
export function useTaskStreams(taskIds: number[]): void {
  const key = [...taskIds].sort().join(",");
  const pushEvent = useEmployer((s) => s.pushEvent);
  const setApproval = useEmployer((s) => s.setApproval);

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",").filter(Boolean).map(Number);
    let disposed = false;
    const lastId = new Map<number, number>();
    const sources = new Map<number, EventSource>();

    const connect = (id: number) => {
      if (disposed) return;
      const es = new EventSource(`/api/tasks/${id}/stream?since=${lastId.get(id) ?? 0}`);
      sources.set(id, es);

      const handle = (kind: string) => (e: MessageEvent) => {
        if (kind === "ping" || kind === "stream_attached") return;
        const numericId = Number(e.lastEventId) || 0;
        if (numericId > (lastId.get(id) ?? 0)) lastId.set(id, numericId);
        const payload = JSON.parse(e.data) as Record<string, unknown>;
        const ev: TerminalEvent = {
          id: numericId,
          kind,
          payload,
          ts: new Date().toISOString(),
        };
        pushEvent(id, ev);
        if (kind === "approval_request") {
          setApproval(id, {
            call_id: String(payload.call_id),
            tool: String(payload.tool),
            args: (payload.args as Record<string, unknown>) ?? {},
          });
        }
        if (kind === "run_finished" || kind === "run_failed") {
          es.close();
          sources.delete(id);
        }
      };

      for (const kind of EVENT_KINDS) {
        es.addEventListener(kind, handle(kind));
      }
      es.onerror = () => {
        // Drop and reconnect from the last-seen id (backend replays history
        // from that cursor, so nothing is lost or duplicated).
        es.close();
        sources.delete(id);
        setTimeout(() => connect(id), 1500);
      };
    };

    ids.forEach(connect);

    return () => {
      disposed = true;
      sources.forEach((s) => s.close());
    };
  }, [key, pushEvent, setApproval]);
}