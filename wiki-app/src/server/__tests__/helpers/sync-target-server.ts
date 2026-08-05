/**
 * Child-process entry for the sync integration test (§A5): boots a SECOND,
 * fully separate wiki-app instance (own DB, own git repo, own files root) on
 * an ephemeral port and prints `TARGET_URL=...` to stdout once it's listening.
 *
 * The parent test spawns this so sync can be exercised against a real remote
 * instance instead of two same-name spaces sharing one DB (which made the
 * probe's space match order-dependent).
 */
import { buildApp } from "../../app.js";
import { initGitRepo } from "../../services/git.service.js";
import { initFts } from "../../db/index.js";

const port = Number(process.env.TARGET_PORT ?? 0);

const app = await buildApp();
await app.ready();
initFts();
await initGitRepo();
await app.listen({ port, host: "127.0.0.1" });

const addr = app.server.address() as { port: number };
console.log(`TARGET_URL=http://127.0.0.1:${addr.port}`);

process.on("SIGTERM", () => {
  void app.close().then(() => process.exit(0));
});
