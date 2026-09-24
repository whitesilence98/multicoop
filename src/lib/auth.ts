/** Wiring helpers for the LoginGate frontend — single source of truth for
 * the token storage key so api/auth/gate all agree. */
export const TOKEN_KEY = "aiemployer_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — session lost on reload, acceptable */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}