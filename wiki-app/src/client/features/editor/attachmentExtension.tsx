import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  FileJson,
  FileType,
  File,
  Download,
} from "lucide-react";

export interface AttachmentAttrs {
  url: string;
  name: string;
  mime: string;
  size: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    attachment: {
      /** Insert a file-attachment block (icon + name, hover reveals full name) */
      setAttachment: (attrs: AttachmentAttrs) => ReturnType;
    };
  }
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1]! : "";
}

/**
 * Map a filename/mime to a Lucide icon. Docmost shows one paperclip glyph for
 * every attachment; we do slightly better and pick a per-type icon (pdf/docs →
 * FileText, sheets → FileSpreadsheet, code → FileCode, images/archives/video/
 * audio/json get their own), falling back to a generic File. The mapping is
 * pure so the (non-React) static render can reuse it.
 */
export function attachmentIconFor(name: string, mime = ""): {
  icon: string;
  label: string;
} {
  const m = mime.toLowerCase();
  const ext = extOf(name);
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return { icon: "image", label: "Image file" };
  }
  if (m.startsWith("video/") || ["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) {
    return { icon: "video", label: "Video file" };
  }
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) {
    return { icon: "audio", label: "Audio file" };
  }
  if (m === "application/pdf" || ext === "pdf") return { icon: "pdf", label: "PDF document" };
  if (["doc", "docx", "odt", "rtf", "txt", "md", "tex"].includes(ext)) {
    return { icon: "text", label: "Document" };
  }
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)) {
    return { icon: "sheet", label: "Spreadsheet" };
  }
  if (["zip", "gz", "tar", "7z", "rar", "bz2", "xz"].includes(ext)) {
    return { icon: "archive", label: "Archive" };
  }
  if (["json", "yaml", "yml", "xml", "toml"].includes(ext)) {
    return { icon: "json", label: "Data file" };
  }
  if (["js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "sh", "html", "css", "sql"].includes(ext)) {
    return { icon: "code", label: "Code file" };
  }
  return { icon: "file", label: "File" };
}

function FileGlyph({ kind }: { kind: string }) {
  const common = { size: 20, "aria-hidden": true as const };
  switch (kind) {
    case "image": return <FileImage {...common} />;
    case "video": return <FileVideo {...common} />;
    case "audio": return <FileAudio {...common} />;
    case "pdf": return <FileText {...common} />;
    case "text": return <FileText {...common} />;
    case "sheet": return <FileSpreadsheet {...common} />;
    case "archive": return <FileArchive {...common} />;
    case "json": return <FileJson {...common} />;
    case "code": return <FileCode {...common} />;
    case "type": return <FileType {...common} />;
    default: return <File {...common} />;
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function AttachmentView({ node, editor }: NodeViewProps) {
  const { url, name, mime, size } = node.attrs as unknown as AttachmentAttrs;
  const { icon } = attachmentIconFor(name, mime);
  return (
    <NodeViewWrapper className="wiki-attachment" data-drag-handle>
      <div className="wiki-attachment-inner" title={`${name}${size ? ` (${formatBytes(size)})` : ""}`}>
        <span className="wiki-attachment-icon" data-kind={icon} title={icon}>
          <FileGlyph kind={icon} />
        </span>
        <span className="wiki-attachment-name">{name}</span>
        {size > 0 && <span className="wiki-attachment-size">{formatBytes(size)}</span>}
        {url && (
          <a
            className="wiki-attachment-download"
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Download file"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={15} />
          </a>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * File-attachment content node (block). A real content-model node so it lives
 * in baseEditorExtensions: pages containing attachments must parse in the
 * read-only ShareView and the server's collab seed schema too. `getSchema()`
 * ignores node views, so ReactNodeViewRenderer is safe to import here (the
 * server runs this module under tsx; only the browser ever instantiates the
 * view).
 */
export const Attachment = Node.create({
  name: "attachment",

  group: "block",
  isolating: true,
  atom: true,
  defining: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      name: { default: "" },
      mime: { default: "" },
      size: { default: 0 },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-type='attachment']" }];
  },

  renderHTML({ HTMLAttributes }) {
    const { url, name, mime, size } = HTMLAttributes;
    const { icon, label } = attachmentIconFor(name ?? "", mime ?? "");
    return [
      "div",
      mergeAttributes({ "data-type": "attachment" }, HTMLAttributes, {
        class: "wiki-attachment",
        title: `${name ?? ""}${size ? ` (${formatBytes(Number(size))})` : ""}`,
      }),
      [
        "div",
        { class: "wiki-attachment-inner" },
        [
          "span",
          { class: "wiki-attachment-icon", "data-kind": icon, "aria-label": label },
          icon === "pdf" || icon === "text" || icon === "type" ? "📄"
            : icon === "sheet" ? "📊"
            : icon === "code" ? "🧾"
            : icon === "archive" ? "🗜"
            : icon === "image" ? "🖼"
            : icon === "video" ? "🎬"
            : icon === "audio" ? "🎵"
            : icon === "json" ? "🛢"
            : "📎",
        ],
        ["span", { class: "wiki-attachment-name" }, name ?? ""],
        ...(size && Number(size) > 0
          ? [["span", { class: "wiki-attachment-size" }, formatBytes(Number(size))] as any]
          : []),
        url
          ? ["a", { class: "wiki-attachment-download", href: url, target: "_blank", rel: "noreferrer" }, "↓"]
          : ([] as any[]),
      ],
    ];
  },

  addCommands() {
    return {
      setAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
});
