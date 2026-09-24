import { useEffect, useState } from "react";
import { Lock, Settings as SettingsIcon } from "lucide-react";
import { useEmployer } from "./lib/store";
import { useTaskStreams } from "./lib/useTaskStream";
import TitleBar from "./components/TitleBar";
import Dashboard from "./components/Dashboard";
import AgentStudio from "./components/AgentStudio";
import TaskBoard from "./components/TaskBoard";
import AgentTerminal from "./components/AgentTerminal";
import TeamChat from "./components/TeamChat";
import SettingsPanel from "./components/SettingsPanel";
import { LOCK_EVENT } from "./components/LoginGate";

type View = "dashboard" | "studio" | "board" | "terminal" | "chat";

const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Control" },
  { id: "board", label: "Tasks" },
  { id: "studio", label: "Studio" },
  { id: "terminal", label: "Terminal" },
  { id: "chat", label: "Chat" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [showSettings, setShowSettings] = useState(false);
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

  /** Drop the session and re-show the LoginGate (see main.tsx). */
  const lockApp = () => window.dispatchEvent(new Event(LOCK_EVENT));

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
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
        <div className="ml-auto flex items-center gap-5 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider">agents</span>
            <span className="text-neon font-bold tabular-nums">{agents.length}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider">active</span>
            <span className="text-glow font-bold tabular-nums">
              {tasks.filter((t) => t.status === "running").length}
            </span>
          </span>
          <button
            className="text-text-muted hover:text-neon transition-colors"
            onClick={() => setShowSettings(true)}
            title="API & Proxy settings"
          >
            <SettingsIcon size={16} />
          </button>
          <button
            className="text-text-muted hover:text-neon transition-colors"
            onClick={lockApp}
            title="Lock the app"
          >
            <Lock size={16} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === "dashboard" && <Dashboard />}
        {view === "board" && <TaskBoard />}
        {view === "studio" && <AgentStudio />}
        {view === "terminal" && <AgentTerminal />}
        {view === "chat" && <TeamChat />}
      </main>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}