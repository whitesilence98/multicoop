import { create } from "zustand";
import { api, Agent, Metrics, Task } from "./api";

export type TerminalEvent = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  ts: string;
};

interface EmployerState {
  agents: Agent[];
  tasks: Task[];
  metrics: Metrics | null;
  usage: { input_tokens: number; output_tokens: number };
  // Per-task terminal event streams (keyed by task id)
  streams: Record<number, TerminalEvent[]>;
  approvals: Record<number, { call_id: string; tool: string; args: Record<string, unknown> } | null>;
  refreshAgents: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshMetrics: () => Promise<void>;
  pushEvent: (taskId: number, ev: TerminalEvent) => void;
  setApproval: (taskId: number, d: { call_id: string; tool: string; args: Record<string, unknown> } | null) => void;
  submitApproval: (taskId: number, verdict: "approve" | "deny") => Promise<void>;
}

export const useEmployer = create<EmployerState>((set, get) => ({
  agents: [],
  tasks: [],
  metrics: null,
  usage: { input_tokens: 0, output_tokens: 0 },
  streams: {},
  approvals: {},

  refreshAgents: async () => set({ agents: await api.listAgents() }),
  refreshTasks: async () => set({ tasks: await api.listTasks() }),
  refreshMetrics: async () => {
    const [metrics, usage] = await Promise.all([api.metrics(), api.usage()]);
    set({ metrics, usage });
  },

  pushEvent: (taskId, ev) =>
    set((s) => ({
      streams: {
        ...s.streams,
        [taskId]: [...(s.streams[taskId] ?? []), ev].slice(-2000),
      },
    })),

  setApproval: (taskId, d) =>
    set((s) => ({ approvals: { ...s.approvals, [taskId]: d } as EmployerState["approvals"] })),

  submitApproval: async (taskId, verdict) => {
    const d = get().approvals[taskId];
    if (!d) return;
    await api.approve(taskId, d.call_id, verdict);
    get().setApproval(taskId, null);
    await get().refreshTasks();
  },
}));