import { create } from "zustand";

export interface ProxySettings {
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number | null;
  username: string;
  password: string; // empty string = keep stored password
}

export interface RuntimeSettings {
  provider: "anthropic" | "openai_compatible" | "custom";
  api_key: string; // empty string = keep existing on save
  base_url: string;
  model: string;
  timeout_seconds: number;
  max_retries: number;
  proxy: ProxySettings;
}

export type TestStatus = "idle" | "testing" | "ok" | "failed";

export interface SettingsOut {
  provider: string;
  base_url: string;
  model: string;
  timeout_seconds: number;
  max_retries: number;
  proxy: {
    enabled: boolean;
    protocol: string;
    host: string;
    port: number | null;
    username: string;
    password?: string;
  };
  has_api_key: boolean;
  api_key_preview: string;
}

export interface TestResult {
  ok: boolean;
  latency_ms: number | null;
  status_code: number | null;
  detail: string;
}

export type FetchStatus = "idle" | "fetching" | "ok" | "failed";

interface SettingsState {
  // Form state
  form: RuntimeSettings;
  // Server state
  hasApiKey: boolean;
  apiKeyPreview: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  savedAt: string | null;
  // Connection test
  testStatus: TestStatus;
  testResult: TestResult | null;
  // Model list
  models: string[];
  fetchStatus: FetchStatus;
  fetchDetail: string;

  load: () => Promise<void>;
  save: () => Promise<boolean>;
  testConnection: () => Promise<void>;
  fetchModels: () => Promise<void>;
  update: (patch: Partial<RuntimeSettings>) => void;
  updateProxy: (patch: Partial<ProxySettings>) => void;
}

const DEFAULT_FORM: RuntimeSettings = {
  provider: "anthropic",
  api_key: "",
  base_url: "https://api.anthropic.com",
  model: "claude-opus-5",
  timeout_seconds: 120,
  max_retries: 3,
  proxy: {
    enabled: false,
    protocol: "http",
    host: "",
    port: null,
    username: "",
    password: "",
  },
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  form: { ...DEFAULT_FORM, proxy: { ...DEFAULT_FORM.proxy } },
  hasApiKey: false,
  apiKeyPreview: "",
  loading: false,
  saving: false,
  error: null,
  savedAt: null,
  testStatus: "idle",
  testResult: null,
  models: [],
  fetchStatus: "idle",
  fetchDetail: "",

  load: async () => {
    set({ loading: true, error: null });
    try {
      const s = await req<SettingsOut>("/settings");
      set({
        form: {
          provider: (s.provider as RuntimeSettings["provider"]) || "anthropic",
          api_key: "",
          base_url: s.base_url,
          model: s.model,
          timeout_seconds: s.timeout_seconds,
          max_retries: s.max_retries,
          proxy: {
            enabled: s.proxy?.enabled ?? false,
            protocol: (s.proxy?.protocol as ProxySettings["protocol"]) || "http",
            host: s.proxy?.host ?? "",
            port: s.proxy?.port ?? null,
            username: s.proxy?.username ?? "",
            password: "", // never echo stored proxy password
          },
        },
        hasApiKey: s.has_api_key,
        apiKeyPreview: s.api_key_preview,
        loading: false,
      });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  save: async () => {
    set({ saving: true, error: null });
    try {
      const s = await req<SettingsOut>("/settings", {
        method: "PUT",
        body: JSON.stringify(get().form),
      });
      set({
        saving: false,
        savedAt: new Date().toISOString(),
        hasApiKey: s.has_api_key,
        apiKeyPreview: s.api_key_preview,
        // clear the key field after successful save (it lives server-side now)
        form: { ...get().form, api_key: "" },
      });
      return true;
    } catch (e) {
      set({ saving: false, error: String(e) });
      return false;
    }
  },

  testConnection: async () => {
    set({ testStatus: "testing", testResult: null });
    try {
      const r = await req<TestResult>("/settings/test-connection", {
        method: "POST",
        body: JSON.stringify(get().form),
      });
      set({ testStatus: r.ok ? "ok" : "failed", testResult: r });
    } catch (e) {
      set({
        testStatus: "failed",
        testResult: { ok: false, latency_ms: null, status_code: null, detail: String(e) },
      });
    }
  },

  fetchModels: async () => {
    set({ fetchStatus: "fetching", fetchDetail: "", models: [] });
    try {
      const r = await req<{ models: string[]; detail: string }>("/settings/models", {
        method: "POST",
        body: JSON.stringify(get().form),
      });
      set({
        fetchStatus: r.models.length > 0 ? "ok" : "failed",
        models: r.models,
        fetchDetail: r.detail,
      });
    } catch (e) {
      set({ fetchStatus: "failed", fetchDetail: String(e) });
    }
  },

  update: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),
  updateProxy: (patch) =>
    set((s) => ({ form: { ...s.form, proxy: { ...s.form.proxy, ...patch } } })),
}));