import { useEffect, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, Check, Loader2, X,
} from "lucide-react";
import { api, Agent, ProviderProfile } from "../lib/api";
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
      <option value="">default (provider's model)</option>
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

/** Connection (provider profile) selector. "default" = runtime connection. */
function ProviderSelect({
  value,
  profiles,
  onChange,
}: {
  value: string;              // provider_id, "default" = runtime
  profiles: ProviderProfile[];
  onChange: (id: string) => void;
}) {
  return (
    <select className="field w-full" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="default">runtime (settings panel)</option>
      {profiles.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name} · {p.kind}
          {p.is_default ? " ★" : ""}
        </option>
      ))}
    </select>
  );
}

/** Inline edit form for one roster agent (PATCH on save). */
function AgentEditForm({
  agent, profiles, onDone,
}: {
  agent: Agent;
  profiles: ProviderProfile[];
  onDone: () => void;
}) {
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const [draft, setDraft] = useState({
    name: agent.name,
    persona: agent.persona,
    permission_level: agent.permission_level,
    allowed_tools: [...agent.allowed_tools],
    color: agent.color,
    provider_id: agent.provider_id || "default",
    model: agent.model || "",
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patchAgent(agent.id, {
        name: draft.name.trim() || agent.name,
        persona: draft.persona,
        permission_level: draft.permission_level,
        allowed_tools: draft.allowed_tools,
        color: draft.color,
        provider_id: draft.provider_id,
        model: draft.model || null,
      });
      await refreshAgents();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = (t: string) =>
    setDraft((d) => ({
      ...d,
      allowed_tools: d.allowed_tools.includes(t)
        ? d.allowed_tools.filter((x) => x !== t)
        : [...d.allowed_tools, t],
    }));

  return (
    <div className="mt-2.5 rounded-lg border border-glow/40 bg-panel/60 p-3 space-y-2.5">
      <input
        className="field w-full text-sm"
        placeholder="AGENT NAME"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <textarea
        className="field w-full h-24 resize-none text-xs leading-relaxed"
        placeholder="PERSONA / SYSTEM PROMPT"
        value={draft.persona}
        onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
      />
      <div className="flex gap-1.5">
        {(["readonly", "standard", "elevated"] as const).map((lvl) => (
          <button
            key={lvl}
            className={`btn-ghost flex-1 text-[10px] py-1 ${
              draft.permission_level === lvl ? "border-glow text-white" : ""
            }`}
            onClick={() => setDraft({ ...draft, permission_level: lvl })}
          >
            {lvl}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TOOL_OPTIONS.map((t) => (
          <button
            key={t}
            className={`btn-ghost text-[10px] py-1 ${
              draft.allowed_tools.includes(t) ? "border-neon-dim text-neon" : ""
            }`}
            onClick={() => toggleTool(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {/* color */}
      <div className="flex items-center gap-1.5">
        {["#00FF9D", "#6366F1", "#F59E0B", "#F472B6", "#38BDF8", "#F87171"].map((c) => (
          <button
            key={c}
            className={`w-4 h-4 rounded-full border ${
              draft.color.toLowerCase() === c.toLowerCase() ? "border-white" : "border-transparent"
            }`}
            style={{ background: c }}
            onClick={() => setDraft({ ...draft, color: c })}
            title={c}
          />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <ProviderSelect
          value={draft.provider_id}
          profiles={profiles}
          onChange={(id) => setDraft({ ...draft, provider_id: id })}
        />
        <ModelSelect
          value={draft.model}
          onChange={(m) => setDraft({ ...draft, model: m })}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost text-[10px]" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn-primary flex items-center gap-1.5 text-[10px]"
          onClick={save}
          disabled={busy || !draft.name.trim()}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Save
        </button>
      </div>
    </div>
  );
}

export default function AgentStudio() {
  const agents = useEmployer((s) => s.agents);
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncBusy, setSyncBusy] = useState<null | "export" | "import">(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "",
    persona: "",
    permission_level: "standard" as Agent["permission_level"],
    allowed_tools: ["read_file", "list_dir"] as string[],
    color: "#6366F1",
    provider_id: "default",
    model: "",            // "" = default
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProviders().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const defaultProviderId = profiles.find((p) => p.is_default)?.id;

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
        provider_id: form.provider_id === "default" && defaultProviderId != null
          ? String(defaultProviderId)
          : form.provider_id,
        model: form.model || null, // "" -> null = default
      });
      setForm({ name: "", persona: "", permission_level: "standard", allowed_tools: ["read_file", "list_dir"], color: "#6366F1", provider_id: "default", model: "" });
      await refreshAgents();
    } finally {
      setBusy(false);
    }
  };

  const patchAgent = async (id: number, patch: Partial<Pick<Agent, "provider_id" | "model">>) => {
    // Optimistic inline change from the roster card.
    await api.patchAgent(id, patch);
    await refreshAgents();
  };

  const runSync = async (dir: "export" | "import") => {
    setSyncBusy(dir);
    setSyncNote(null);
    try {
      const r =
        dir === "export"
          ? await api.exportClaudeAgents()
          : await api.importClaudeAgents();
      const parts: string[] = [];
      if (dir === "export") {
        parts.push(`exported ${r.exported.length} → ${r.target_dir}`);
        if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
      } else {
        if (r.created.length) parts.push(`created: ${r.created.join(", ")}`);
        if (r.updated.length) parts.push(`updated: ${r.updated.join(", ")}`);
        if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
        if (!r.created.length && !r.updated.length) parts.push("no changes");
      }
      setSyncNote({ ok: true, text: parts.join(" · ") });
      if (dir === "import") await refreshAgents();
    } catch (e) {
      setSyncNote({ ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSyncBusy(null);
      setTimeout(() => setSyncNote(null), 8000);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Sync toast */}
      {syncNote && (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-md rounded-lg border px-4 py-3 text-xs font-mono shadow-lg ${
            syncNote.ok
              ? "border-neon-dim bg-neon/10 text-neon"
              : "border-danger/50 bg-danger/10 text-danger"
          }`}
        >
          {syncNote.ok ? "✓ " : "✗ "}
          {syncNote.text}
        </div>
      )}

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
            className="field w-full h-40 resize-none leading-relaxed"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-[#64748B] font-bold uppercase tracking-wider mb-1">
                Connection
              </div>
              <ProviderSelect
                value={form.provider_id}
                profiles={profiles}
                onChange={(id) => setForm({ ...form, provider_id: id })}
              />
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
          </div>
          <button className="btn-primary w-full" onClick={hire} disabled={busy || !form.name.trim()}>
            {busy ? "Hiring…" : "+ Hire Agent"}
          </button>
        </div>
      </div>

      {/* Roster */}
      <div className="panel h-fit">
        <div className="section-title flex items-center justify-between">
          <span>
            Roster ({agents.length}) · {agents.filter((a) => {
              const p = profiles.find((q) => String(q.id) === a.provider_id);
              return Boolean(a.model || p?.default_model);
            }).length} active
          </span>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost flex items-center gap-1.5 text-[10px]"
              onClick={() => runSync("import")}
              disabled={syncBusy != null}
              title="Load agent definitions from ~/.claude/agents/*.md"
            >
              {syncBusy === "import" ? <Loader2 size={11} className="animate-spin" /> : <ArrowDownToLine size={11} />}
              Import
            </button>
            <button
              className="btn-ghost flex items-center gap-1.5 text-[10px]"
              onClick={() => runSync("export")}
              disabled={syncBusy != null}
              title="Write the roster to ~/.claude/agents/*.md (Claude Code subagent format, existing files are replaced)"
            >
              {syncBusy === "export" ? <Loader2 size={11} className="animate-spin" /> : <ArrowUpFromLine size={11} />}
              Export
            </button>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {agents.map((a) => {
            const provider = profiles.find((p) => String(p.id) === a.provider_id);
            // Active = has an assigned model (own pin OR provider default).
            const active = Boolean(a.model || provider?.default_model);
            const editing = editId === a.id;
            return (
              <div key={a.id} className={`rounded-lg border bg-inset p-3 ${active ? "border-neon-dim/60" : "border-edge opacity-75"}`}>
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      background: active ? a.color : "#2A2F45",
                      boxShadow: active ? `0 0 6px ${a.color}` : "none",
                    }}
                    title={active ? "active — model assigned" : "inactive — no model assigned"}
                  />
                  <span className="font-bold text-sm">{a.name}</span>
                  <span className="chip text-text-muted border-edge-bright">{a.permission_level}</span>
                  {/* Assigned-model badge */}
                  <span
                    className={`chip ${
                      active ? "text-glow border-glow" : "text-warn border-warn/50"
                    }`}
                    title={
                      active
                        ? a.model
                          ? `Pinned model: ${a.model}`
                          : `Provider default: ${provider?.default_model}`
                        : "Inactive — no model assigned (assign one below to activate)"
                    }
                  >
                    {a.model || provider?.default_model || "inactive"}
                  </span>
                  <button
                    className="ml-auto text-xs uppercase tracking-wider text-text-muted hover:text-neon"
                    onClick={() => setEditId(editing ? null : a.id)}
                    title="Edit this agent"
                  >
                    {editing ? "close" : "edit"}
                  </button>
                  {confirmDelete === a.id ? (
                    <span className="flex items-center gap-1">
                      <button
                        className="chip text-danger border-danger/60"
                        onClick={async () => {
                          setConfirmDelete(null);
                          await api.deleteAgent(a.id);
                          await refreshAgents();
                        }}
                      >
                        confirm
                      </button>
                      <button
                        className="chip text-text-muted border-edge-bright"
                        onClick={() => setConfirmDelete(null)}
                      >
                        cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="text-xs uppercase tracking-wider text-text-muted hover:text-danger"
                      onClick={() => setConfirmDelete(a.id)}
                      title="Terminate this agent"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {editing ? (
                  <AgentEditForm agent={a} profiles={profiles} onDone={() => setEditId(null)} />
                ) : (
                  <>
                    <p className="mt-2 text-xs leading-relaxed text-text-muted line-clamp-2">{a.persona || "—"}</p>
                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {a.allowed_tools.map((t) => (
                        <span key={t} className="chip text-neon-dim border-edge-bright">
                          {t}
                        </span>
                      ))}
                    </div>
                    {/* Inline connection + model reassignment */}
                    <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <ProviderSelect
                        value={a.provider_id || "default"}
                        profiles={profiles}
                        onChange={(id) => patchAgent(a.id, { provider_id: id })}
                      />
                      <ModelSelect
                        value={a.model || ""}
                        onChange={(m) => patchAgent(a.id, { model: m || null })}
                      />
                    </div>
                    {provider && (
                      <div className="mt-1 text-[10px] text-text-muted font-mono truncate">
                        ↳ {provider.base_url}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}