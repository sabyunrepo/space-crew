import { useEffect } from "react";
import { X } from "lucide-react";

export type ToastItem = {
  id: number;
  kind: "error" | "notice";
  message: string;
  action?: { label: string; onClick(): void };
};

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss(id: number): void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 1000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
    <span>{toast.message}</span>
    {toast.action && <button type="button" onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}>{toast.action.label}</button>}
    <button type="button" className="toast-dismiss" aria-label="알림 닫기" onClick={() => onDismiss(toast.id)}><X size={14} /></button>
  </div>;
}

export function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss(id: number): void }) {
  return <div className="toast-viewport" aria-label="알림" aria-live="polite">
    {toasts.map(toast => <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />)}
  </div>;
}
