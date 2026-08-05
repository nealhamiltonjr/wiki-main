import { buildApp } from "./app.js";
import { initGitRepo } from "./services/git.service.js";
import { runWorkerLoop } from "./queue/worker.js";
import { log } from "./services/log.service.js";
import { hocuspocus } from "./services/collab.service.js";
import { initFts, applyMigrations } from "./db/index.js";
import { WebSocketServer } from "ws";

const start = async () => {
  const app = await buildApp({ logger: true });

  // FTS5 virtual table — created after drizzle-kit push has run so the
  // push tool doesn't trip over SQLite's internal shadow tables.
  initFts();

  await initGitRepo();
  runWorkerLoop().catch((e) => log("error", "worker", "worker loop crashed", { error: String(e) }));

  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });

    // Attach a WebSocketServer to the existing HTTP server and forward
    // collaboration connections to Hocuspocus. Hocuspocus v4 does NOT wire up
    // the socket's message/close events itself when used with a bare `ws`
    // server - that's handled by its internal crossws adapter - so we must
    // forward them to the returned ClientConnection explicitly.
    const wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/collaboration") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const connection = hocuspocus.handleConnection(ws, request as any);
          ws.on("message", (data) => {
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
            connection.handleMessage(bytes);
          });
          ws.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
          ws.on("error", (err) => log("error", "collab-ws", "websocket error", { error: String(err) }));
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
