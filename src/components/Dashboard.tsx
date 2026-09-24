import { useEffect } from "react";
import { useEmployer } from "../lib/store";

const STATUS_COLORS: Record<string, string> = {
  pending: "text-text-muted border-edge-bright",
  running: "text-glow border-glow",
  waiting_approval: "text-warn border-warn",
  done: "text-neon border-neon-dim",
  failed: "text-danger border-danger",
};

function Metric({
  title,
  value,
  accent = "text-neon",
}: {
  title: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="panel">
      <div className="section-title">{title}</div>
      <div className={`mt-2 text-2xl leading-tight font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function Dashboard() {
  const agents = useEmployer((s) => s.agents);
  const tasks = useEmployer((s) => s.tasks);
  const metrics = useEmployer((s) => s.metrics);
  const usage = useEmployer((s) => s.usage);
  const approvals = useEmployer((s) => s.approvals);
  const submitApproval = useEmployer((s) => s.submitApproval);

  const running = tasks.filter((t) => t.status === "running");
  const backlog = tasks.filter((t) => t.status === "pending");
  const approvalList = Object.entries(approvals).filter(([, v]) => v);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Metric title="Workforce" value={String(agents.length)} />
        <Metric title="Running" value={String(running.length)} accent="text-glow" />
        <Metric title="Queue Backlog" value={String(metrics?.queue_depth ?? backlog.length)} accent="text-warn" />
        <Metric
          title="Tokens Used"
          value={`${((usage.input_tokens + usage.output_tokens) / 1000).toFixed(1)}K`}
          accent="text-text-primary"
        />
      </div>

      {/* Rate-limit buckets */}
      {metrics && (
        <div className="panel">
          <div className="section-title">Rate Limit Budget</div>
          <div className="mt-3 grid grid-cols-3 gap-4 pt-0.5">
            {Object.entries(metrics.buckets).map(([name, b]) => {
              const pct = b.capacity > 0 ? (b.available / b.capacity) * 100 : 0;
              return (
                <div key={name}>
                  <div className="flex justify-between text-xs uppercase tracking-wider text-text-muted">
                    <span>{name}</span>
                    <span className="text-text-primary">{Math.round(pct)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-inset border border-edge overflow-hidden">
                    <div
                      className="h-full bg-neon-dim"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active agents */}
      <div className="panel">
        <div className="section-title">Workforce</div>
        {agents.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            No agents hired yet — head to Studio to define your workforce.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {agents.map((a) => {
              // Active = has an assigned model (own pin or provider default);
              // glowing border only when actually executing a task.
              const isActiveAgent = Boolean(a.model);
              const active = running.some((t) => t.agent_id === a.id);
              return (
                <div
                  key={a.id}
                  className={`rounded-lg border bg-inset p-3 ${
                    active ? "border-glow shadow-glow-sm" : "border-edge"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: isActiveAgent ? a.color : "#2A2F45",
                        boxShadow: isActiveAgent ? `0 0 6px ${a.color}` : "none",
                      }}
                    />
                    <span className="font-bold text-sm text-text-primary">{a.name}</span>
                    <span className="chip ml-auto text-text-muted border-edge-bright">
                      {a.permission_level}
                    </span>
                  </div>
                  <div className="mt-2 text-xs uppercase tracking-wider text-text-muted">
                    {active ? (
                      <span className="text-glow">● executing</span>
                    ) : isActiveAgent ? (
                      <span className="text-neon">○ active</span>
                    ) : (
                      <span className="text-warn">○ inactive — no model</span>
                    )}
                    <span className="ml-3">{a.model || "no model"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Approvals + recent tasks */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel">
          <div className="section-title">Pending Approvals</div>
          {approvalList.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">Nothing awaiting your sign-off.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {approvalList.filter(([, d]) => d).map(([taskId, d]) => (
                <div key={taskId} className="rounded-lg border border-warn/40 bg-inset p-3">
                  <div className="text-xs uppercase tracking-wider text-warn font-bold">
                    task #{taskId} — {d!.tool}
                  </div>
                  <pre className="mt-1 text-xs text-text-muted overflow-x-auto">
                    {JSON.stringify(d!.args, null, 2)}
                  </pre>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="btn-primary"
                      onClick={() => submitApproval(Number(taskId), "approve")}
                    >
                      Approve
                    </button>
                    <button className="btn-ghost" onClick={() => submitApproval(Number(taskId), "deny")}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="section-title">Recent Tasks</div>
          <div className="mt-3 space-y-1.5">
            {tasks.slice(0, 8).map((t) => (
              <div key={t.id} className="flex items-center gap-3 text-sm">
                <span className="text-text-muted">#{t.id}</span>
                <span className="text-text-primary truncate">{t.title}</span>
                <span className={`chip ml-auto ${STATUS_COLORS[t.status]}`}>
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}