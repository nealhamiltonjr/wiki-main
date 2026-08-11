import { buildApp } from "./app.js";
import { initGitRepo } from "./services/git.service.js";
import { startWorkerLoop } from "./services/queue.service.js";
import { hocuspocus } from "./services/collab.service.js";
import { WebSocketServer } from "ws";

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

    // Collab (§8 step 11): attach a WebSocketServer to the existing HTTP
    // server and forward `/api/collaboration` connections to Hocuspocus.
    // Hocuspocus v4 does NOT wire up the socket's message/close events itself
    // when used with a bare `ws` server - forward them to the returned
    // ClientConnection explicitly.
    const wss = new WebSocketServer({ noServer: true });
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/collaboration") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const connection = hocuspocus.handleConnection(ws, request as never);
          ws.on("message", (data) => {
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
            connection.handleMessage(bytes);
          });
          ws.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
          ws.on("error", (err) => app.log.error({ err }, "collab websocket error"));
        });
      }
    });

    console.log(`\n🚀 API + WebSocket listening on http://${HOST}:${PORT}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
