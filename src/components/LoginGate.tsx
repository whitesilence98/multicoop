import { ReactNode, useCallback, useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { api } from "../lib/api";
import { clearToken, getToken, setToken } from "../lib/auth";

type Phase = "checking" | "setup" | "locked" | "open";

/** Fired by the app's lock button to drop the session and re-show this gate. */
export const LOCK_EVENT = "aiemployer:lock";

/** Full-screen password gate. Nothing behind it renders until authed.
 * First use (no password configured) offers a setup form instead. */
export default function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const openFor = useCallback((token: string) => {
    setToken(token);
    setPhase("open");
  }, []);

  const lock = useCallback(() => {
    const token = getToken();
    if (token) void api.authLogout(token).catch(() => {}); // best-effort
    clearToken();
    setPassword("");
    setConfirm("");
    setError("");
    setPhase("locked"); // already configured if we were open
  }, []);

  useEffect(() => {
    window.addEventListener(LOCK_EVENT, lock);
    return () => window.removeEventListener(LOCK_EVENT, lock);
  }, [lock]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = getToken();
      if (existing) {
        try {
          const { valid } = await api.authValidate(existing);
          if (cancelled) return;
          if (valid) {
            setPhase("open");
            return;
          }
          clearToken();
        } catch {
          // Backend unreachable / restarting: fall through to a fresh check.
        }
      }
      try {
        const { configured } = await api.authStatus();
        if (!cancelled) setPhase(configured ? "locked" : "setup");
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setPhase("locked"); // status unknown — treat as locked
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSetup = async () => {
    setError("");
    if (password.length < 4) {
      setError("password must be at least 4 characters");
      return;
    }
    if (password !== confirm) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api.authSetup(password);
      const { token } = await api.authLogin(password);
      openFor(token);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setError("");
    setBusy(true);
    try {
      const { token } = await api.authLogin(password);
      openFor(token);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "open") return <>{children}</>;

  const isSetup = phase === "setup";

  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="panel w-full max-w-sm border-glow/40 p-6">
        <div className="flex items-center gap-3 mb-2">
          <Lock size={16} className="text-neon" />
          <div className="section-title">
            {isSetup ? "Set Password" : "Locked"}
          </div>
        </div>
        <p className="text-xs text-text-muted mb-5">
          {isSetup
            ? "First use — set a password to protect this workspace."
            : "Enter the password to unlock AI Employer."}
        </p>

        {phase === "checking" ? (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            checking…
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs font-mono text-danger">
                {error}
              </div>
            )}
            <div>
              <div className="text-xs text-[#64748B] font-bold uppercase tracking-wider">
                Password
              </div>
              <input
                className="field w-full mt-1"
                type="password"
                autoFocus
                value={password}
                placeholder="min. 4 characters"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void (isSetup ? handleSetup() : handleLogin());
                }}
              />
            </div>
            {isSetup && (
              <div>
                <div className="text-xs text-[#64748B] font-bold uppercase tracking-wider">
                  Confirm
                </div>
                <input
                  className="field w-full mt-1"
                  type="password"
                  value={confirm}
                  placeholder="repeat password"
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy) void handleSetup();
                  }}
                />
              </div>
            )}
            <button
              className="btn-primary w-full"
              disabled={busy || password.length < 4}
              onClick={() => void (isSetup ? handleSetup() : handleLogin())}
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin inline" />
              ) : (
                isSetup ? "Set & Unlock" : "Unlock"
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}