import { buildApp } from "./app.js";
import { initGitRepo } from "./services/git.service.js";
import { runWorkerLoop } from "./queue/worker.js";
import { log } from "./services/log.service.js";
import { hocuspocus } from "./services/collab.service.js";
import { WebSocketServer } from "ws";

const start = async () => {
  const app = await buildApp({ logger: true });

  await initGitRepo();
  runWorkerLoop().catch((e) => log("error", "worker", "worker loop crashed", { error: String(e) }));

  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });

    // Attach a WebSocketServer to the existing HTTP server and forward
    // collaboration connections to Hocuspocus.
    const wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/collaboration") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          hocuspocus.handleConnection(ws, request as any);
        });
      }
    });

    console.log("\n🚀 API + WebSocket listening on http://0.0.0.0:3000\n");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
