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
    <div style={{ maxWidth: 320, margin: "80px auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20 }}>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {mode === "signup" && (
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error && <div style={{ color: "crimson", fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "..." : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button
        style={{ marginTop: 12, background: "none", border: "none", color: "#555", cursor: "pointer" }}
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
