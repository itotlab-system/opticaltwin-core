import { FormEvent, useEffect, useState } from "react";
import App from "./App";

type AuthStatus = {
  required: boolean;
  authenticated: boolean;
};

const TAB_AUTH_KEY = "ot.authenticatedInTab";

export default function AuthGate() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const authenticatedInThisTab = sessionStorage.getItem(TAB_AUTH_KEY) === "true";

    async function loadStatus() {
      if (!authenticatedInThisTab) {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      }

      const response = await fetch("/api/auth/status");
      if (!response.ok) throw new Error("Authentication status unavailable");
      const nextStatus = await response.json() as AuthStatus;
      setStatus({
        ...nextStatus,
        authenticated: authenticatedInThisTab && nextStatus.authenticated,
      });
    }

    loadStatus().catch(() => setError("サーバーに接続できません。"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "ログインできませんでした。");
        return;
      }
      sessionStorage.setItem(TAB_AUTH_KEY, "true");
      setStatus({ required: true, authenticated: true });
    } catch {
      setError("サーバーに接続できません。");
    } finally {
      setSubmitting(false);
    }
  }

  if (status?.authenticated) return <App />;

  return (
    <main className="login-page">
      <div className="login-logo">
        <img src="/login.png" alt="OpticalTwin" />
      </div>
      {status ? (
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" disabled={submitting}>
            {submitting ? "Logging in..." : "Login"}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <p className="login-status">{error || "Loading..."}</p>
      )}
    </main>
  );
}
