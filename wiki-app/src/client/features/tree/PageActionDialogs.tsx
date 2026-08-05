import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Check, ExternalLink } from "lucide-react";
import { api, type TreeNode } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";

/** Best-effort clipboard copy with a toast, works outside secure contexts too. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast.error("Could not copy — select the text manually");
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export function RenameDialog({
  target, onClose, onRenamed,
}: {
  target: TreeNode;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [slug, setSlug] = useState(target.slug);
  const [busy, setBusy] = useState(false);
  const dirty = slug.trim() !== "" && slug.trim() !== target.slug;

  async function rename() {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await api.renamePage(target.pageId, target.id, slug.trim());
      toast.success(`Renamed to “${slug.trim()}”`);
      onClose();
      onRenamed();
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Rename failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename “{target.slug}”</DialogTitle>
          <DialogDescription>
            Changing the slug updates the page URL. The title stays as-is unless you edit it in the page header.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="rename-slug">Slug</Label>
          <Input
            id="rename-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void rename(); }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void rename()} disabled={!dirty || busy}>{busy ? "Renaming…" : "Rename"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

interface MoveOption {
  id: string | null;
  label: string;
  depth: number;
}

/** Flatten the space tree into move candidates, excluding `excludeId` and all
 *  of its descendants (a branch can't be moved under itself or its own subtree). */
function moveOptions(tree: TreeNode[], excludeId: string): MoveOption[] {
  const excluded = new Set<string>();
  const collectSubtree = (n: TreeNode) => {
    excluded.add(n.id);
    for (const c of n.children ?? []) collectSubtree(c);
  };
  const findAndCollect = (nodes: TreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === excludeId) { collectSubtree(n); return true; }
      if (findAndCollect(n.children ?? [])) return true;
    }
    return false;
  };
  findAndCollect(tree);

  const out: MoveOption[] = [{ id: null, label: "Top level", depth: 0 }];
  const flatten = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (excluded.has(n.id)) continue;
      out.push({ id: n.id, label: n.slug, depth });
      flatten(n.children ?? [], depth + 1);
    }
  };
  flatten(tree, 0);
  return out;
}

export function MoveDialog({
  target, tree, onClose, onMoved,
}: {
  target: TreeNode;
  tree: TreeNode[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const options = useMemo(() => moveOptions(tree, target.id), [tree, target.id]);
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move() {
    if (busy) return;
    setBusy(true);
    try {
      await api.moveBranch(target.id, parentId);
      toast.success("Moved");
      onClose();
      onMoved();
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move “{target.slug}”</DialogTitle>
          <DialogDescription>Choose a new parent. Its children move with it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>New parent</Label>
          <Select
            value={parentId ?? ""}
            onValueChange={(v) => setParentId(v === "" ? null : v)}
          >
            <SelectTrigger><SelectValue placeholder="Choose a parent" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Top level</SelectItem>
              {options.filter((o) => o.id !== null).map((o) => (
                <SelectItem key={o.id!} value={o.id!}>
                  <span style={{ paddingLeft: o.depth * 14 }}>{o.depth > 0 ? "↳ " : ""}{o.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void move()} disabled={busy}>{busy ? "Moving…" : "Move"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

const EXPIRATIONS: { value: string | null; label: string }[] = [
  { value: null, label: "Never expires" },
  { value: "1", label: "1 hour" },
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
];

export function ShareDialog({
  target, onClose,
}: {
  target: TreeNode;
  onClose: () => void;
}) {
  const [expiresKey, setExpiresKey] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const hours = expiresKey === "" ? null : expiresKey;
      const expiresAt = hours ? new Date(Date.now() + Number(hours) * 3600_000).toISOString() : null;
      const result = await api.createShareLink(target.id, { permission: "view", expiresAt });
      setUrl(`${window.location.origin}/share/${result.token}`);
      toast.success("Share link created");
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Could not create share link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share “{target.slug}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can open this page — even without an account.
          </DialogDescription>
        </DialogHeader>
        {url === null ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Expiration</Label>
              <Select value={expiresKey} onValueChange={setExpiresKey}>
                <SelectTrigger><SelectValue placeholder="Expiration" /></SelectTrigger>
                <SelectContent>
                  {EXPIRATIONS.map((e) => (
                    <SelectItem key={e.value ?? "never"} value={e.value ?? ""}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label>Share link</Label>
            <Input value={url} readOnly onFocus={(e) => e.target.select()} />
            <div className="flex gap-2">
              <CopyButton text={url} />
              <Button asChild variant="ghost">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open
                </a>
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{url ? "Done" : "Cancel"}</Button>
          {url === null && (
            <Button onClick={() => void create()} disabled={busy}>{busy ? "Creating…" : "Create link"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
