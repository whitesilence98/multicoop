import { useState } from "react";
import { api, Agent } from "../lib/api";
import { useEmployer } from "../lib/store";
import { useSettingsStore } from "../store/useSettingsStore";

const TOOL_OPTIONS = ["read_file", "write_file", "list_dir", "web_search", "terminal"];

/** Model options for the selector: pinned models from the settings panel
 * (added_models) first, then the fetched /v1/models catalog. */
function useModelOptions() {
  const addedModels = useSettingsStore((s) => s.form.added_models);
  const fetched = useSettingsStore((s) => s.models);
  const seen = new Set<string>();
  const pinned = addedModels.filter((m) => !seen.has(m) && seen.add(m));
  const catalog = fetched.filter((m) => !seen.has(m) && seen.add(m));
  return { pinned, catalog };
}

function ModelSelect({
  value,
  onChange,
}: {
  value: string;              // "" = default
  onChange: (m: string) => void;
}) {
  const { pinned, catalog } = useModelOptions();
  return (
    <select className="field w-full" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">default (settings panel model)</option>
      {pinned.length > 0 && (
        <optgroup label="Configured (settings panel)">
          {pinned.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </optgroup>
      )}
      {catalog.length > 0 && (
        <optgroup label="Provider catalog (/v1/models)">
          {catalog.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </optgroup>
      )}
      {/* Free-form fallback when catalog is empty/offline */}
      {pinned.length === 0 && catalog.length === 0 && (
        <option value={value || "__custom__"} disabled>
          — fetch models in Settings, or leave default —
        </option>
      )}
    </select>
  );
}

export default function AgentStudio() {
  const agents = useEmployer((s) => s.agents);
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const [form, setForm] = useState({
    name: "",
    persona: "",
    permission_level: "standard" as Agent["permission_level"],
    allowed_tools: ["read_file", "list_dir"] as string[],
    color: "#6366F1",
    model: "",            // "" = default
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
      await api.createAgent({
        ...form,
        model: form.model || null, // "" -> null = default
      });
      setForm({ name: "", persona: "", permission_level: "standard", allowed_tools: ["read_file", "list_dir"], color: "#6366F1", model: "" });
      await refreshAgents();
    } finally {
      setBusy(false);
    }
  };

  const setAgentModel = async (id: number, model: string) => {
    // Optimistic inline change from the roster card.
    await api.patchAgent(id, { model: model || null });
    await refreshAgents();
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
          <div>
            <div className="text-xs text-[#64748B] font-bold uppercase tracking-wider mb-1">
              Model
            </div>
            <ModelSelect
              value={form.model}
              onChange={(m) => setForm({ ...form, model: m })}
            />
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
                {/* Assigned-model badge */}
                <span
                  className={`chip ${
                    a.model ? "text-glow border-glow" : "text-text-muted border-edge-bright"
                  }`}
                  title={a.model ? `Pinned model: ${a.model}` : "Uses the settings-panel model"}
                >
                  {a.model || "default"}
                </span>
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
              {/* Inline model reassignment */}
              <div className="mt-2">
                <ModelSelect
                  value={a.model || ""}
                  onChange={(m) => setAgentModel(a.id, m)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}