import { useState } from "react";
import { api, Agent } from "../lib/api";
import { useEmployer } from "../lib/store";

const TOOL_OPTIONS = ["read_file", "write_file", "list_dir", "web_search", "terminal"];

export default function AgentStudio() {
  const agents = useEmployer((s) => s.agents);
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const [form, setForm] = useState({
    name: "",
    persona: "",
    permission_level: "standard" as Agent["permission_level"],
    allowed_tools: ["read_file", "list_dir"] as string[],
    color: "#6366F1",
  });
  const [busy, setBusy] = useState(false);

  const toggleTool = (t: string) =>
    setForm((f) => ({
      ...f,
      allowed_tools: f.allowed_tools.includes(t)
        ? f.allowed_tools.filter((x) => x !== t)
        : [...f.allowed_tools, t],
    }));

  const hire = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      await api.createAgent(form);
      setForm({ name: "", persona: "", permission_level: "standard", allowed_tools: ["read_file", "list_dir"], color: "#6366F1" });
      await refreshAgents();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Hire form */}
      <div className="panel h-fit">
        <div className="section-title">Hire New Agent</div>
        <div className="mt-4 space-y-3">
          <input
            className="field w-full"
            placeholder="AGENT NAME"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <textarea
            className="field w-full h-40 resize-none"
            placeholder="PERSONA / SYSTEM PROMPT — e.g. 'You are a meticulous QA engineer...'"
            value={form.persona}
            onChange={(e) => setForm({ ...form, persona: e.target.value })}
          />
          <div className="flex gap-2">
            {(["readonly", "standard", "elevated"] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setForm({ ...form, permission_level: lvl })}
                className={`btn-ghost flex-1 ${
                  form.permission_level === lvl ? "border-glow text-white" : ""
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {TOOL_OPTIONS.map((t) => (
              <button
                key={t}
                onClick={() => toggleTool(t)}
                className={`btn-ghost ${
                  form.allowed_tools.includes(t) ? "border-neon-dim text-neon" : ""
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <button className="btn-primary w-full" onClick={hire} disabled={busy || !form.name.trim()}>
            {busy ? "Hiring…" : "+ Hire Agent"}
          </button>
        </div>
      </div>

      {/* Roster */}
      <div className="panel h-fit">
        <div className="section-title">Roster ({agents.length})</div>
        <div className="mt-4 space-y-3">
          {agents.map((a) => (
            <div key={a.id} className="rounded-lg border border-edge bg-inset p-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: a.color }} />
                <span className="font-bold text-sm">{a.name}</span>
                <span className="chip text-text-muted border-edge-bright">{a.permission_level}</span>
                <button
                  className="ml-auto text-xs uppercase tracking-wider text-text-muted hover:text-red-400"
                  onClick={async () => {
                    await api.deleteAgent(a.id);
                    await refreshAgents();
                  }}
                >
                  terminate
                </button>
              </div>
              <p className="mt-2 text-xs text-text-muted line-clamp-2">{a.persona || "—"}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.allowed_tools.map((t) => (
                  <span key={t} className="chip text-neon-dim border-edge-bright">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}