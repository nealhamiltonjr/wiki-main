import { useMemo } from "react";

/**
 * §7.18 Clipper bookmarklet — the server hosts the interstitial popup at /clipper;
 * this component just provides the bookmarklet code that the user drags onto
 * their bookmark bar. The code opens the popup (same-origin, so cookies work),
 * grabs the page's HTML + title, and sends them via postMessage.
 */
export function ClipperSection() {
  const wikiOrigin = window.location.origin;

  const bookmarklet = useMemo(() => {
    const src = `javascript:(function(){
var w=window.open('${encodeURI(wikiOrigin)}/clipper','wclip','width=420,height=520');
function onMsg(e){if(e.data&&e.data.type==='ready'){w.postMessage({type:'clip',html:document.documentElement.outerHTML,title:document.title,sourceUrl:window.location.href},'*');window.removeEventListener('message',onMsg)}}
window.addEventListener('message',onMsg);
setTimeout(function(){w.postMessage({type:'ready'},'*')},300);
})()`;
    return src;
  }, [wikiOrigin]);

  return (
    <section className="settings-card">
      <h3>Web Clipper</h3>
      <p className="settings-help" style={{ marginBottom: 12 }}>
        Drag the link below to your bookmarks bar. On any web page, click the bookmark
        to clip the page into a wiki space. The popup loads from this server — your
        existing login session carries through automatically.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <a
          href={bookmarklet}
          className="settings-btn primary"
          style={{
            padding: "8px 16px",
            textDecoration: "none",
            display: "inline-block",
            cursor: "grab",
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", bookmarklet);
            e.dataTransfer.setData("text/uri-list", bookmarklet);
          }}
        >
          📋 Clip to Wiki
        </a>
        <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
          ← Drag to bookmarks bar
        </span>
      </div>
    </section>
  );
}
