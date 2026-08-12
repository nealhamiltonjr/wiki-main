// Web Clipper plugin — server side (§4.6). Port of the old app's (weak)
// clip.routes: given a URL, fetch the page and return its title / site name /
// description so the client can insert a tidy citation block into the document.
//
// Route contract: POST /api/plugins/web-clipper/clip  { "url": "https://…" }
//   → 200 { url, title, siteName, description }
//
// SSRF guard: only http(s) is accepted, and by default loopback/private/
// link-local targets are rejected (a server that fetches user-supplied URLs is
// a classic SSRF vector — the old clip.routes fetched anything). Set
// ALLOW_PRIVATE_CLIP_HOSTS=1 for LAN instances that legitimately clip their own
// hosts. The route is registered with config.access: "authenticated", so only
// logged-in users can trigger fetches at all.

import dns from "node:dns/promises";

const MAX_BODY = 2 * 1024 * 1024; // 2 MB of HTML is plenty for metadata

function isBlockedAddress(address) {
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → check the embedded v4 address.
  const v6 = address.includes(":");
  if (v6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (m) return isBlockedV4(m[1]);
    if (address.toLowerCase() === "::1") return true;
    // fc00::/7 (ULA) and fe80::/10 (link-local) are non-routable.
    const lower = address.toLowerCase();
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return isBlockedV4(address);
}

function isBlockedV4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true;                       // 0.0.0.0/8
  return false;
}

async function isPrivateTarget(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  // If it's already an IP literal, no DNS needed.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return isBlockedAddress(host);
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return true; // unresolvable → refuse rather than leak a DNS error
  }
  return addresses.some(({ address }) => isBlockedAddress(address));
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractMeta(html, fallbackHost) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : fallbackHost;

  const readMeta = (attrName, key) => {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      "i"
    );
    const altRe = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${key}["']`,
      "i"
    );
    const m = re.exec(html) || altRe.exec(html);
    return m ? decodeEntities(m[1].trim()) : "";
  };

  const siteName = readMeta("property", "og:site_name");
  const description = readMeta("name", "description") || readMeta("property", "og:description");

  return { title, siteName, description };
}

export default function webClipperPlugin(app, opts, done) {
  app.post(
    "/clip",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const body = request.body;
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      if (!url) return reply.code(400).send({ error: "Missing 'url' in request body" });

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return reply.code(400).send({ error: "Invalid URL" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return reply.code(400).send({ error: "Only http(s) URLs can be clipped" });
      }

      if (process.env.ALLOW_PRIVATE_CLIP_HOSTS !== "1" && (await isPrivateTarget(parsed.hostname))) {
        return reply.code(400).send({ error: "Target host is not routable (SSRF guard)" });
      }

      let res;
      try {
        res = await fetch(url, {
          redirect: "follow",
          headers: { "user-agent": "wiki-web-clipper/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return reply.code(502).send({ error: "Could not fetch the target URL" });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: `Target returned HTTP ${res.status}` });
      }

      const text = await res.text();
      if (text.length > MAX_BODY) {
        return reply.code(413).send({ error: "Target page is too large to clip" });
      }

      const { title, siteName, description } = extractMeta(text, parsed.hostname);
      return {
        url: res.url || url,
        title,
        siteName,
        description,
      };
    }
  );
  done();
}
