import { createContext, useContext, useEffect, useState } from "react";

export interface AuthUser {
  token: string;
  username: string;
  role: Role;
}

export type Role = "Project Director" | "Engineering Lead" | "Product Owner";

export const ROLES: Role[] = ["Project Director", "Engineering Lead", "Product Owner"];

export const ROLE_META: Record<Role, { badge: string; color: string }> = {
  "Project Director": { badge: "DIR", color: "#00FF9D" },
  "Engineering Lead": { badge: "LEAD", color: "#6366F1" },
  "Product Owner": { badge: "OWNER", color: "#F59E0B" },
};

interface AuthCtx {
  user: AuthUser | null;
  login: (username: string, role: Role) => Promise<void>;
  switchRole: (role: Role) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  login: async () => {},
  switchRole: async () => {},
  logout: () => {},
});

const STORAGE_KEY = "aiemployer.auth";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  });

  const persist = (u: AuthUser | null) => {
    try {
      if (u) localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private window / blocked storage — session lives in memory only */
    }
  };

  const login = async (username: string, role: Role) => {
    const res = await fetch("/api/chat/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, role }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { token } = (await res.json()) as { token: string };
    const u: AuthUser = { token, username, role };
    setUser(u);
    persist(u);
  };

  const switchRole = async (role: Role) => {
    if (!user) return;
    // Re-login with the same username under the new role (new token).
    await login(user.username, role);
  };

  const logout = () => {
    setUser(null);
    persist(null);
  };

  return <Ctx.Provider value={{ user, login, switchRole, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}