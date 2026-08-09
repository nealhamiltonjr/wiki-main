import { buildApp } from "./app.js";
import { initGitRepo } from "./services/git.service.js";
import { startWorkerLoop } from "./services/queue.service.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const start = async () => {
  const app = await buildApp({ logger: true });
  try {
    // Git flush pipeline (§8 step 10): ensure the content repo exists before
    // the first commit lands, then drain the commit queue in the background.
    // Not part of buildApp so `.inject()` tests never spin up the timer.
    await initGitRepo();
    startWorkerLoop();

    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 API listening on http://${HOST}:${PORT}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
