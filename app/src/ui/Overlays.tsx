import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { cancelOp, contextMenu, dialogs, dismissToast, ops, toasts, type DialogReq } from "./store";

export function Overlays() {
  return (
    <>
      <DialogHost />
      <ContextMenuHost />
      <ToastHost />
    </>
  );
}

function ToastHost() {
  const t = useT();
  const list = toasts.use((x) => x);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((x) => (
        <div key={x.id} className={`toast toast-${x.kind}`}>
          <div className="toast-head">
            <span className="toast-dot" aria-hidden />
            <span className="toast-title">{x.title}</span>
            <button className="icon-btn xs" aria-label={t("common.close")} onClick={() => dismissToast(x.id)}>
              <Icon name="close" size={13} />
            </button>
          </div>
          {x.detail && <div className="toast-detail">{x.detail}</div>}
          {x.error?.stderr && (
            <>
              <button className="link-btn" onClick={() => setOpen(open === x.id ? null : x.id)}>
                {open === x.id ? t("errors.hideOutput") : t("errors.showOutput")}
              </button>
              {open === x.id && (
                <pre className="toast-stderr">
                  {x.error.args ? `$ git ${x.error.args.join(" ")}\n` : ""}
                  {x.error.stderr}
                </pre>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function OpsBar() {
  const t = useT();
  const list = ops.use((o) => o);
  if (!list.length) return null;
  return (
    <div className="opsbar">
      {list.map((o) => (
        <div key={o.id} className="op">
          <span className="spinner" aria-hidden />
          <b>{o.label}</b>
          <span className="op-line">{o.line}</span>
          <button className="btn btn-sm" onClick={() => cancelOp(o.id)}>
            {t("ops.cancel")}
          </button>
        </div>
      ))}
    </div>
  );
}

function DialogHost() {
  const list = dialogs.use((d) => d);
  const top = list[list.length - 1];
  if (!top) return null;
  return <Dialog key={top.id} req={top} />;
}

function Dialog({ req }: { req: DialogReq }) {
  const t = useT();
  const [vals, setVals] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries((req.fields ?? []).map((f) => [f.name, f.value ?? (f.type === "checkbox" ? false : "")])),
  );
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current.focus();
      if (firstRef.current instanceof HTMLInputElement) firstRef.current.select();
    } else okRef.current?.focus();
  }, []);
  const invalid = (req.fields ?? []).some((f) => f.required && !String(vals[f.name] ?? "").trim());
  const submit = () => !invalid && req.resolve(vals);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && req.resolve(null)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onKeyDown={(e) => {
          if (e.key === "Escape") req.resolve(null);
          if (e.key === "Enter" && (e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">{req.title}</h2>
        </div>
        {req.message && <p className="modal-msg">{req.message}</p>}
        {req.detail && <pre className="modal-detail">{req.detail}</pre>}
        {(req.fields ?? []).map((f, i) => (
          <label key={f.name} className={f.type === "checkbox" ? "check-row" : "field"}>
            {f.type === "checkbox" ? (
              <>
                <input type="checkbox" checked={Boolean(vals[f.name])} onChange={(e) => setVals({ ...vals, [f.name]: e.target.checked })} />
                <span>{f.label}</span>
              </>
            ) : (
              <>
                <span className="field-label">{f.label}</span>
                {f.type === "textarea" ? (
                  <textarea
                    ref={i === 0 ? (el) => void (firstRef.current = el) : undefined}
                    rows={4}
                    value={String(vals[f.name] ?? "")}
                    placeholder={f.placeholder}
                    onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}
                  />
                ) : f.type === "select" ? (
                  <select value={String(vals[f.name] ?? "")} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    ref={i === 0 ? (el) => void (firstRef.current = el) : undefined}
                    value={String(vals[f.name] ?? "")}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}
                  />
                )}
              </>
            )}
          </label>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={() => req.resolve(null)}>
            {t("common.cancel")}
          </button>
          <button ref={okRef} className={req.danger ? "btn btn-danger" : "btn btn-primary"} disabled={invalid} onClick={submit}>
            {req.confirmLabel ?? t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextMenuHost() {
  const menu = contextMenu.use((m) => m);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)), y: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6)) });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => contextMenu.set(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
        if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
      }}
    >
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.heading ? "ctx-item heading" : it.danger ? "ctx-item danger" : "ctx-item"}
            disabled={it.disabled || it.heading}
            onClick={() => {
              contextMenu.set(null);
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
