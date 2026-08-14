import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PinButton } from "../PinButton.js";

// Brief §12.5 — server-renderable smoke check. The optimistic toggle
// path, SW postMessage, and rollback-on-error are exercised by the
// slice-37 e2e suite; here we just lock down that the button mounts
// with the right initial visual state (filled vs outline pin).

describe("PinButton (ssr smoke)", () => {
  it("renders unpinned by default", () => {
    const html = renderToStaticMarkup(<PinButton branchId="b1" />);
    expect(html).toContain("data-testid=\"pin-button\"");
    expect(html).toContain("aria-pressed=\"false\"");
    expect(html).toContain("Pin for offline reading");
  });

  it("renders pinned when initiallyPinned is true", () => {
    const html = renderToStaticMarkup(<PinButton branchId="b1" initiallyPinned />);
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("Remove from offline reading");
  });
});