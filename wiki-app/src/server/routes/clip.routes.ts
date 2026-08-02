import type { FastifyInstance } from "fastify";
import { z } from "zod";
import TurndownService from "turndown";
import { markdownToTiptap } from "../services/markdown.service.js";
import { createPage } from "../services/page.service.js";
import { resolveSpaceRole } from "../services/branch.service.js";
import { db } from "../db/index.js";
import { spaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { UserContext } from "../../shared/types.js";

const clipBody = z.object({
  html: z.string().min(1),
  sourceUrl: z.string().url(),
  title: z.string().min(1),
  spaceId: z.string().min(1),
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "clip";
}

export async function clipRoutes(app: FastifyInstance) {
  app.post(
    "/api/clip",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const body = clipBody.parse(request.body);
      const user = (request as any).userContext as UserContext;

      // Verify editor access on the target space
      if (!user.isAdmin) {
        const role = await resolveSpaceRole(user.id, body.spaceId, user.groupIds);
        if (!role || (role !== "editor" && role !== "admin")) {
          return reply.code(403).send({ error: "Insufficient space permissions" });
        }
      }

      // HTML → Markdown → Tiptap JSON
      const markdown = turndown.turndown(body.html);
      const snippet = markdown.slice(0, 2000); // reasonable truncation for one clip
      const attribution = `> Clipped from [${body.sourceUrl}](${body.sourceUrl})\n\n`;
      const content = markdownToTiptap(attribution + snippet);

      const result = await createPage({
        slug: slugify(body.title),
        ownerId: user.id,
        spaceId: body.spaceId,
        parentBranchId: null,
        initialContent: content,
      });

      return reply.code(201).send(result);
    }
  );

  // §7.18 Web clipper interstitial — a tiny standalone page loaded in the
  // bookmarklet's popup. It receives the page HTML via postMessage, then lets
  // the user pick a space and confirm the clip. Same-origin, so the session
  // cookie carries auth without any token management.
  app.get(
    "/clipper",
    { config: { access: "public" } },
    async (_request, reply) => {
      reply.type("text/html").send(CLIPPER_HTML);
    }
  );
}

// Precompiled HTML/JS for the bookmarklet popup. Lightweight, no build step,
// and fully self-contained so it loads instantly in the popup.
const CLIPPER_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wiki Clipper</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;padding:16px;color:#1f2937;background:#fff}
  h1{font-size:16px;font-weight:600;margin-bottom:12px}
  label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;margin-top:12px}
  input,select{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;font-family:inherit}
  input:focus,select:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.15)}
  button{display:block;width:100%;margin-top:16px;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:12px;font-size:12px;color:#6b7280;min-height:20px}
  #status.error{color:#dc2626}
  #status.success{color:#16a34a}
</style>
<h1>Clip to Wiki</h1>
<label for="space">Space</label>
<select id="space"></select>
<label for="title">Title</label>
<input id="title" placeholder="Page title">
<button id="clip">Clip</button>
<div id="status"></div>
<script>
var html = null, sourceUrl = '', originalTitle = '';
window.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'clip') return;
  html = e.data.html;
  sourceUrl = e.data.sourceUrl || '';
  originalTitle = e.data.title || '';
  document.getElementById('title').value = originalTitle;
  fetch('/api/spaces', { credentials: 'include' })
    .then(function(r) { return r.json(); })
    .then(function(spaces) {
      var sel = document.getElementById('space');
      spaces.forEach(function(s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        sel.appendChild(o);
      });
    })
    .catch(function() { setStatus('Failed to load spaces', true); });
  document.getElementById('clip').onclick = doClip;
  document.getElementById('title').onkeydown = function(ev) { if (ev.key === 'Enter') doClip(); };
});

// Signal the opener (bookmarklet) that we're ready to receive the page data.
if (window.opener) { window.opener.postMessage({ type: 'ready' }, '*'); }

function doClip() {
  var spaceId = document.getElementById('space').value;
  var title = document.getElementById('title').value.trim() || originalTitle;
  if (!spaceId || !html) return;
  var btn = document.getElementById('clip');
  btn.disabled = true;
  setStatus('Clipping…');
  fetch('/api/clip', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: html, sourceUrl: sourceUrl, title: title, spaceId: spaceId })
  })
  .then(function(r) { return r.json().then(function(d) { return {ok:r.ok,d:d}; }); })
  .then(function(v) {
    if (v.ok) {
      setStatus('Clipped!', false, true);
      setTimeout(function() { window.close(); }, 1200);
    } else {
      setStatus((v.d && v.d.error) || 'Clip failed', true);
      btn.disabled = false;
    }
  })
  .catch(function() { setStatus('Network error', true); btn.disabled = false; });
}

function setStatus(msg, isErr, isSuccess) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = isErr ? 'error' : isSuccess ? 'success' : '';
}
</script>`;
