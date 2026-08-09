import { useState } from "react";
import { Star } from "lucide-react";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Star toggle in the page header (slice 9). Calls the favorites toggle and
 * reflects the result immediately; failures revert silently.
 */
export function FavoriteButton({ branchId, initiallyFavorited = false }: { branchId: string; initiallyFavorited?: boolean }) {
  const [favorited, setFavorited] = useState(initiallyFavorited);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.toggleFavorite(branchId);
      setFavorited(res.favorited);
    } catch {
      // keep last known state
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorited}
      data-testid="favorite-button"
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
        favorited ? "bg-amber-500/10 text-amber-500 hover:bg-amber-500/20" : "text-text-secondary hover:bg-surface-hover"
      )}
    >
      <Star className={cn("h-4 w-4", favorited && "fill-current")} />
    </button>
  );
}
