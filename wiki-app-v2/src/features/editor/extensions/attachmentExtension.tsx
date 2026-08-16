import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { FileText, FileCode, FileImage, FileArchive, FileVideo, FileAudio, Download, File as FileIcon } from "lucide-react";

export interface AttachmentAttrs { url: string; name: string; mime: string; size: number; }

declare module "@tiptap/core" {
  interface Commands<ReturnType> { attachment: { setAttachment: (attrs: AttachmentAttrs) => ReturnType; }; }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function AttachmentIcon({ mime, name }: { mime: string; name: string }) {
  const m = mime.toLowerCase(); const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  if (m.startsWith("image/") || ["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext)) return <FileImage className="h-5 w-5" />;
  if (m.startsWith("video/") || ["mp4","mov","webm","avi","mkv"].includes(ext)) return <FileVideo className="h-5 w-5" />;
  if (m.startsWith("audio/") || ["mp3","wav","ogg","flac","m4a"].includes(ext)) return <FileAudio className="h-5 w-5" />;
  if (m === "application/pdf" || ext === "pdf") return <FileText className="h-5 w-5" />;
  if (["zip","tar","gz","7z","rar"].includes(ext)) return <FileArchive className="h-5 w-5" />;
  if (m.startsWith("text/") || ["ts","tsx","js","jsx","py","rb","go","rs","c","cpp","h","java","sh","yml","yaml","json","toml","md"].includes(ext)) return <FileCode className="h-5 w-5" />;
  return <FileIcon className="h-5 w-5" />;
}

function AttachmentNodeView({ node }: NodeViewProps) {
  const { url, name, mime, size } = node.attrs as AttachmentAttrs;
  return (
    <NodeViewWrapper className="attachment-node" data-attachment={name}>
      <a href={url} download={name} className="attachment-card" target={mime === "application/pdf" || mime.startsWith("video/") || mime.startsWith("audio/") ? "_blank" : undefined} rel={mime === "application/pdf" || mime.startsWith("video/") || mime.startsWith("audio/") ? "noopener noreferrer" : undefined}>
        <div className="attachment-icon"><AttachmentIcon mime={mime} name={name} /></div>
        <div className="attachment-meta"><div className="attachment-name">{name}</div><div className="attachment-info">{formatSize(size)}{mime ? ` · ${mime}` : ""}</div></div>
        <div className="attachment-download"><Download className="h-4 w-4" /></div>
      </a>
    </NodeViewWrapper>
  );
}

export const Attachment = Node.create({
  name: "attachment", group: "block", atom: true, draggable: true, selectable: true,
  addAttributes() { return { url: { default: null }, name: { default: "" }, mime: { default: "" }, size: { default: 0 } }; },
  parseHTML() { return [{ tag: "div[data-attachment]" }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "attachment" })]; },
  addNodeView() { return ReactNodeViewRenderer(AttachmentNodeView); },
  addCommands() { return { setAttachment: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) }; },
});
