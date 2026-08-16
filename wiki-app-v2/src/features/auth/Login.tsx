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
    } catch (err) {
      setError((err as Error).message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-4 rounded-lg border p-6">
      <div>
        <h1 className="text-xl font-semibold">{mode === "signin" ? "Welcome back" : "Create account"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin" ? "Sign in to your wiki" : "Start your wiki in seconds"}
        </p>
      </div>
      <form className="space-y-4" onSubmit={submit}>
        {mode === "signup" && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="login-name">Name</label>
            <input
              id="login-name"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder="Ada Lovelace"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="login-email">Email</label>
          <input
            id="login-email"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="you@example.com"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="••••••••"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button
        className="w-full text-sm text-primary underline-offset-4 hover:underline"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")} aria-pressed={mode === "signup"}
      >
        {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
