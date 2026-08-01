import { buildApp } from "./app.js";
import { initGitRepo } from "./services/git.service.js";
import { runWorkerLoop } from "./queue/worker.js";
import { log } from "./services/log.service.js";

const start = async () => {
  const app = await buildApp({ logger: true });

  await initGitRepo();
  runWorkerLoop().catch((e) => log("error", "worker", "worker loop crashed", { error: String(e) }));

  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });
    console.log("\n🚀 API listening on http://0.0.0.0:3000\n");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
