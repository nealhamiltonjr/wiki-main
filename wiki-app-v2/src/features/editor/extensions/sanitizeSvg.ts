import DOMPurify from "dompurify";

/**
 * Sanitize Mermaid's rendered SVG before it touches the DOM (§13.6 / §9.2).
 *
 * Why this exists: `mermaid.render()` returns an SVG string that is built
 * from the page author's text. That text is not trusted. The exact
 * `mermaid.render()` → `dangerouslySetInnerHTML` pattern (no sanitization
 * pass on the result) is the shape of GHSA-r4hj-mc62-jmwj in Docmost and
 * similar disclosed issues in GitLab, Dify, and OneUptime. Mermaid's own
 * internal `strict` mode is a defense-in-depth measure, not a guarantee;
 * the next bypass is the one that lands here.
 *
 * The fix is the same one every one of those CVEs ended up with: a
 * DOMPurify pass on the rendered SVG, configured for SVG, BEFORE it
 * touches the DOM. We don't trust Mermaid's protection alone.
 *
 * Pinned DOMPurify configuration:
 *  - USE_PROFILES.svg opens the SVG profile (the right one for SVG content);
 *    HTML profile is not what we want.
 *  - FORBID_TAGS / FORBID_ATTR are belt-and-suspenders for the surface that
 *    historically carried the XSS: `<script>`, `<foreignObject>`, and event
 *    handler attributes (`onclick`, `onload`, ...). Even with the SVG profile,
 *    some Mermaid versions have shipped vectors that include these; rendering
 *    them would still execute on the page.
 *
 * If we ever need to whitelist legitimate Mermaid features (e.g. hyperlinks
 * from `click` events on nodes), this is the place to add them — *not* by
 * removing the sanitize call.
 */
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed"],
    FORBID_ATTR: [
      "onload",
      "onclick",
      "onerror",
      "onmouseover",
      "onmouseout",
      "onfocus",
      "onblur",
      "onanimationstart",
      "onanimationend",
    ],
  }) as string;
}
