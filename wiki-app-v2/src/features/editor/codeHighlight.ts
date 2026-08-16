import { resolveCodeLanguage } from "@/shared/codeLanguages";

type PrismModule = typeof import("prismjs");
type PrismInstance = PrismModule;

let prismPromise: Promise<PrismInstance> | null = null;
const grammarPromises = new Map<string, Promise<unknown>>();

async function getPrism(): Promise<PrismInstance> {
  if (!prismPromise) { prismPromise = import("prismjs").then((m) => m); }
  return prismPromise;
}

async function loadGrammar(prism: PrismInstance, grammarId: string): Promise<unknown> {
  if (prism.languages[grammarId]) return prism.languages[grammarId];
  let p = grammarPromises.get(grammarId);
  if (!p) { p = import(/* @vite-ignore */ `prismjs/components/prism-${grammarId}.js`).then(() => prism.languages[grammarId]).catch(() => null); grammarPromises.set(grammarId, p); }
  return p;
}

export async function highlightCode(code: string, language: string | null | undefined): Promise<string | null> {
  if (!language) return null;
  try {
    const prism = await getPrism();
    const grammarId = resolveCodeLanguage(language).id;
    const grammar = await loadGrammar(prism, grammarId);
    const resolved = grammar ?? prism.languages.plaintext;
    if (!resolved) return null;
    return prism.highlight(code, resolved, grammarId);
  } catch { return null; }
}

export function highlightCodeSync(code: string, language: string | null | undefined): string | null {
  if (!language) return null;
  try {
    if (!prismPromise) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Prism = require("prismjs");
    const grammarId = resolveCodeLanguage(language).id;
    return Prism.highlight(code, Prism.languages[grammarId] ?? Prism.languages.plaintext, grammarId);
  } catch { return null; }
}

export async function preloadPrismLanguage(language: string): Promise<void> {
  const prism = await getPrism(); const grammarId = resolveCodeLanguage(language).id; await loadGrammar(prism, grammarId);
}
