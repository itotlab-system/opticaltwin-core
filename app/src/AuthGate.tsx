import { FormEvent, useEffect, useState } from "react";
import App from "./App";
import { useSettings } from "./settings";
import { phrases } from "./i18n";

type AuthStatus = {
  required: boolean;
  authenticated: boolean;
};

const TAB_AUTH_KEY = "ot.authenticatedInTab";

// The server answers with a machine-readable `code` so the message can be
// shown in the member's own language; the raw `error` string is the fallback
// for a backend older than that change.
const ERROR_KEYS: Record<string, string> = {
  invalid_password: "login_invalid_password",
};

export default function AuthGate() {
  const { t } = useSettings();
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

    // `t` is rebuilt on every provider render, so it must stay out of the deps
    // — hence `error` holds a *key*, translated at render time instead.
    loadStatus().catch(() => setError("login_unreachable"));
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
        setError(ERROR_KEYS[result.code] ?? result.error ?? "login_failed");
        return;
      }
      sessionStorage.setItem(TAB_AUTH_KEY, "true");
      setStatus({ required: true, authenticated: true });
    } catch {
      setError("login_unreachable");
    } finally {
      setSubmitting(false);
    }
  }

  if (status?.authenticated) return <App />;

  return (
    <main className="login-page">
      <div className="login-hero">
        {/* Two wordmarks, one shown per theme — the light one is black text
            that would vanish on the dark background, and vice versa. */}
        <img className="login-logo-light" src="/logo.png" alt="OpticalTwin" />
        <img className="login-logo-dark" src="/logo-dark.png" alt="OpticalTwin" />
        <p className="login-tagline">
          {phrases(t("login_tagline")).map((phrase, i) => (
            <span key={i}>{phrase}</span>
          ))}
        </p>
      </div>
      {status ? (
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="login-password">{t("login_password")}</label>
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
            {submitting ? t("login_submitting") : t("login_submit")}
          </button>
          {error && <p className="login-error" role="alert">{t(error)}</p>}
        </form>
      ) : (
        <p className="login-status">{error ? t(error) : t("login_loading")}</p>
      )}
    </main>
  );
}
