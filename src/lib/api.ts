/** Typed client for the FastAPI orchestrator. */

export interface Agent {
  id: number;
  name: string;
  persona: string;
  permission_level: "readonly" | "standard" | "elevated";
  allowed_tools: string[];
  color: string;
  provider_id: string;
  model: string | null;
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
};