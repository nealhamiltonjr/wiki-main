import { createFileRoute } from "@tanstack/react-router";
import { OfflinePanel } from "@/features/offline/OfflinePanel";

// Brief §12.5 — Per-user pinned pages. There is no spaceId in the URL
// because the pin list is owned by the user, not by a space — the same
// list is reachable from any space.
export const Route = createFileRoute("/_authenticated/pinned")({
  component: PinnedPage,
});

function PinnedPage() {
  return <OfflinePanel />;
}