import { api, newOpId, toAppError } from "../api";
import type { AppError } from "../types";
import { t } from "../i18n";

export { createStore } from "./createStore";
import { createStore } from "./createStore";

// ------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  title: string;
  detail?: string;
  error?: AppError;
}

export const toasts = createStore<Toast[]>([]);
let toastSeq = 0;

export function toast(kind: Toast["kind"], title: string, detail?: string, error?: AppError) {
  const id = ++toastSeq;
  toasts.set((t) => [...t.slice(-4), { id, kind, title, detail, error }]);
  const ttl = kind === "error" ? 12000 : 3500;
  setTimeout(() => dismissToast(id), ttl);
}

export const dismissToast = (id: number) => toasts.set((t) => t.filter((x) => x.id !== id));

/** Thông báo lỗi theo ngôn ngữ hiện tại: dịch theo loại lỗi; loại chung (io, invalidInput) dùng chi tiết từ backend. */
export function errorMessage(err: AppError): string {
  if (err.kind === "wrongPasscode") {
    return err.waitSeconds ? t("lock.wait", { seconds: err.waitSeconds }) : t("errors.wrongPasscode");
  }
  const generic = new Set(["io", "invalidInput", "unknown", "notARepo"]);
  if (!generic.has(err.kind)) {
    const key = `errors.${err.kind}`;
    const s = t(key);
    if (s !== key) return s;
  }
  return err.message;
}

export function toastError(e: unknown, title?: string) {
  const err = toAppError(e);
  if (err.kind === "cancelled") return toast("info", t("errors.cancelled"));
  const msg = errorMessage(err);
  toast("error", title ?? msg, title ? msg : undefined, err);
}

// ------------------------------------------------------------ dialogs

export interface Field {
  name: string;
  label: string;
  type?: "text" | "textarea" | "checkbox" | "select";
  value?: string | boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}

export interface DialogReq {
  id: number;
  title: string;
  message?: string;
  detail?: string;
  fields?: Field[];
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: Record<string, string | boolean> | null) => void;
}

export const dialogs = createStore<DialogReq[]>([]);
let dialogSeq = 0;

export function openDialog(req: Omit<DialogReq, "id" | "resolve">): Promise<Record<string, string | boolean> | null> {
  return new Promise((resolve) => {
    const id = ++dialogSeq;
    dialogs.set((d) => [
      ...d,
      {
        ...req,
        id,
        resolve: (v) => {
          dialogs.set((x) => x.filter((r) => r.id !== id));
          resolve(v);
        },
      },
    ]);
  });
}

export async function confirmDialog(title: string, message: string, opts: { danger?: boolean; confirmLabel?: string; detail?: string } = {}) {
  return (await openDialog({ title, message, ...opts })) !== null;
}

export async function promptDialog(title: string, label: string, value = "", opts: { placeholder?: string; confirmLabel?: string; message?: string } = {}) {
  const r = await openDialog({
    title,
    message: opts.message,
    confirmLabel: opts.confirmLabel,
    fields: [{ name: "v", label, value, placeholder: opts.placeholder, required: true }],
  });
  return r ? String(r.v).trim() : null;
}

// ------------------------------------------------------------ context menu

export interface MenuItem {
  label?: string;
  heading?: boolean;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

export const contextMenu = createStore<{ x: number; y: number; items: MenuItem[] } | null>(null);

/** Mở menu ngay dưới một phần tử (nút ▾, nút "…"). */
export function showMenuBelow(el: Element, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  contextMenu.set({ x: r.left, y: r.bottom + 4, items });
}

export function showMenu(e: React.MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  contextMenu.set({ x: e.clientX, y: e.clientY, items });
}

// ------------------------------------------------------------ network operations

export interface RunningOp {
  id: string;
  repoId: string | null;
  label: string;
  line: string;
}

export const ops = createStore<RunningOp[]>([]);

export function updateOpLine(id: string, line: string) {
  ops.set((o) => (o.some((x) => x.id === id) ? o.map((x) => (x.id === id ? { ...x, line } : x)) : o));
}

/** Chạy một thao tác mạng có tiến trình + huỷ. */
export async function runNetOp<R>(repoId: string | null, label: string, fn: (opId: string) => Promise<R>): Promise<R | undefined> {
  const id = newOpId();
  ops.set((o) => [...o, { id, repoId, label, line: "" }]);
  try {
    return await fn(id);
  } catch (e) {
    toastError(e, t("errors.failed", { action: label }));
    return undefined;
  } finally {
    ops.set((o) => o.filter((x) => x.id !== id));
  }
}

export const cancelOp = (id: string) => api.opCancel(id);

// ------------------------------------------------------------ command palette

export const paletteOpen = createStore(false);
