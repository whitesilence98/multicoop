import { create } from "zustand";
import { api, ProviderProfile } from "../lib/api";

export type ProviderKind = ProviderProfile["kind"];

export const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible",
  ollama: "Ollama",
  custom: "Custom",
};

/** Presets for the "new connection" form — kind + base URL per source. */
export const KIND_PRESETS: Record<ProviderKind, { base_url: string; key_needed: boolean }> = {
  anthropic: { base_url: "https://api.anthropic.com", key_needed: true },
  openai_compatible: { base_url: "", key_needed: true },
  ollama: { base_url: "https://ollama.com", key_needed: false },
  custom: { base_url: "", key_needed: false },
};

export interface TestState {
  status: "idle" | "testing" | "ok" | "failed";
  detail: string;
  latency_ms: number | null;
}

export interface FetchState {
  status: "idle" | "fetching" | "ok" | "failed";
  detail: string;
}

/** Draft shape for the editor: empty api_key = keep stored key on save. */
export interface ProviderDraft {
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key: string;
  default_model: string;
  added_models: string[];
  is_default: boolean;
}

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  kind: "anthropic",
  base_url: "https://api.anthropic.com",
  api_key: "",
  default_model: "",
  added_models: [],
  is_default: false,
};

interface ProvidersState {
  profiles: ProviderProfile[];
  loading: boolean;
  error: string | null;
  // editor
  editingId: number | null; // null = new profile
  draft: ProviderDraft;
  test: TestState;
  fetch: FetchState;
  fetchedModels: string[];

  refresh: () => Promise<void>;
  startNew: (kind?: ProviderKind) => void;
  startEdit: (p: ProviderProfile) => void;
  updateDraft: (patch: Partial<ProviderDraft>) => void;
  cancelEdit: () => void;
  save: () => Promise<boolean>;
  remove: (id: number) => Promise<void>;
  testDraft: () => Promise<void>;
  fetchModels: () => Promise<void>;
  addModel: (m: string) => void;
  removeModel: (m: string) => void;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  profiles: [],
  loading: false,
  error: null,
  editingId: null,
  draft: { ...EMPTY_DRAFT },
  test: { status: "idle", detail: "", latency_ms: null },
  fetch: { status: "idle", detail: "" },
  fetchedModels: [],

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const profiles = await api.listProviders();
      set({ profiles, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  startNew: (kind) => {
    const k = kind ?? "anthropic";
    set({
      editingId: null,
      draft: { ...EMPTY_DRAFT, kind: k, base_url: KIND_PRESETS[k].base_url },
      test: { status: "idle", detail: "", latency_ms: null },
      fetch: { status: "idle", detail: "" },
      fetchedModels: [],
    });
  },

  startEdit: (p) => {
    set({
      editingId: p.id,
      draft: {
        name: p.name,
        kind: p.kind,
        base_url: p.base_url,
        api_key: "", // never echo the stored key; empty = keep on save
        default_model: p.default_model,
        added_models: [...p.added_models],
        is_default: p.is_default,
      },
      test: { status: "idle", detail: "", latency_ms: null },
      fetch: { status: "idle", detail: "" },
      fetchedModels: [],
    });
  },

  updateDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

  cancelEdit: () =>
    set({
      editingId: null,
      draft: { ...EMPTY_DRAFT },
      test: { status: "idle", detail: "", latency_ms: null },
      fetch: { status: "idle", detail: "" },
      fetchedModels: [],
    }),

  save: async () => {
    const { editingId, draft } = get();
    try {
      const body = {
        name: draft.name,
        kind: draft.kind,
        base_url: draft.base_url,
        default_model: draft.default_model,
        added_models: draft.added_models,
        is_default: draft.is_default,
        api_key: draft.api_key.trim() ? draft.api_key.trim() : null, // null = keep
      };
      if (editingId == null) {
        await api.createProvider(body);
      } else {
        await api.updateProvider(editingId, body);
      }
      await get().refresh();
      set({
        editingId: null,
        draft: { ...EMPTY_DRAFT },
        test: { status: "idle", detail: "", latency_ms: null },
      });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  remove: async (id) => {
    await api.deleteProvider(id);
    await get().refresh();
  },

  testDraft: async () => {
    const { draft } = get();
    set({ test: { status: "testing", detail: "", latency_ms: null } });
    try {
      const r = await api.testProvider(draft.base_url, draft.api_key || undefined);
      set({
        test: {
          status: r.ok ? "ok" : "failed",
          detail: r.detail,
          latency_ms: r.latency_ms,
        },
      });
    } catch (e) {
      set({ test: { status: "failed", detail: String(e), latency_ms: null } });
    }
  },

  fetchModels: async () => {
    const { draft } = get();
    set({ fetch: { status: "fetching", detail: "" }, fetchedModels: [] });
    try {
      const r = await api.fetchProviderModels(draft.base_url, draft.api_key || undefined);
      set({
        fetch: { status: r.models.length > 0 ? "ok" : "failed", detail: r.detail },
        fetchedModels: r.models,
      });
    } catch (e) {
      set({ fetch: { status: "failed", detail: String(e) } });
    }
  },

  addModel: (m) =>
    set((s) => {
      const name = m.trim();
      if (!name || s.draft.added_models.includes(name)) return s;
      return { draft: { ...s.draft, added_models: [...s.draft.added_models, name] } };
    }),

  removeModel: (m) =>
    set((s) => ({
      draft: { ...s.draft, added_models: s.draft.added_models.filter((x) => x !== m) },
    })),
}));