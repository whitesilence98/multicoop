import { useState } from "react";
import { api } from "../lib/api";
import { useEmployer } from "../lib/store";

const COLUMNS = [
  { status: "pending", label: "Pending" },
  { status: "running", label: "Running" },
  { status: "waiting_approval", label: "Waiting Approval" },
  { status: "done", label: "Done" },
] as const;

export default function TaskBoard() {
  const tasks = useEmployer((s) => s.tasks);
  const agents = useEmployer((s) => s.agents);
  const refreshTasks = useEmployer((s) => s.refreshTasks);
  const [form, setForm] = useState({ title: "", description: "", agent_id: "", priority: 0 });

  const create = async () => {
    if (!form.title.trim() || !form.agent_id) return;
    await api.createTask({
      title: form.title,
      description: form.description,
      agent_id: Number(form.agent_id),
      priority: Number(form.priority),
    });
    setForm({ title: "", description: "", agent_id: "", priority: 0 });
    await refreshTasks();
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* New task */}
      <div className="panel mb-6">
        <div className="section-title">Assign Task</div>
        <div className="mt-3 flex flex-wrap gap-2 items-end">
          <input
            className="field w-64"
            placeholder="TASK TITLE"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            className="field flex-1 min-w-64"
            placeholder="Full task description / instructions"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <select
            className="field w-44"
            value={form.agent_id}
            onChange={(e) => setForm({ ...form, agent_id: e.target.value })}
          >
            <option value="">assign to…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="field w-28"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          >
            <option value={0}>normal</option>
            <option value={5}>high</option>
            <option value={10}>urgent</option>
          </select>
          <button className="btn-primary" onClick={create} disabled={!form.title.trim() || !form.agent_id}>
            + Task
          </button>
        </div>
      </div>

      {/* Kanban */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.status || (col.status === "done" && t.status === "failed"));
          return (
            <div key={col.status} className="panel min-h-40">
              <div className="section-title">
                {col.label} ({colTasks.length})
              </div>
              <div className="mt-3 space-y-2">
                {colTasks.map((t) => {
                  const agent = agents.find((a) => a.id === t.agent_id);
                  return (
                    <div
                      key={t.id}
                      className={`rounded-lg border bg-inset p-3 ${
                        t.status === "running" ? "border-glow" : "border-edge"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">#{t.id}</span>
                        <span className="text-sm font-bold text-text-primary truncate">{t.title}</span>
                        {t.priority > 0 && (
                          <span className="chip ml-auto text-yellow-400 border-yellow-400/40">
                            p{t.priority}
                          </span>
                        )}
                      </div>
                      {agent && (
                        <div className="mt-1 text-xs text-text-muted">
                          → {agent.name}
                        </div>
                      )}
                      {t.status === "pending" && (
                        <button
                          className="btn-ghost mt-2"
                          onClick={async () => {
                            await api.dispatchTask(t.id);
                            await refreshTasks();
                          }}
                        >
                          ▶ dispatch
                        </button>
                      )}
                      {t.status === "failed" && (
                        <span className="chip mt-2 inline-block text-red-400 border-red-400/40">
                          failed
                        </span>
                      )}
                      {t.input_tokens + t.output_tokens > 0 && (
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-text-muted">
                          {((t.input_tokens + t.output_tokens) / 1000).toFixed(1)}K tok
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}