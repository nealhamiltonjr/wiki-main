import { createFileRoute } from "@tanstack/react-router";
import { TrashPanel } from "@/features/trash/TrashPanel";

// Brief §12.1 — Per-space Trash view. The spaceId is in the URL so the
// route works independently of whatever space the sidebar tree is
// currently showing; this matches the /api/spaces/:spaceId/trash API
// surface and keeps the trash view deep-linkable.
export const Route = createFileRoute("/_authenticated/trash/$spaceId")({
  component: TrashPage,
});

function TrashPage() {
  const { spaceId } = Route.useParams();
  return <TrashPanel spaceId={spaceId} />;
}
