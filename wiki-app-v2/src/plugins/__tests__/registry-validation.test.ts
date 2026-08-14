import { describe, it, expect, beforeEach } from "vitest";
import { registerCoreCommands } from "@/plugins/coreCommands";
import {
  registerSlashCommand,
  registerToolbarItem,
  registerSettingsPanel,
  registerEmbedType,
  getSlashCommands,
  getToolbarItems,
  getSettingsPanels,
  getEmbedTypes,
  resetRegistryForTests,
} from "@/plugins/registry";
import type { SlashCommandDef, ToolbarItemDef, SettingsPanelDef, EmbedTypeDef } from "@/plugins/defs";
import { KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES } from "@/shared/blockIds";

/**
 * Slice-46 — plugin command engine injection audit.
 *
 * Findings: every `register*()` previously accepted any input without
 * validation. Three real injection vectors were open:
 *
 *   1. EmbedType.name collision with a core block/inline type. Every
 *      block type that falls through to the `default:` branch in
 *      BlockNode (table, tableRow, tableCell, taskList, taskItem,
 *      details*, image) is a takeover candidate — a plugin whose
 *      renderer fires for "image" replaces every image in the wiki.
 *
 *   2. Duplicate registration. Two plugins registering the same
 *      EmbedType.name silently overwrite each other via Map.set
 *      semantics; the last-loaded plugin wins. Same problem for
 *      slash command names and toolbar / settings-panel ids.
 *
 *   3. Unbounded label/icon/name lengths — a plugin could push MBs
 *      through the registry. Memory is cheap, but the renderer
 *      surfaces matter: a malicious label of 1 MB would render as a
 *      1 MB text node.
 *
 * The fix lives in src/plugins/registry.ts; these tests pin it.
 */

function slashCommand(name: string): SlashCommandDef {
  return { name, label: name, run: () => {} };
}
function toolbarItem(id: string): ToolbarItemDef {
  return { id, label: id, onPress: () => {} };
}
function settingsPanel(id: string): SettingsPanelDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, label: id, render: () => null as any };
}
function embedType(name: string): EmbedTypeDef {
  return { name, label: name };
}

