import { useEffect, useState } from "react";
import {
  Eye, EyeOff, KeyRound, Loader2, Plug, PlugZap, Plus, RefreshCw, Save,
  Server, Settings as SettingsIcon, Trash2, X,
} from "lucide-react";
import { ProxySettings, RuntimeSettings, useSettingsStore } from "../store/useSettingsStore";
import {
  KIND_LABELS, ProviderKind, useProvidersStore,
} from "../store/useProvidersStore";
import { ProviderProfile } from "../lib/api";

const MODEL_OPTIONS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

const PROTOCOLS = ["http", "https", "socks5"] as const;

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs text-[#64748B] font-bold uppercase tracking-wider">
      {children}
    </div>
  );
}

function Banner({ kind, children }: { kind: "ok" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs font-mono ${
        kind === "ok"
          ? "border-neon-dim bg-neon/10 text-neon"
          : "border-danger/50 bg-danger/10 text-danger"
      }`}
    >
      {children}
    </div>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    form, hasApiKey, apiKeyPreview, loading, saving, error, savedAt,
    testStatus, testResult, models, fetchStatus, fetchDetail,
    load, save, testConnection, fetchModels, addModel, removeModel,
    update, updateProxy,
  } = useSettingsStore();

  const [tab, setTab] = useState<"runtime" | "connections">("runtime");
  const providers = useProvidersStore();
  const [showKey, setShowKey] = useState(false);
  const [showProxyPassword, setShowProxyPassword] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<null | "ok" | "error">(null);
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "connections") void providers.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const handleSave = async () => {
    const ok = await save();
    setSaveFeedback(ok ? "ok" : "error");
    setTimeout(() => setSaveFeedback(null), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="panel w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-panel border-glow/40 p-5">
        {/* header + tabs */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="section-title flex items-center gap-2">
              <SettingsIcon size={14} />
              Connections
            </div>
            <div className="flex gap-1">
              {(["runtime", "connections"] as const).map((t) => (
                <button
                  key={t}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors ${
                    tab === t
                      ? "border-glow text-white bg-glow-dim"
                      : "border-edge-bright text-text-muted hover:text-text-primary"
                  }`}
                  onClick={() => setTab(t)}
                >
                  {t === "runtime" ? "Runtime" : "Providers"}
                </button>
              ))}
            </div>
          </div>
          <button className="btn-ghost" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        {tab === "runtime" && (
          <>
        {loading && <p className="text-xs text-text-muted">loading…</p>}
        {error && <Banner kind="error">{error}</Banner>}

        {/* ---------- provider + key ---------- */}
        <div className="space-y-4">
          <div>
            <Label>Provider / AI Engine</Label>
            <select
              className="field w-full mt-1"
              value={form.provider}
              onChange={(e) => update({ provider: e.target.value as RuntimeSettings["provider"] })}
            >
              <option value="anthropic">Anthropic Claude</option>
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="custom">Custom Endpoint</option>
            </select>
          </div>

          <div>
            <Label>API Key {hasApiKey && <span className="text-neon normal-case">· saved ({apiKeyPreview})</span>}</Label>
            <div className="relative mt-1">
              <input
                className="field w-full pr-10"
                type={showKey ? "text" : "password"}
                placeholder={hasApiKey ? "•••••••• (enter to replace)" : "sk-ant-…"}
                value={form.api_key}
                onChange={(e) => update({ api_key: e.target.value })}
              />
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "Hide" : "Show"}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <Label>Base URL / Endpoint</Label>
            <input
              className="field w-full mt-1"
              placeholder="https://api.anthropic.com"
              value={form.base_url}
              onChange={(e) => update({ base_url: e.target.value })}
            />
          </div>
        </div>

        {/* ---------- proxy ---------- */}
        <div className="mt-5 rounded-lg border border-edge bg-inset p-3">
          <div className="flex items-center justify-between">
            <Label>Proxy</Label>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs uppercase tracking-wider text-text-muted">Enable</span>
              <button
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  form.proxy.enabled ? "bg-glow" : "bg-edge-bright"
                }`}
                onClick={() => updateProxy({ enabled: !form.proxy.enabled })}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    form.proxy.enabled ? "left-4.5" : "left-0.5"
                  }`}
                  style={{ left: form.proxy.enabled ? 18 : 2 }}
                />
              </button>
            </label>
          </div>

          {form.proxy.enabled && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <Label>Protocol</Label>
                <select
                  className="field w-full mt-1"
                  value={form.proxy.protocol}
                  onChange={(e) => updateProxy({ protocol: e.target.value as ProxySettings["protocol"] })}
                >
                  {PROTOCOLS.map((p) => (
                    <option key={p} value={p}>{p.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Host / IP</Label>
                <input
                  className="field w-full mt-1"
                  placeholder="127.0.0.1"
                  value={form.proxy.host}
                  onChange={(e) => updateProxy({ host: e.target.value })}
                />
              </div>
              <div>
                <Label>Port</Label>
                <input
                  className="field w-full mt-1"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="8080"
                  value={form.proxy.port ?? ""}
                  onChange={(e) =>
                    updateProxy({ port: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </div>
              <div>
                <Label>Username (optional)</Label>
                <input
                  className="field w-full mt-1"
                  value={form.proxy.username}
                  onChange={(e) => updateProxy({ username: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <Label>Password (optional)</Label>
                <div className="relative mt-1">
                  <input
                    className="field w-full pr-10"
                    type={showProxyPassword ? "text" : "password"}
                    value={form.proxy.password}
                    onChange={(e) => updateProxy({ password: e.target.value })}
                  />
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    onClick={() => setShowProxyPassword((v) => !v)}
                  >
                    {showProxyPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---------- runtime defaults ---------- */}
        <div className="mt-6 grid grid-cols-3 gap-3">
          <div className="col-span-3">
            <Label>Model</Label>
            <input
              className="field w-full mt-1"
              list="model-options"
              value={form.model}
              onChange={(e) => update({ model: e.target.value })}
            />
            <datalist id="model-options">
              {(models.length > 0 ? models : [...form.added_models, ...MODEL_OPTIONS]).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            {/* ---- fetch action row ---- */}
            <div className="flex items-center gap-3 mt-2">
              <button
                className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-bold text-text-muted hover:text-neon transition-colors disabled:opacity-40"
                onClick={fetchModels}
                disabled={fetchStatus === "fetching" || testStatus === "testing"}
                title="Fetch available models from the provider"
              >
                {fetchStatus === "fetching" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Fetch models
              </button>
              <span className="text-[10px] text-text-muted truncate">
                {fetchStatus === "ok" && models.length > 0
                  ? `✓ ${models.length} models`
                  : fetchStatus === "failed" && fetchDetail
                  ? `✗ ${fetchDetail}`
                  : `from ${form.base_url.replace(/\/+$/, "")}/v1/models`}
              </span>
            </div>

            {/* ---- fetched catalog: click a chip to add it ---- */}
            {models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {models.map((m) => {
                  const added = form.added_models.includes(m);
                  return (
                    <button
                      key={m}
                      className={`chip transition-colors ${
                        added
                          ? "text-glow border-glow"
                          : "text-text-muted border-edge-bright hover:text-neon hover:border-neon-dim"
                      }`}
                      onClick={() => addModel(m)}
                      title={added ? "already added" : "click to add"}
                    >
                      {m}{added ? " ✓" : " +"}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ---- added-models chips ---- */}
            {form.added_models.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {form.added_models.map((m) => (
                  <span
                    key={m}
                    className="chip flex items-center gap-1 text-neon border-neon-dim"
                  >
                    {m}
                    <button
                      className="hover:text-danger transition-colors"
                      onClick={() => removeModel(m)}
                      title={`Remove ${m}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* ---- manual add (for offline endpoints) ---- */}
            <div className="mt-2 flex gap-2">
              <input
                className="field flex-1 text-xs"
                placeholder="add model manually (e.g. qwen3.5:397b)…"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel(customModel);
                    setCustomModel("");
                  }
                }}
              />
              <button
                className="btn-ghost"
                onClick={() => {
                  addModel(customModel);
                  setCustomModel("");
                }}
                disabled={!customModel.trim()}
              >
                Add
              </button>
            </div>
          </div>
          <div>
            <Label>Timeout (s)</Label>
            <input
              className="field w-full mt-1"
              type="number"
              min={5}
              max={600}
              value={form.timeout_seconds}
              onChange={(e) => update({ timeout_seconds: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Max Retries</Label>
            <input
              className="field w-full mt-1"
              type="number"
              min={0}
              max={10}
              value={form.max_retries}
              onChange={(e) => update({ max_retries: Number(e.target.value) })}
            />
          </div>
        </div>

        {/* ---------- diagnostics ---------- */}
        <div className="mt-6 flex items-center gap-3">
          <button
            className="btn-primary flex items-center gap-2"
            onClick={testConnection}
            disabled={testStatus === "testing"}
          >
            {testStatus === "testing" ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
            {testStatus === "testing" ? "Testing…" : "Test Connection"}
          </button>

          <span
            className={`chip ${
              testStatus === "ok"
                ? "text-neon border-neon-dim"
                : testStatus === "failed"
                ? "text-danger border-danger/50"
                : testStatus === "testing"
                ? "text-glow border-glow"
                : "text-text-muted border-edge-bright"
            }`}
          >
            {testStatus === "ok"
              ? `connected${testResult?.latency_ms != null ? ` · ${testResult.latency_ms}ms` : ""}`
              : testStatus === "failed"
              ? "failed"
              : testStatus === "testing"
              ? "testing…"
              : "not tested"}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {saveFeedback === "ok" && <Banner kind="ok">saved</Banner>}
            {saveFeedback === "error" && <Banner kind="error">save failed</Banner>}
            <button
              className="btn-primary flex items-center gap-2"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>

        {testResult && (
          <div className="mt-3">
            <Banner kind={testResult.ok ? "ok" : "error"}>
              {testResult.ok ? "✓ " : "✗ "}
              {testResult.detail || (testResult.ok ? "connected" : "unknown error")}
            </Banner>
          </div>
        )}
          </>
        )}

        {tab === "connections" && <ConnectionsTab />}
      </div>
    </div>
  );
}

/* ================= Providers tab ================= */

function ProviderCard({
  p, onEdit, onDelete, busy,
}: {
  p: ProviderProfile;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-edge bg-inset p-3">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            p.has_api_key || p.kind === "ollama" ? "bg-neon" : "bg-edge-bright"
          }`}
          title={p.has_api_key ? "API key saved" : "no key (open endpoint)"}
        />
        <span className="font-bold text-sm text-text-primary">{p.name}</span>
        <span className="chip text-text-muted border-edge-bright">{KIND_LABELS[p.kind]}</span>
        {p.is_default && <span className="chip text-glow border-glow">default</span>}
        <button
          className="ml-auto text-xs uppercase tracking-wider text-text-muted hover:text-neon"
          onClick={onEdit}
        >
          edit
        </button>
        <button
          className="text-xs uppercase tracking-wider text-text-muted hover:text-danger disabled:opacity-40"
          onClick={onDelete}
          disabled={busy}
          title="Remove connection (agents fall back to Runtime)"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="font-mono truncate max-w-[300px]">{p.base_url || "—"}</span>
        {p.has_api_key && <span className="font-mono text-[10px]">key {p.api_key_preview}</span>}
      </div>
      {p.added_models.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {p.added_models.slice(0, 6).map((m) => (
            <span key={m} className="chip text-neon-dim border-edge-bright">{m}</span>
          ))}
          {p.added_models.length > 6 && (
            <span className="chip text-text-muted border-edge-bright">
              +{p.added_models.length - 6}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderEditor() {
  const {
    editingId, draft, test, fetch, fetchedModels,
    updateDraft, cancelEdit, save, testDraft, fetchModels, addModel, removeModel,
  } = useProvidersStore();
  const [showKey, setShowKey] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const preset = KIND_PRESETS[draft.kind];

  return (
    <div className="rounded-lg border border-glow/40 bg-inset p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wider text-glow">
          {editingId == null ? "New Connection" : `Edit: ${draft.name || "…"}`}
        </div>
        <button className="btn-ghost" onClick={cancelEdit} title="Cancel">
          <X size={13} />
        </button>
      </div>

      {/* kind presets */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => (
          <button
            key={k}
            className={`btn-ghost ${
              draft.kind === k ? "border-neon-dim text-neon" : ""
            }`}
            onClick={() =>
              updateDraft({ kind: k, base_url: KIND_PRESETS[k].base_url })
            }
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Name</Label>
          <input
            className="field w-full mt-1"
            placeholder="e.g. Ollama Cloud"
            value={draft.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
          />
        </div>
        <div>
          <Label>Base URL</Label>
          <input
            className="field w-full mt-1"
            placeholder={draft.kind === "ollama" ? "http://localhost:11434" : "https://…"}
            value={draft.base_url}
            onChange={(e) => updateDraft({ base_url: e.target.value })}
          />
        </div>
      </div>

      <div>
        <Label>API Key {preset.key_needed ? "" : "· optional"}</Label>
        <div className="relative mt-1">
          <input
            className="field w-full pr-10"
            type={showKey ? "text" : "password"}
            placeholder="sk-… / ollama key (leave empty to keep saved)"
            value={draft.api_key}
            onChange={(e) => updateDraft({ api_key: e.target.value })}
          />
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>

      {/* default model + fetched catalog */}
      <div>
        <Label>Default Model</Label>
        <input
          className="field w-full mt-1"
          list="provider-draft-models"
          placeholder="model id used when an agent has no pin"
          value={draft.default_model}
          onChange={(e) => updateDraft({ default_model: e.target.value })}
        />
        <datalist id="provider-draft-models">
          {fetchedModels.map((m) => <option key={m} value={m} />)}
        </datalist>

        <div className="flex items-center gap-3 mt-2">
          <button
            className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-bold text-text-muted hover:text-neon transition-colors disabled:opacity-40"
            onClick={fetchModels}
            disabled={fetch.status === "fetching"}
          >
            {fetch.status === "fetching" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Fetch models
          </button>
          <span className="text-[10px] text-text-muted truncate">
            {fetch.status === "ok" && fetchedModels.length > 0
              ? `✓ ${fetchedModels.length} models`
              : fetch.status === "failed" && fetch.detail
              ? `✗ ${fetch.detail}`
              : ""}
          </span>
        </div>

        {fetchedModels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
            {fetchedModels.map((m) => {
              const added = draft.added_models.includes(m);
              return (
                <button
                  key={m}
                  className={`chip transition-colors ${
                    added
                      ? "text-glow border-glow"
                      : "text-text-muted border-edge-bright hover:text-neon hover:border-neon-dim"
                  }`}
                  onClick={() => addModel(m)}
                  title={added ? "already added" : "click to add"}
                >
                  {m}{added ? " ✓" : " +"}
                </button>
              );
            })}
          </div>
        )}

        {draft.added_models.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {draft.added_models.map((m) => (
              <span key={m} className="chip flex items-center gap-1 text-neon border-neon-dim">
                {m}
                <button className="hover:text-danger transition-colors" onClick={() => removeModel(m)}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 cursor-pointer w-fit">
        <button
          className={`relative w-9 h-5 rounded-full transition-colors ${
            draft.is_default ? "bg-glow" : "bg-edge-bright"
          }`}
          onClick={(e) => {
            e.preventDefault();
            updateDraft({ is_default: !draft.is_default });
          }}
        >
          <span
            className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
            style={{ left: draft.is_default ? 18 : 2 }}
          />
        </button>
        <span className="text-xs uppercase tracking-wider text-text-muted">
          Default for new agents
        </span>
      </label>

      {/* test + save */}
      <div className="flex items-center gap-3 pt-1">
        <button
          className="btn-ghost flex items-center gap-2"
          onClick={testDraft}
          disabled={test.status === "testing" || !draft.base_url.trim()}
        >
          {test.status === "testing" ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
          Test
        </button>
        <span
          className={`chip ${
            test.status === "ok"
              ? "text-neon border-neon-dim"
              : test.status === "failed"
              ? "text-danger border-danger/50"
              : test.status === "testing"
              ? "text-glow border-glow"
              : "text-text-muted border-edge-bright"
          }`}
        >
          {test.status === "ok"
            ? `connected${test.latency_ms != null ? ` · ${test.latency_ms}ms` : ""}`
            : test.status === "failed"
            ? "failed"
            : test.status === "testing"
            ? "testing…"
            : "not tested"}
        </span>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={cancelEdit}>Cancel</button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={() => void save()}
            disabled={!draft.name.trim()}
          >
            <Save size={13} />
            Save
          </button>
        </div>
      </div>
      {test.detail && (
        <Banner kind={test.status === "ok" ? "ok" : "error"}>
          {test.status === "ok" ? "✓ " : "✗ "}
          {test.detail}
        </Banner>
      )}
    </div>
  );
}

function ConnectionsTab() {
  const {
    profiles, loading, error, editingId, startNew, startEdit, remove, save,
  } = useProvidersStore();

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted leading-relaxed">
        Named API connections — Anthropic keys, Ollama cloud, local endpoints. Assign one to
        each agent in the <span className="text-neon">Studio</span>; agents on{" "}
        <span className="text-glow">Runtime</span> use the settings below.
      </p>

      {error && <Banner kind="error">{error}</Banner>}

      {editingId == null && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => (
            <button
              key={k}
              className="btn-ghost flex items-center gap-1.5"
              onClick={() => startNew(k)}
            >
              <Plus size={12} />
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}

      <ProviderEditor />

      {editingId != null && (
        <button className="btn-ghost flex items-center gap-1.5" onClick={() => startNew()}>
          <Plus size={12} />
          New connection instead
        </button>
      )}

      <div className="space-y-2">
        <Label>{profiles.length} saved</Label>
        {loading && <p className="text-xs text-text-muted">loading…</p>}
        {!loading && profiles.length === 0 && (
          <p className="text-xs text-text-muted/70 italic">
            No saved connections yet — add one above.
          </p>
        )}
        {profiles.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            busy={false}
            onEdit={() => startEdit(p)}
            onDelete={async () => {
              await remove(p.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}