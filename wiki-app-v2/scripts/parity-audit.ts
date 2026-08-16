#!/usr/bin/env tsx
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const V14_ROOT = path.resolve(ROOT, "..", "wiki-app");
const V2_ROOT = ROOT;

interface Gap { category: string; name: string; v14Path: string; v2Status: "missing" | "partial" | "present"; notes?: string; }

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

async function main() {
  if (!existsSync(V14_ROOT)) { console.error(`V14 codebase not found at ${V14_ROOT}`); process.exit(2); }
  const gaps: Gap[] = [];
  const v14Routes = await listFiles(path.join(V14_ROOT, "src/server/routes"));
  const v2Routes = await listFiles(path.join(V2_ROOT, "src/server/routes"));
  for (const r of v14Routes) {
    if (!r.endsWith(".routes.ts")) continue;
    if (v2Routes.includes(r)) gaps.push({ category: "Server route", name: r, v14Path: r, v2Status: "present" });
    else gaps.push({ category: "Server route", name: r, v14Path: `wiki-app/src/server/routes/${r}`, v2Status: "missing" });
  }
  const missing = gaps.filter((g) => g.v2Status === "missing");
  const present = gaps.filter((g) => g.v2Status === "present");
  console.log("═".repeat(72));
  console.log("Feature parity audit — V14 (legacy) vs V2 (rebuild)");
  console.log("═".repeat(72));
  console.log(`\n  Present in both: ${present.length}`);
  console.log(`  Missing in V2:   ${missing.length}\n`);
  if (missing.length > 0) {
    console.log("─".repeat(72));
    console.log("MISSING in V2:");
    for (const g of missing) console.log(`  [${g.category}] ${g.name} — V14: ${g.v14Path}`);
    process.exit(1);
  }
  console.log("✅ No unacknowledged gaps found."); process.exit(0);
}
main().catch((err) => { console.error("Parity audit failed:", err); process.exit(2); });
