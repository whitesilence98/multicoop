import { useEffect, useRef, useState } from "react";
import { useEmployer, TerminalEvent } from "../lib/store";

/** Renders one terminal event with cyberpunk styling. */
function EventLine({ ev }: { ev: TerminalEvent }) {
  const p = ev.payload as Record<string, string>;
  switch (ev.kind) {
    case "thinking_start":
      return <div className="text-text-muted italic mt-2">▸ reasoning…</div>;
    case "thinking_delta":
      return <div className="text-text-muted/80 italic whitespace-pre-wrap">{p.text}</div>;
    case "text_delta":
      return <span className="whitespace-pre-wrap">{p.text}</span>;
    case "tool_call_start":
      return <div className="mt-2 text-neon font-bold">⚙ {p.name}</div>;
    case "tool_input_delta":
      return null; // noisy — tool_exec shows the parsed args
    case "tool_exec":
      return (
        <div className="text-xs text-glow border-l-2 border-glow pl-2 my-1">
          <span className="text-text-muted">args:</span>{" "}
          <span className="whitespace-pre-wrap">{JSON.stringify(p.args)}</span>
        </div>
      );
    case "log":
      return <div className="text-yellow-400/80 text-xs">{p.text}</div>;
    case "turn_usage":
      return (
        <div className="text-[10px] uppercase tracking-wider text-text-muted">
          ⇄ in {p.input_tokens} · cache {p.cache_read} · out {p.output_tokens}
        </div>
      );
    case "run_started":
      return <div className="text-neon font-bold">▶ run started — {p.task}</div>;
    case "run_finished":
      return <div className="text-neon font-bold mt-2">✓ finished</div>;
    case "run_failed":
      return <div className="text-red-400 font-bold mt-2">✗ failed — {p.error}</div>;
    case "approval_request":
      return <div className="text-yellow-400 font-bold">⏸ approval requested — {p.tool}</div>;
    default:
      return null;
  }
}

export default function AgentTerminal() {
  const tasks = useEmployer((s) => s.tasks);
  const streams = useEmployer((s) => s.streams);
  const [selected, setSelected] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeTasks = tasks.filter((t) => (streams[t.id]?.length ?? 0) > 0);
  const current = selected ?? activeTasks[0]?.id ?? null;
  const events = current ? streams[current] ?? [] : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length]);

  return (
    <div className="h-full flex">
      {/* Task selector */}
      <aside className="w-56 border-r border-edge bg-panel/60 p-3 space-y-1 overflow-y-auto">
        <div className="section-title mb-2">Streams</div>
        {activeTasks.length === 0 && (
          <p className="text-xs text-text-muted">No live streams. Dispatch a task.</p>
        )}
        {activeTasks.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-xs truncate ${
              current === t.id ? "bg-glow-dim text-white" : "text-text-muted hover:text-text-primary"
            }`}
          >
            #{t.id} {t.title}
          </button>
        ))}
      </aside>

      {/* Terminal */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-edge bg-panel/60 px-4 py-2">
          <span className="section-title">
            Live Agent Terminal {current !== null && <span className="text-text-muted">/ task #{current}</span>}
          </span>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 bg-inset text-sm leading-relaxed"
        >
          {events.length === 0 ? (
            <span className="text-text-muted">
              ▍ awaiting agent output…
            </span>
          ) : (
            <div className="space-y-0.5">
              {events.map((ev, i) => (
                <EventLine key={`${ev.id}-${i}`} ev={ev} />
              ))}
              <span className="inline-block w-2 h-4 bg-neon animate-pulse" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}