import { useEffect, useState } from "react";
import { useEmployer } from "./lib/store";
import { useTaskStreams } from "./lib/useTaskStream";
import Dashboard from "./components/Dashboard";
import AgentStudio from "./components/AgentStudio";
import TaskBoard from "./components/TaskBoard";
import AgentTerminal from "./components/AgentTerminal";

type View = "dashboard" | "studio" | "board" | "terminal";

const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Control" },
  { id: "board", label: "Tasks" },
  { id: "studio", label: "Studio" },
  { id: "terminal", label: "Terminal" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const agents = useEmployer((s) => s.agents);
  const tasks = useEmployer((s) => s.tasks);
  const refreshAgents = useEmployer((s) => s.refreshAgents);
  const refreshTasks = useEmployer((s) => s.refreshTasks);
  const refreshMetrics = useEmployer((s) => s.refreshMetrics);

  useEffect(() => {
    refreshAgents();
    refreshTasks();
    refreshMetrics();
    const t = setInterval(refreshMetrics, 3000);
    const t2 = setInterval(refreshTasks, 5000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [refreshAgents, refreshTasks, refreshMetrics]);

  // Live SSE for everything in flight
  useTaskStreams(tasks.filter((t) => t.status === "running" || t.status === "pending").map((t) => t.id));

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-6 border-b border-edge bg-panel/80 px-6 py-3">
        <h1 className="font-mono uppercase tracking-wider text-sm font-bold text-neon">
          AI&nbsp;Employer
        </h1>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors ${
                view === n.id
                  ? "bg-glow-dim text-white border border-glow"
                  : "text-text-muted hover:text-text-primary border border-transparent"
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-xs text-text-muted">
          <span className="uppercase tracking-wider">agents</span>
          <span className="text-neon font-bold">{agents.length}</span>
          <span className="uppercase tracking-wider">active</span>
          <span className="text-glow font-bold">
            {tasks.filter((t) => t.status === "running").length}
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === "dashboard" && <Dashboard />}
        {view === "board" && <TaskBoard />}
        {view === "studio" && <AgentStudio />}
        {view === "terminal" && <AgentTerminal />}
      </main>
    </div>
  );
}