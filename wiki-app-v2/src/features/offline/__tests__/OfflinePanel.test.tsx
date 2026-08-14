import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OfflinePanel } from "../OfflinePanel.js";

// Brief §12.5 — offline pin list. SSR-only smoke check: the panel
// must show the empty-state copy when there's no data yet (the data
// only arrives after `useQuery` fires its first effect, which doesn't
// happen in a server render). The real loading/error/empty/success
// transitions get exercised by the slice-37 e2e suite against the live
// backend, since the panel renders inside a TanStack Router outlet.

describe("OfflinePanel (ssr smoke)", () => {
  it("renders the empty-state copy before data loads", () => {
    const html = renderToStaticMarkup(<OfflinePanel />);
    expect(html).toContain("Pinned for offline reading");
    // Loading copy is shown until the useQuery effect fires.
    expect(html).toMatch(/Loading|No pages pinned yet/);
  });
});