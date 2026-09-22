import { useEffect, useState } from "react";
import {
  Eye, EyeOff, KeyRound, Loader2, Plug, PlugZap, RefreshCw, Save, Server,
  Settings as SettingsIcon, X,
} from "lucide-react";
import { ProxySettings, RuntimeSettings, useSettingsStore } from "../store/useSettingsStore";

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
          : "border-red-500/50 bg-red-500/10 text-red-400"
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
    load, save, testConnection, fetchModels, update, updateProxy,
  } = useSettingsStore();

  const [showKey, setShowKey] = useState(false);
  const [showProxyPassword, setShowProxyPassword] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<null | "ok" | "error">(null);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    const ok = await save();
    setSaveFeedback(ok ? "ok" : "error");
    setTimeout(() => setSaveFeedback(null), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="panel w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-panel border-glow/40">
        {/* header */}
        <div className="flex items-center justify-between mb-4">
          <div className="section-title flex items-center gap-2">
            <SettingsIcon size={14} />
            API &amp; Proxy Configuration
          </div>
          <button className="btn-ghost" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        {loading && <p className="text-xs text-text-muted">loading…</p>}
        {error && <Banner kind="error">{error}</Banner>}

        {/* ---------- provider + key ---------- */}
        <div className="space-y-3">
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
            <div className="mt-3 grid grid-cols-2 gap-3">
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
        <div className="mt-5 grid grid-cols-3 gap-3">
          <div className="col-span-3">
            <div className="flex items-center justify-between">
              <Label>Model</Label>
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
                Fetch Models
              </button>
            </div>
            <input
              className="field w-full mt-1"
              list="model-options"
              value={form.model}
              onChange={(e) => update({ model: e.target.value })}
            />
            <datalist id="model-options">
              {(models.length > 0 ? models : MODEL_OPTIONS).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {fetchStatus === "ok" && models.length > 0 && (
              <div className="text-[10px] uppercase tracking-wider text-neon mt-1">
                ✓ {models.length} models available
              </div>
            )}
            {fetchStatus === "failed" && fetchDetail && (
              <div className="text-[10px] uppercase tracking-wider text-red-400 mt-1">
                ✗ {fetchDetail}
              </div>
            )}
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
        <div className="mt-5 flex items-center gap-3">
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
                ? "text-red-400 border-red-400/50"
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
      </div>
    </div>
  );
}