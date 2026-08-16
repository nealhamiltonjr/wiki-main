import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";

/**
 * §13.7 passphrase collection for turning on per-page encryption. The dialog
 * only collects the secret; encryption happens in the caller so the dialog
 * itself never touches page content or crypto.
 */
export function ProtectPageDialog({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: (passphrase: string) => void;
  busy: boolean;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (passphrase.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      setError("Passphrases do not match.");
      return;
    }
    onConfirm(passphrase);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Protect page" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-text-muted" />
          <h2 className="text-sm font-medium text-text">Protect this page</h2>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          The body will be encrypted at rest. You will need this passphrase to
          unlock it again — it cannot be recovered.
        </p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase (8+ characters)"
          autoFocus
          className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="protect-passphrase"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm passphrase"
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="protect-passphrase-confirm"
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !passphrase || !confirm}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="protect-confirm"
          >
            {busy ? "Encrypting…" : "Protect page"}
          </button>
        </div>
      </form>
    </div>
  );
}
