/** Typed client for the FastAPI orchestrator. */

export interface Agent {
  id: number;
  name: string;
  persona: string;
  permission_level: "readonly" | "standard" | "elevated";
  allowed_tools: string[];
  color: string;
  provider_id: string; // "default" = runtime settings connection
  model: string | null;
}

/** A saved API connection (Anthropic key, Ollama cloud, local Ollama, ...). */
export interface ProviderProfile {
  id: number;
  name: string;
  kind: "anthropic" | "openai_compatible" | "ollama" | "custom";
  base_url: string;
  default_model: string;
  added_models: string[];
  is_default: boolean;
  has_api_key: boolean;
  api_key_preview: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  agent_id: number | null;
  status: "pending" | "running" | "waiting_approval" | "done" | "failed";
  priority: number;
  parent_task_id: number | null;
  result: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string | null;
}

export interface Metrics {
  queue_depth: number;
  buckets: Record<string, { available: number; capacity: number }>;
}

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

export const api = {
  listAgents: () => req<Agent[]>("/agents"),
  createAgent: (body: Partial<Agent>) =>
    req<Agent>("/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (id: number, body: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  patchAgent: (id: number, body: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAgent: (id: number) => req<never>(`/agents/${id}`, { method: "DELETE" }),

  listTasks: () => req<Task[]>("/tasks"),
  createTask: (body: Partial<Task>) =>
    req<Task>("/tasks", { method: "POST", body: JSON.stringify(body) }),
  dispatchTask: (id: number) => req<{ status: string }>(`/tasks/${id}/dispatch`, { method: "POST" }),

  approve: (taskId: number, callId: string, verdict: "approve" | "deny") =>
    req<{ status: string }>(`/tasks/${taskId}/approve`, {
      method: "POST",
      body: JSON.stringify({ call_id: callId, verdict }),
    }),

  metrics: () => req<Metrics>("/metrics"),
  usage: () => req<{ input_tokens: number; output_tokens: number }>("/usage"),

  // Provider profiles (saved connections)
  listProviders: () => req<ProviderProfile[]>("/providers/profiles"),
  createProvider: (body: Partial<ProviderProfile> & { api_key?: string | null }) =>
    req<ProviderProfile>("/providers/profiles", { method: "POST", body: JSON.stringify(body) }),
  updateProvider: (id: number, body: Partial<ProviderProfile> & { api_key?: string | null }) =>
    req<ProviderProfile>(`/providers/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProvider: (id: number) =>
    req<{ status: string }>(`/providers/profiles/${id}`, { method: "DELETE" }),

  // Connection diagnostics (unsaved-changes testable)
  testProvider: (base_url: string, api_key?: string) =>
    req<{ ok: boolean; latency_ms: number | null; detail: string }>("/providers/test", {
      method: "POST",
      body: JSON.stringify({ base_url, api_key }),
    }),
  fetchProviderModels: (base_url: string, api_key?: string) =>
    req<{ models: string[]; url: string; detail: string }>("/providers/fetch-models", {
      method: "POST",
      body: JSON.stringify({ base_url, api_key }),
    }),

  // Claude Code agent-definition sync (.claude/agents/*.md)
  exportClaudeAgents: () =>
    req<{ target_dir: string; exported: string[]; skipped: string[] }>(
      "/agents/claude/export",
      { method: "POST", body: JSON.stringify({}) }
    ),
  importClaudeAgents: () =>
    req<{ target_dir: string; created: string[]; updated: string[]; skipped: string[] }>(
      "/agents/claude/import",
      { method: "POST", body: JSON.stringify({}) }
    ),
};