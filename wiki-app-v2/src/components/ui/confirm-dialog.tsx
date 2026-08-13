import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Themed, accessible confirm dialog replacing native `confirm()` (§7.1 polish).
 * Built on the native <dialog> element so it gets the platform's modal semantics
 * for free: ::backdrop, focus trap, Esc-to-close, and inert-when-closed. No
 * new Radix dependency — the brief's modal-style actions all stay in-app.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, pending = false, onConfirm, onCancel } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Defer focus so the dialog has painted; safe for tests too.
      requestAnimationFrame(() => cancelRef.current?.focus());
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // Native <dialog> fires a "cancel" event when the user hits Escape. We map
  // that to onCancel so callers don't have to think about the difference.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    el.addEventListener("cancel", handler);
    return () => el.removeEventListener("cancel", handler);
  }, [onCancel]);

  // Click on the backdrop (outside the inner box) closes the dialog.
  // Native <dialog> clicks anywhere inside register a click on the dialog
  // itself; we discriminate by checking the bounding rect of the inner box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      if (e.target === el) {
        const rect = el.getBoundingClientRect();
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        if (!inside) onCancel();
      }
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [onCancel]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      className={cn(
        "max-w-md rounded-lg border border-border bg-surface-elevated p-6 text-foreground shadow-lg",
        "backdrop:bg-scrim backdrop:backdrop-blur-sm",
      )}
    >
      <h2 id="confirm-dialog-title" className="text-base font-semibold">{title}</h2>
      {description && <div className="mt-2 text-sm text-text-secondary">{description}</div>}
      <div className="mt-6 flex justify-end gap-2">
        <Button ref={cancelRef} size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          size="sm"
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={pending}
          data-confirm-action
        >
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </dialog>,
    document.body,
  );
}
