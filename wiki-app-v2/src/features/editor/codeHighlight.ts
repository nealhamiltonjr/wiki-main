import { resolveCodeLanguage } from "@/shared/codeLanguages";

/**
 * Shared Prism highlighter for §13.6 code content. Used by both the embedded
 * code block in rich text and the whole-page code view, so the language-alias
 * resolution and Prism component loading live in exactly one place.
 *
 * Returns pre-escaped HTML (Prism escapes text by construction — safe for
 * dangerouslySetInnerHTML), or null when there is no grammar to apply and the
 * caller should render plain escaped text instead.
 */
export function highlightCode(code: string, language: string | null | undefined): string | null {
  if (!language) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Prism = require("prismjs");
    const grammarId = resolveCodeLanguage(language).id;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(`prismjs/components/prism-${grammarId}`);
    } catch {
      // Component not bundled; Prism.languages[grammarId] falls back to plaintext.
    }
    return Prism.highlight(code, Prism.languages[grammarId] ?? Prism.languages.plaintext, grammarId);
  } catch {
    return null;
  }
}
