import type { FastifyInstance } from "fastify";

/**
 * Baseline security headers — a day-one requirement (brief §3.2), registered
 * globally as an onSend hook so every response (API and, later, the served
 * SPA HTML) carries them. Deliberately not a bolt-on later.
 *
 * CSP is strict about script (only same-origin), while allowing inline styles
 * — shadcn/Tiptap legitimately set element styles at runtime. Inline <script>
 * remains impossible; object/embed are banned; frame embedding is refused.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 'self' covers same-origin fetch/XHR; ws:/wss: covers the collab WebSocket.
  "connect-src 'self' ws: wss:",
].join("; ");

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", (_request, reply, _payload, done) => {
    void reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "same-origin")
      .header("Content-Security-Policy", CSP);
    done();
  });
}
