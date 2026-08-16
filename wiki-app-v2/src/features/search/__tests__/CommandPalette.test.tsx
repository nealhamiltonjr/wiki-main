import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette } from "../CommandPalette.js";

describe("CommandPalette", () => {
  it("renders nothing when closed (default state)", () => {
    const html = renderToStaticMarkup(<CommandPalette />);
    expect(html).toBe("");
  });
  it("is a named export that can be rendered without throwing", () => {
    expect(typeof CommandPalette).toBe("function");
    expect(() => renderToStaticMarkup(<CommandPalette />)).not.toThrow();
  });
});
