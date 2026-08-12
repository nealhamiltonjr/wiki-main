// Draw.io Embed plugin — client side (§4.6). A genuinely new content type
// (not just UI chrome): a `drawioEmbed` atom node holding the diagram XML. It
// exercises registerTiptapExtension + registerSlashCommand + registerEmbedType.
//
// Editor view: the node's renderHTML draws a placeholder box with an
// "Open in draw.io" link carrying the XML as a data payload. Read-only view:
// registerEmbedType's renderReadOnly renders the same box (plus a collapsible
// raw-XML <pre>), proving plugin content types render without the editor.
// The host's ReadOnlyContent looks embed renderers up by node type name.

const DEFAULT_XML =
  '<mxfile><diagram name="New Diagram" id="demo">' +
  '<mxGraphModel dx="700" dy="500" grid="1" gridSize="10">' +
  '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Hello" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1">' +
  '<mxGeometry x="120" y="120" width="120" height="60" as="geometry"/>' +
  "</mxCell></root></mxGraphModel></diagram></mxfile>";

function drawioHref(xml) {
  // draw.io opens a base64-encoded XML payload from the URL fragment (#D…).
  // Unicode-safe base64 (btoa can't take raw chars > U+00FF).
  const bytes = unescape(encodeURIComponent(xml));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes.charCodeAt(i));
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `https://app.diagrams.net/#D${b64}`;
}

export default function register(api) {
  const { Tiptap, React, registerTiptapExtension, registerSlashCommand, registerEmbedType } = api;

  registerTiptapExtension(
    Tiptap.Node.create({
      name: "drawioEmbed",
      group: "block",
      atom: true,
      selectable: true,
      addAttributes() {
        return {
          title: { default: "Untitled diagram" },
          xml: { default: DEFAULT_XML },
        };
      },
      parseHTML() {
        return [{ tag: "div[data-drawio-embed]" }];
      },
      renderHTML({ node }) {
        return [
          "div",
          {
            "data-drawio-embed": "true",
            style:
              "border:1px solid #d0d7de;border-radius:8px;padding:12px;background:#f6f8fa;display:flex;flex-direction:column;gap:8px;",
          },
          ["div", { style: "font-weight:600;color:#24292f;" }, "📐 " + node.attrs.title],
          [
            "a",
            {
              href: drawioHref(node.attrs.xml),
              target: "_blank",
              rel: "noopener noreferrer",
              style: "color:#0969da;font-size:0.875rem;",
            },
            "Open in draw.io",
          ],
        ];
      },
    })
  );

  registerSlashCommand({
    name: "drawio-embed-insert",
    label: "Insert Draw.io embed",
    icon: "📐",
    keywords: ["diagram", "drawio", "draw.io", "flowchart", "embed"],
    run(editor) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "drawioEmbed", attrs: { title: "New diagram" } })
        .run();
    },
  });

  registerEmbedType({
    name: "drawioEmbed",
    label: "Draw.io diagram",
    icon: "📐",
    renderReadOnly(attrs) {
      const title = attrs.title || "Untitled diagram";
      const xml = typeof attrs.xml === "string" ? attrs.xml : DEFAULT_XML;
      const h = React.createElement;
      // NOTE: style must be an OBJECT here — this is React.createElement, not
      // Tiptap's renderHTML DOM spec (which takes a style string).
      return h(
        "div",
        {
          "data-drawio-embed": "true",
          "data-title": title,
          style: {
            border: "1px solid #d0d7de",
            borderRadius: "8px",
            padding: "12px",
            background: "#f6f8fa",
            margin: "8px 0",
          },
        },
        h(
          "div",
          { style: { fontWeight: 600, color: "#24292f", marginBottom: "6px" } },
          "📐 " + title
        ),
        h(
          "div",
          { style: { display: "flex", gap: "12px", fontSize: "0.875rem" } },
          h(
            "a",
            { href: drawioHref(xml), target: "_blank", rel: "noopener noreferrer", style: { color: "#0969da" } },
            "Open in draw.io"
          )
        ),
        h(
          "details",
          { style: { marginTop: "8px" } },
          h("summary", { style: { cursor: "pointer", fontSize: "0.75rem", color: "#57606a" } }, "View diagram XML"),
          h(
            "pre",
            {
              style: {
                fontSize: "0.7rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                background: "#fff",
                border: "1px solid #d0d7de",
                borderRadius: "6px",
                padding: "8px",
                marginTop: "6px",
              },
            },
            xml
          )
        )
      );
    },
  });
}
