import { useState } from "react";
import { signIn, signUp } from "../../api/authClient.js";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "signin"
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name });
      if (result.error) setError(result.error.message ?? "Something went wrong");
      else onAuthed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="logo">W</span>
          <h1>{mode === "signin" ? "Welcome back" : "Create account"}</h1>
        </div>
        <div className="login-sub">
          {mode === "signin" ? "Sign in to your wiki" : "Start your wiki in seconds"}
        </div>
        <form onSubmit={submit}>
          {mode === "signup" && (
            <div className="field">
              <label htmlFor="login-name">Name</label>
              <input id="login-name" placeholder="Ada Lovelace" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input id="login-email" placeholder="you@example.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              placeholder="••••••••"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={busy} className="submit-btn">
            {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          className="switch-mode"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
