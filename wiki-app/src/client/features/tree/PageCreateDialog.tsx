import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../../components/ui/select.js";
import { api, type SpaceSummary, type TreeNode } from "../../api/client.js";
import { cn } from "../../lib/utils.js";
import { AlertCircle, CheckCircle2 } from "lucide-react";

/** "My Cool Page" -> "my-cool-page"; apostrophes dropped, runs trimmed to single dashes. */
export function slugifyTitle(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!base || !taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function collectSlugs(tree: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const visit = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.add(n.slug);
      visit(n.children ?? []);
    }
  };
  visit(tree);
  return out;
}

interface PageCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: SpaceSummary[];
  spaceId: string;
  parentBranchId: string | null;
  parentLabel?: string | null;
  onCreated: (branchId: string) => void;
}

/**
 * UI overhaul B7: title-first page creation. The slug is auto-derived from the
 * title (kebab-case, deduped per space) but stays editable for power users who
 * want to pin a URL. Creating a child page from the tree prefills the parent.
 */
export function PageCreateDialog({
  open, onOpenChange, spaces, spaceId, parentBranchId, parentLabel, onCreated,
}: PageCreateDialogProps) {
  const [space, setSpace] = useState(spaceId);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [takenSlugs, setTakenSlugs] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  // When the dialog opens (or the target space changes), load the existing
  // slugs so the auto-generated one can be deduped and validity checked live.
  useEffect(() => {
    if (!open) return;
    setSpace(spaceId);
    setTitle("");
    setSlug("");
    setSlugTouched(false);
    api.getSpaceTree(spaceId).then((tree) => setTakenSlugs(collectSlugs(tree))).catch(() => setTakenSlugs(new Set()));
  }, [open, spaceId]);

  // Re-derive the slug from the title until the user edits it manually.
  useEffect(() => {
    if (slugTouched) return;
    setSlug(uniqueSlug(slugifyTitle(title), takenSlugs));
  }, [title, slugTouched, takenSlugs]);

  const taken = slug.trim().length > 0 && takenSlugs.has(slug);
  const invalid = slug.trim().length > 0 && !SLUG_RE.test(slug);
  const canSubmit = title.trim().length > 0 && slug.trim().length > 0 && !taken && !invalid && !creating;

  const parentLabelText = useMemo(
    () => (parentBranchId ? (parentLabel?.trim() ? parentLabel : "this page") : null),
    [parentBranchId, parentLabel]
  );

  async function submit() {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const res = await api.createPage({
        slug: slug.trim(),
        spaceId: space,
        parentBranchId,
        title: title.trim() || undefined,
      });
      toast.success(`Created “${title.trim() || slug.trim()}”`);
      onOpenChange(false);
      onCreated(res.branchId);
    } catch (err) {
      toast.error((err as any)?.body?.error ?? "Could not create page");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{parentBranchId ? "New subpage" : "New page"}</DialogTitle>
          <DialogDescription>
            {parentBranchId
              ? `Will be placed under “${parentLabelText}” in the current space.`
              : "Creates a new top-level page in the selected space."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="page-title">Title</Label>
            <Input
              id="page-title"
              autoFocus
              placeholder="Untitled"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="page-slug">Slug (URL)</Label>
            <div className="relative">
              <Input
                id="page-slug"
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                className={cn(taken || invalid ? "border-danger" : slugTouched ? "border-success" : "")}
                aria-invalid={taken || invalid}
              />
            </div>
            <div className="min-h-4 text-xs">
              {taken && (
                <span className="flex items-center gap-1 text-danger">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden /> That slug is already used in this space.
                </span>
              )}
              {!taken && invalid && (
                <span className="flex items-center gap-1 text-danger">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Lowercase letters, numbers, and single dashes only.
                </span>
              )}
              {!taken && !invalid && slugTouched && slug.length > 0 && (
                <span className="flex items-center gap-1 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Looks good.
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="page-space">Space</Label>
            <Select value={space} onValueChange={(v) => { setSpace(v); setSlugTouched(false); api.getSpaceTree(v).then((t) => setTakenSlugs(collectSlugs(t))).catch(() => {}); }}>
              <SelectTrigger id="page-space">
                <SelectValue placeholder="Select space" />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {creating ? "Creating…" : "Create page"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