describe("plugin registry validation (slice-46)", () => {
  beforeEach(() => {
    resetRegistryForTests();
  });

  describe("registerEmbedType", () => {
    it("rejects a name that collides with a core block type", () => {
      for (const t of KNOWN_BLOCK_TYPES) {
        resetRegistryForTests();
        expect(() => registerEmbedType(embedType(t))).toThrow(/collides with core/);
      }
    });

    it("rejects a name that collides with a core inline type", () => {
      for (const t of KNOWN_INLINE_TYPES) {
        resetRegistryForTests();
        expect(() => registerEmbedType(embedType(t))).toThrow(/collides with core/);
      }
    });

    it("accepts a non-core name and exposes it via getEmbedTypes", () => {
      registerEmbedType(embedType("drawioDiagram"));
      registerEmbedType(embedType("calloutBox"));
      const ets = getEmbedTypes();
      expect(ets.map((e) => e.name)).toEqual(["drawioDiagram", "calloutBox"]);
    });

    it("rejects a duplicate registration (loud, not silent overwrite)", () => {
      registerEmbedType(embedType("drawioDiagram"));
      expect(() => registerEmbedType(embedType("drawioDiagram"))).toThrow(/already registered/);
    });

    it("rejects a malformed name", () => {
      expect(() => registerEmbedType(embedType("bad name"))).toThrow();
      expect(() => registerEmbedType(embedType("123-starts-with-digit"))).toThrow();
      expect(() => registerEmbedType(embedType(""))).toThrow();
      expect(() => registerEmbedType(embedType("a".repeat(65)))).toThrow();
    });

    it("rejects an oversized label", () => {
      expect(() => registerEmbedType({ name: "drawioDiagram", label: "x".repeat(81) })).toThrow(/label.*80/);
    });
  });

  describe("registerSlashCommand", () => {
    // Slice-46: every lowercase-single-word core type would collide with
    // the slash-command namespace if a plugin used it as a name. Filter
    // KNOWN_BLOCK_TYPES ∪ KNOWN_INLINE_TYPES down to names that pass the
    // slash-command shape (^[a-z][a-z0-9-]{0,31}$) so the collision check
    // is exercised, not the earlier shape check.
    const LOWERCASE_CORE = new Set(
      [...KNOWN_BLOCK_TYPES, ...KNOWN_INLINE_TYPES].filter((t) => /^[a-z][a-z0-9-]*$/.test(t)),
    );
    it("rejects a name that collides with a core block type", () => {
      expect(LOWERCASE_CORE.size).toBeGreaterThan(0);
      for (const t of LOWERCASE_CORE) {
        resetRegistryForTests();
        expect(() => registerSlashCommand(slashCommand(t))).toThrow(/collides with core/);
      }
    });

    it("rejects a duplicate registration", () => {
      registerSlashCommand(slashCommand("foo"));
      expect(() => registerSlashCommand(slashCommand("foo"))).toThrow(/already registered/);
    });

    it("rejects a malformed name", () => {
      expect(() => registerSlashCommand(slashCommand("Bad Name"))).toThrow();
      expect(() => registerSlashCommand(slashCommand(""))).toThrow();
      expect(() => registerSlashCommand(slashCommand("1foo"))).toThrow();
    });

    it("accepts the first-party 'mermaid' command (smoke test)", () => {
      // Mermaid is registered by registerCoreCommands; this guarantees the
      // validation does not regress the boot path.
      resetRegistryForTests();
      registerCoreCommands();
      const cmds = getSlashCommands();
      const mermaid = cmds.find((c) => c.name === "mermaid");
      expect(mermaid).toBeDefined();
    });

    it("caps keyword length and count", () => {
      const manyKeywords = Array.from({ length: 32 }, (_, i) => `kw${i}`);
      expect(() =>
        registerSlashCommand({
          name: "test",
          label: "Test",
          keywords: manyKeywords,
          run: () => {},
        }),
      ).toThrow();
      expect(() =>
        registerSlashCommand({
          name: "test",
          label: "Test",
          keywords: ["thiskeywordistoooolongtobeusefulforanyreasonwhatsoever"],
          run: () => {},
        }),
      ).toThrow();
    });
  });

  describe("registerToolbarItem", () => {
    it("rejects a duplicate id", () => {
      registerToolbarItem(toolbarItem("foo"));
      expect(() => registerToolbarItem(toolbarItem("foo"))).toThrow(/already registered/);
    });

    it("rejects a malformed id", () => {
      expect(() => registerToolbarItem(toolbarItem("Bad Id"))).toThrow();
      expect(() => registerToolbarItem(toolbarItem(""))).toThrow();
      expect(() => registerToolbarItem(toolbarItem("-starts-with-dash"))).toThrow();
    });

    it("caps label length", () => {
      expect(() =>
        registerToolbarItem({ id: "ok", label: "x".repeat(81), onPress: () => {} }),
      ).toThrow(/label.*80/);
    });

    it("accepts multiple distinct toolbar items", () => {
      registerToolbarItem(toolbarItem("mermaid"));
      registerToolbarItem(toolbarItem("callout"));
      expect(getToolbarItems().map((t) => t.id)).toEqual(["mermaid", "callout"]);
    });
  });

  describe("registerSettingsPanel", () => {
    it("rejects a duplicate id", () => {
      registerSettingsPanel(settingsPanel("foo"));
      expect(() => registerSettingsPanel(settingsPanel("foo"))).toThrow(/already registered/);
    });

    it("rejects a malformed id", () => {
      expect(() => registerSettingsPanel(settingsPanel("Bad Id"))).toThrow();
      expect(() => registerSettingsPanel(settingsPanel(""))).toThrow();
    });

    it("accepts multiple distinct panels", () => {
      registerSettingsPanel(settingsPanel("a"));
      registerSettingsPanel(settingsPanel("b"));
      expect(getSettingsPanels().map((p) => p.id)).toEqual(["a", "b"]);
    });
  });

  describe("first-party mermaid command still passes (no regression)", () => {
    it("registerCoreCommands is idempotent (second call is a no-op, not a throw)", () => {
      resetRegistryForTests();
      registerCoreCommands();
      registerCoreCommands();
      const cmds = getSlashCommands().filter((c) => c.name === "mermaid");
      expect(cmds.length).toBe(1);
    });
  });
});
