/**
 * Canonical code-language metadata for §13.6 code pages. One place maps the
 * user-facing language string to (a) the Prism grammar id used for read-mode
 * highlighting, (b) the file extension used by the git export, and (c) a human
 * label for the UI.
 *
 * Shared between server (git export) and client (editor/read view) so the
 * filename on disk and the language tag shown in the UI can never disagree.
 */

export interface CodeLanguageInfo {
  /** Canonical id — also the Prism grammar id where one exists. */
  id: string;
  label: string;
  ext: string;
}

const LANGUAGES: Record<string, CodeLanguageInfo> = {
  bash: { id: "bash", label: "Shell", ext: "sh" },
  sh: { id: "bash", label: "Shell", ext: "sh" },
  zsh: { id: "bash", label: "Shell", ext: "sh" },
  python: { id: "python", label: "Python", ext: "py" },
  py: { id: "python", label: "Python", ext: "py" },
  javascript: { id: "javascript", label: "JavaScript", ext: "js" },
  js: { id: "javascript", label: "JavaScript", ext: "js" },
  jsx: { id: "jsx", label: "JSX", ext: "jsx" },
  typescript: { id: "typescript", label: "TypeScript", ext: "ts" },
  ts: { id: "typescript", label: "TypeScript", ext: "ts" },
  tsx: { id: "tsx", label: "TSX", ext: "tsx" },
  json: { id: "json", label: "JSON", ext: "json" },
  yaml: { id: "yaml", label: "YAML", ext: "yaml" },
  yml: { id: "yaml", label: "YAML", ext: "yaml" },
  toml: { id: "toml", label: "TOML", ext: "toml" },
  markdown: { id: "markdown", label: "Markdown", ext: "md" },
  md: { id: "markdown", label: "Markdown", ext: "md" },
  sql: { id: "sql", label: "SQL", ext: "sql" },
  go: { id: "go", label: "Go", ext: "go" },
  rust: { id: "rust", label: "Rust", ext: "rs" },
  rs: { id: "rust", label: "Rust", ext: "rs" },
  java: { id: "java", label: "Java", ext: "java" },
  css: { id: "css", label: "CSS", ext: "css" },
  html: { id: "html", label: "HTML", ext: "html" },
  xml: { id: "xml", label: "XML", ext: "xml" },
  dockerfile: { id: "docker", label: "Dockerfile", ext: "dockerfile" },
  docker: { id: "docker", label: "Dockerfile", ext: "dockerfile" },
  graphql: { id: "graphql", label: "GraphQL", ext: "graphql" },
  c: { id: "c", label: "C", ext: "c" },
  cpp: { id: "cpp", label: "C++", ext: "cpp" },
  csharp: { id: "csharp", label: "C#", ext: "cs" },
  cs: { id: "csharp", label: "C#", ext: "cs" },
  kotlin: { id: "kotlin", label: "Kotlin", ext: "kt" },
  kt: { id: "kotlin", label: "Kotlin", ext: "kt" },
  swift: { id: "swift", label: "Swift", ext: "swift" },
  php: { id: "php", label: "PHP", ext: "php" },
  ruby: { id: "ruby", label: "Ruby", ext: "rb" },
  rb: { id: "ruby", label: "Ruby", ext: "rb" },
  lua: { id: "lua", label: "Lua", ext: "lua" },
  perl: { id: "perl", label: "Perl", ext: "pl" },
  pl: { id: "perl", label: "Perl", ext: "pl" },
  r: { id: "r", label: "R", ext: "r" },
  scala: { id: "scala", label: "Scala", ext: "scala" },
  dart: { id: "dart", label: "Dart", ext: "dart" },
  elixir: { id: "elixir", label: "Elixir", ext: "ex" },
  ex: { id: "elixir", label: "Elixir", ext: "ex" },
  erlang: { id: "erlang", label: "Erlang", ext: "erl" },
  erl: { id: "erlang", label: "Erlang", ext: "erl" },
  haskell: { id: "haskell", label: "Haskell", ext: "hs" },
  hs: { id: "haskell", label: "Haskell", ext: "hs" },
  clojure: { id: "clojure", label: "Clojure", ext: "clj" },
  clj: { id: "clojure", label: "Clojure", ext: "clj" },
  vim: { id: "vim", label: "Vim script", ext: "vim" },
  plaintext: { id: "plaintext", label: "Plain text", ext: "txt" },
  txt: { id: "plaintext", label: "Plain text", ext: "txt" },
  text: { id: "plaintext", label: "Plain text", ext: "txt" },
};

/**
 * Resolve a user-supplied language string to canonical metadata. Unknown
 * languages fall back to plaintext so the page still renders and exports; a
 * null/empty language means an unlabeled code page (still exported as .txt).
 */
export function resolveCodeLanguage(input: string | null | undefined): CodeLanguageInfo {
  if (!input) return { id: "plaintext", label: "Plain text", ext: "txt" };
  const key = input.trim().toLowerCase();
  return LANGUAGES[key] ?? { id: key, label: input.trim(), ext: "txt" };
}

/** The file extension (without a leading dot) for a code page's git export. */
export function codeLanguageExtension(input: string | null | undefined): string {
  return resolveCodeLanguage(input).ext;
}
