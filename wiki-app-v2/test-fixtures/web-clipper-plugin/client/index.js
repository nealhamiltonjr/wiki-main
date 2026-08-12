// Web Clipper plugin — client side (§4.6). One slash command: ask for a URL,
// fetch it through the plugin's own server route, then insert a citation block
// (linked title + blockquote excerpt) into the document. The fetch goes to the
// plugin's route so the SSRF guard and access control live server-side.

export default function register(api) {
  const { registerSlashCommand } = api;

  registerSlashCommand({
    name: "web-clip",
    label: "Insert web clip",
    icon: "🔖",
    keywords: ["url", "bookmark", "link", "clip", "fetch", "cite"],
    async run(editor) {
      const raw = window.prompt("URL to clip:");
      if (!raw || !raw.trim()) return;
      const url = raw.trim();

      let data;
      try {
        const res = await fetch("/api/plugins/web-clipper/clip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || `Clip failed (HTTP ${res.status})`);
      } catch (err) {
        window.alert(`Could not clip that URL: ${err.message}`);
        return;
      }

      const title = data.title || data.url || url;
      const safeUrl = data.url || url;
      const siteName = data.siteName ? `${data.siteName} — ` : "";
      const description = data.description || "No description captured for this page.";

      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: "paragraph",
            content: [
              { type: "text", text: `🔖 ${siteName}` },
              {
                type: "text",
                text: title,
                marks: [{ type: "link", attrs: { href: safeUrl } }],
              },
            ],
          },
          {
            type: "blockquote",
            content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
          },
        ])
        .run();
    },
  });
}
