import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { unlockEnvelope, EncryptionUnlockError, type CryptoEnvelope } from "@/shared/cryptoEnvelope";

/**
 * §13.7 locked-page gate. Rendered when an encrypted page has not yet been
 * unlocked this browser session. The passphrase never leaves the client; a
 * successful unlock keeps the live DEK in memory and calls `onUnlock`.
 */
export function EncryptedPageLock({
  envelope,
  onUnlock,
}: {
  envelope: CryptoEnvelope;
  onUnlock: (plaintext: unknown, dek: CryptoKey) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { plaintext, dek } = await unlockEnvelope(envelope, passphrase);
      onUnlock(plaintext, dek);
    } catch (err) {
      if (err instanceof EncryptionUnlockError) {
        setError("Wrong passphrase.");
      } else {
        setError("Could not unlock this page.");
        toast.error("Could not unlock this page.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center">
        <Lock className="mx-auto h-8 w-8 text-text-muted" />
        <h2 className="mt-3 text-sm font-medium text-text">This page is protected</h2>
        <p className="mt-1 text-xs text-text-muted">
          Enter the unlock passphrase to decrypt it for this session.
        </p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Unlock passphrase"
          autoFocus
          className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="encrypted-page-passphrase"
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={!passphrase || busy}
          className="mt-4 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="encrypted-page-unlock"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
