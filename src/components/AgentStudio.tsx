import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";
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

export default function AgentStudio() {
  const agents = useEmployer((s) => s.agents);
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncBusy, setSyncBusy] = useState<null | "export" | "import">(null);
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
          <span>Roster ({agents.length})</span>
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
            return (
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
                    title={a.model ? `Pinned model: ${a.model}` : "Uses the connection's default model"}
                  >
                    {a.model || "default"}
                  </span>
                  <button
                    className="ml-auto text-xs uppercase tracking-wider text-text-muted hover:text-danger"
                    onClick={async () => {
                      await api.deleteAgent(a.id);
                      await refreshAgents();
                    }}
                  >
                    terminate
                  </button>
                </div>
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}