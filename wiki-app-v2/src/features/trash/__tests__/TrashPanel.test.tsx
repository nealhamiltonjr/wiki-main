import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrashPanel, relativeTime } from "../TrashPanel.js";

// The full trash lifecycle (delete → list → restore/purge) gets exercised by
// the slice-20 e2e suite against a live backend — keep this unit test focused
// on the two pieces of logic that don't require hitting the network:
//
//   1. `relativeTime`, the only non-trivial helper — exhaustive bucket
//      coverage so the empty/just-now/m/h/d/mo buckets don't drift.
//   2. A render smoke check to lock in that TrashPanel mounts at all (the
//      initial render is the loading state, since `useQuery` populates
//      data after the first effect — SSR can't fire that, by design).

const fixedNow = new Date("2026-08-01T12:00:00Z").getTime();

describe("relativeTime (pure helper)", () => {
  const iso = (offsetMs: number) => new Date(fixedNow + offsetMs).toISOString();

  it("returns 'just now' for under-a-minute deltas", () => {
    expect(relativeTime(iso(0), fixedNow)).toBe("just now");
    expect(relativeTime(iso(-30 * 1000), fixedNow)).toBe("just now");
    expect(relativeTime(iso(-59 * 1000), fixedNow)).toBe("just now");
  });

  it("returns minutes for sub-hour deltas", () => {
    expect(relativeTime(iso(-60 * 1000), fixedNow)).toBe("1m ago");
    expect(relativeTime(iso(-30 * 60 * 1000), fixedNow)).toBe("30m ago");
    expect(relativeTime(iso(-59 * 60 * 1000), fixedNow)).toBe("59m ago");
  });

  it("returns hours for sub-day deltas", () => {
    expect(relativeTime(iso(-60 * 60 * 1000), fixedNow)).toBe("1h ago");
    expect(relativeTime(iso(-23 * 60 * 60 * 1000), fixedNow)).toBe("23h ago");
  });

  it("returns days for sub-month deltas", () => {
    expect(relativeTime(iso(-24 * 60 * 60 * 1000), fixedNow)).toBe("1d ago");
    expect(relativeTime(iso(-29 * 24 * 60 * 60 * 1000), fixedNow)).toBe("29d ago");
  });

  it("returns months for anything older than ~30 days", () => {
    expect(relativeTime(iso(-30 * 24 * 60 * 60 * 1000), fixedNow)).toBe("1mo ago");
    expect(relativeTime(iso(-365 * 24 * 60 * 60 * 1000), fixedNow)).toBe("12mo ago");
  });

  it("returns an empty string for unparseable input rather than throwing", () => {
    expect(relativeTime("not-a-date", fixedNow)).toBe("");
  });
});

describe("TrashPanel mount", () => {
  it("renders the loading skeleton on first render (data loads after mount)", () => {
    // useQuery populates data inside a post-render effect; `renderToStaticMarkup`
    // intentionally doesn't fire effects, so the first paint is the loading
    // branch. This locks in the data-testid so e2e can target it.
    const html = renderToStaticMarkup(<TrashPanel spaceId="space-abc" />);
    expect(html).toContain('data-testid="trash-panel"');
    expect(html).toContain("Loading trash");
  });
});
