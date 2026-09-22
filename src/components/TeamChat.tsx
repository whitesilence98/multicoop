import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useAuth, ROLE_META, ROLES, AuthUser } from "../context/AuthContext";
import { useChatStore, ChatMessage, ChatMember } from "../store/useChatStore";
import { useEmployer } from "../lib/store";

const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Renders message text with highlighted @mentions. */
function MentionText({ text, mentionNames }: { text: string; mentionNames: Set<string> }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const idx = m.index ?? 0;
    parts.push(text.slice(last, idx));
    const name = m[1];
    const hit = mentionNames.has(name);
    parts.push(
      <span
        key={idx}
        className={hit ? "text-glow font-bold" : "text-text-muted"}
      >
        @{name}
      </span>
    );
    last = idx + m[0].length;
  }
  parts.push(text.slice(last));
  return <span className="whitespace-pre-wrap">{parts}</span>;
}

function RoleBadge({ badge, color }: { badge: string; color: string }) {
  return (
    <span
      className="chip shrink-0"
      style={{ color, borderColor: `${color}55`, textShadow: `0 0 6px ${color}66` }}
    >
      [{badge}]
    </span>
  );
}

export default function TeamChat() {
  const { user, login, switchRole, logout } = useAuth();
  const agents = useEmployer((s) => s.agents);
  const {
    messages, members, wsStatus, pushMessage, setMembers, upsertMember,
    removeMember, setWsStatus, unreadMentions, clearUnread,
  } = useChatStore();

  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginRole, setLoginRole] = useState<(typeof ROLES)[number]>("Project Director");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Roster for the sidebar: online humans + all AI agents (always available).
  const roster: ChatMember[] = useMemo(() => {
    const bots: ChatMember[] = agents.map((a) => ({
      id: `agent_${a.id}`,
      username: a.name,
      role: "AI Agent",
      badge: "BOT",
      color: a.color,
      kind: "bot" as const,
      status: "online",
    }));
    const humans = members.filter((m) => m.kind === "human");
    return [...humans, ...bots];
  }, [agents, members]);

  const mentionNames = useMemo(
    () => new Set(roster.map((r) => r.username)),
    [roster]
  );

  // ---- WebSocket lifecycle ---------------------------------------------------
  useEffect(() => {
    if (!user) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/chat/ws?token=${user.token}`);
      wsRef.current = ws;

      ws.onopen = () => setWsStatus("open");
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as Record<string, unknown>;
        if (ev.type === "presence_snapshot") {
          setMembers((ev.members as ChatMember[]) ?? []);
        } else if (ev.type === "presence") {
          const member = ev.member as ChatMember;
          if (ev.action === "join") upsertMember(member);
          else removeMember(member.id);
        } else if (ev.type === "message") {
          const msg = ev as unknown as ChatMessage;
          pushMessage(msg);
          const mentionsMe =
            user &&
            (msg.mentions ?? []).some(
              (n) => n.toLowerCase() === user.username.toLowerCase()
            );
          if (mentionsMe && msg.sender.id !== `me_${user.username}`) {
            useChatStore.setState((s) => ({ unreadMentions: s.unreadMentions + 1 }));
            // Desktop notification for direct human mentions (Electron bridge).
            window.aiemployer?.notify(
              `${msg.sender.username} mentioned you`,
              msg.text.slice(0, 120)
            );
          }
        }
      };
      ws.onclose = () => {
        setWsStatus("closed");
        if (!disposed) {
          retryTimer = setTimeout(connect, 2000); // auto-reconnect
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [user, pushMessage, setMembers, upsertMember, removeMember, setWsStatus]);

  // Autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  // ---- mention autocomplete ---------------------------------------------------
  const mentionCandidates = mentionQuery
    ? roster.filter((r) =>
        r.username.toLowerCase().startsWith(mentionQuery.toLowerCase())
      )
    : [];

  const onDraftChange = (v: string) => {
    setDraft(v);
    // Detect an active @query at the caret (end of input for simplicity).
    const m = v.match(/@([A-Za-z0-9_-]*)$/);
    setMentionQuery(m ? m[1] : null);
  };

  const applyMention = (name: string) => {
    setDraft((d) => d.replace(/@([A-Za-z0-9_-]*)$/, `@${name} `));
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ text }));
    setDraft("");
    setMentionQuery(null);
  };

  const doLogin = async () => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      await login(loginName.trim(), loginRole);
    } catch (e) {
      setLoginError(String(e));
    } finally {
      setLoginBusy(false);
    }
  };

  // ---- login screen -------------------------------------------------------------
  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="panel w-full max-w-sm">
          <div className="section-title mb-4">Sign in to Team Chat</div>
          <input
            className="field w-full mb-3"
            placeholder="YOUR NAME"
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doLogin()}
          />
          <div className="grid grid-cols-3 gap-2 mb-3">
            {ROLES.map((r) => (
              <button
                key={r}
                className={`btn-ghost flex-1 text-[10px] ${
                  loginRole === r ? "border-glow text-white" : ""
                }`}
                onClick={() => setLoginRole(r)}
              >
                {ROLE_META[r].badge}
              </button>
            ))}
          </div>
          {loginError && <p className="text-xs text-red-400 mb-2">{loginError}</p>}
          <button className="btn-primary w-full" onClick={doLogin} disabled={loginBusy || !loginName.trim()}>
            {loginBusy ? "Signing in…" : "Enter Chat"}
          </button>
        </div>
      </div>
    );
  }

  // ---- chat view ----------------------------------------------------------------
  return (
    <div className="h-full flex">
      {/* Sidebar: roster */}
      <aside className="w-56 shrink-0 border-r border-edge bg-panel/60 p-3 overflow-y-auto">
        <div className="section-title mb-3">Team ({roster.length})</div>
        <div className="space-y-2">
          {roster.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: m.color, boxShadow: `0 0 6px ${m.color}` }}
              />
              <span className="text-xs text-text-primary truncate">{m.username}</span>
              <RoleBadge badge={m.badge} color={m.color} />
            </div>
          ))}
        </div>

        <div className="mt-6 pt-3 border-t border-edge">
          <div className="section-title mb-2">Your Role</div>
          <select
            className="field w-full text-xs"
            value={user.role}
            onChange={(e) => switchRole(e.target.value as AuthUser["role"])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button
            className="mt-2 text-[10px] uppercase tracking-wider text-text-muted hover:text-red-400"
            onClick={logout}
          >
            sign out
          </button>
        </div>
      </aside>

      {/* Thread + input */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between border-b border-edge bg-panel/60 px-4 py-2">
          <span className="section-title">Team Chat</span>
          <div className="flex items-center gap-3 text-xs">
            <span
              className={`chip ${
                wsStatus === "open" ? "text-neon border-neon-dim" : "text-yellow-400 border-yellow-400/40"
              }`}
            >
              {wsStatus}
            </span>
            {unreadMentions > 0 && (
              <span className="chip text-glow border-glow">
                {unreadMentions} mentions
              </span>
            )}
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto p-4 space-y-3 bg-inset/50"
          onClick={clearUnread}
        >
          {messages.length === 0 && (
            <p className="text-xs text-text-muted">
              No messages yet. Tag an agent with @ to get a live answer — e.g.{" "}
              <span className="text-glow">@Software-Developer</span> (use the roster names).
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="flex items-start gap-2">
              <span className="text-[10px] text-text-muted mt-1 shrink-0 w-14 text-right">
                {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <RoleBadge badge={m.sender.badge} color={m.sender.color} />
              <div className="min-w-0">
                <span className="text-xs font-bold" style={{ color: m.sender.color }}>
                  {m.sender.username}
                </span>
                <div className="text-sm text-text-primary break-words">
                  <MentionText text={m.text} mentionNames={mentionNames} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Composer + autocomplete */}
        <div className="relative border-t border-edge bg-panel/80 p-3">
          {mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-4 right-4 mb-1 panel p-1 max-h-40 overflow-y-auto">
              {mentionCandidates.map((c) => (
                <button
                  key={c.id}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-inset text-left"
                  onClick={() => applyMention(c.username)}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
                  <span className="text-text-primary">{c.username}</span>
                  <RoleBadge badge={c.badge} color={c.color} />
                  <span className="ml-auto text-text-muted">{c.kind}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="field flex-1"
              placeholder={`Message as ${user.username} — @ to mention…`}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (mentionCandidates.length > 0) {
                    applyMention(mentionCandidates[0].username);
                  } else {
                    send();
                  }
                }
              }}
            />
            <button
              className="btn-primary"
              onClick={send}
              disabled={!draft.trim() || wsStatus !== "open"}
              title="Send"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}