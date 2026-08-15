// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sanitizeMermaidSvg } from "../sanitizeSvg.js";

/**
 * §9.2 regression tests for the Mermaid SVG sanitization layer.
 *
 * Background: `mermaid.render()` returns an SVG string built from the
 * page author's text. That text is not trusted. The CVE pattern of
 * pumping that string into `dangerouslySetInnerHTML` without sanitizing
 * is the shape of GHSA-r4hj-mc62-jmwj (Docmost) and similar issues in
 * GitLab, Dify, and OneUptime. We sanitize before the DOM. These tests
 * are the receipt that the sanitization actually does what we say.
 *
 * DOMPurify can run in a pure-node environment (it uses an HTML parser
 * shim when no DOM is available), so we can unit-test the sanitizer
 * directly with adversarial SVG strings.
 */
describe("sanitizeMermaidSvg", () => {
  it("strips <script> tags injected via Mermaid text", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <rect width="100" height="100" />
    </svg>`;
    const cleaned = sanitizeMermaidSvg(malicious);
    expect(cleaned).not.toMatch(/<script/i);
    expect(cleaned).not.toMatch(/alert\s*\(/i);
  });

  it("strips event-handler attributes (onclick, onload, onerror, ...)", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" onclick="alert(1)" onload="alert(2)" onerror="alert(3)" />
    </svg>`;
    const cleaned = sanitizeMermaidSvg(malicious);
    expect(cleaned).not.toMatch(/onclick/i);
    expect(cleaned).not.toMatch(/onload/i);
    expect(cleaned).not.toMatch(/onerror/i);
    expect(cleaned).not.toMatch(/alert/i);
  });

  it("strips <foreignObject> (the HTML-in-SVG escape hatch)", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject width="100" height="100">
        <div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">x</div>
      </foreignObject>
    </svg>`;
    const cleaned = sanitizeMermaidSvg(malicious);
    expect(cleaned).not.toMatch(/foreignObject/i);
    expect(cleaned).not.toMatch(/alert/i);
  });

  it("strips <iframe>, <object>, <embed>", () => {
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <iframe src="javascript:alert(1)"></iframe>
      <object data="javascript:alert(1)"></object>
      <embed src="javascript:alert(1)" />
    </svg>`;
    const cleaned = sanitizeMermaidSvg(malicious);
    expect(cleaned).not.toMatch(/<iframe/i);
    expect(cleaned).not.toMatch(/<object/i);
    expect(cleaned).not.toMatch(/<embed/i);
    expect(cleaned).not.toMatch(/javascript:/i);
  });

  it("preserves the legitimate SVG geometry that Mermaid renders", () => {
    // Represents a plausible Mermaid flowchart output: namespaces, group,
    // shape, label, edge. No literal colors so the theming audit cannot
    // mistake the test fixtures for production code.
    const legitimate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="img">
      <g class="node default">
        <rect x="10" y="10" width="80" height="40" rx="4" />
        <text x="50" y="35" text-anchor="middle">A</text>
      </g>
      <g class="node default">
        <rect x="110" y="10" width="80" height="40" rx="4" />
        <text x="150" y="35" text-anchor="middle">B</text>
      </g>
      <path class="edge" d="M90 30 L110 30" />
    </svg>`;
    const cleaned = sanitizeMermaidSvg(legitimate);
    expect(cleaned).toMatch(/<svg/i);
    expect(cleaned).toMatch(/<rect/i);
    expect(cleaned).toMatch(/<text/i);
    expect(cleaned).toMatch(/<path/i);
    expect(cleaned).toMatch(/node default/);
  });

  it("returns a string (not the DOMPurify TrustedTypes-only default)", () => {
    // If we ever switch the JSDOM environment or strip the `as string`
    // cast, we want this to fail loudly rather than silently pass through
    // an object that React cannot dangerouslySetInnerHTML.
    const out = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" /></svg>`);
    expect(typeof out).toBe("string");
  });
});
