import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useT } from "./i18n";
import { Icon } from "./ui/Icon";
import { toastError } from "./ui/store";

/** Hộp thoại khi bấm nút X của cửa sổ (chỉ hiện khi Cài đặt → Cửa sổ = "Luôn hỏi"). */
export function CloseDialog() {
  const tt = useT();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const info = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo, staleTime: Infinity });
  const trayOk = info.data?.trayAvailable !== false;

  useEffect(() => {
    const un = listen("app:close-requested", () => {
      setRemember(false);
      setOpen(true);
    });
    return () => void un.then((f) => f());
  }, []);

  if (!open) return null;
  const choose = async (action: "tray" | "quit") => {
    setOpen(false);
    try {
      await api.closeChoice(action, remember);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="modal-backdrop" style={{ zIndex: 88 }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-title" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
        <div className="modal-head">
          <h2 id="close-title" className="modal-title">
            {tt("close.title")}
          </h2>
          <button className="icon-btn" aria-label={tt("common.cancel")} onClick={() => setOpen(false)}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="modal-msg">{tt(trayOk ? "close.body" : "close.bodyNoTray")}</p>
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>
            {tt("close.remember")}
            <span className="dim small" style={{ display: "block" }}>
              {tt("close.rememberHint")}
            </span>
          </span>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={() => choose("quit")}>
            <Icon name="power" size={15} />
            {tt("close.quit")}
          </button>
          <button className="btn btn-primary" autoFocus onClick={() => choose("tray")}>
            <Icon name="minimize" size={15} />
            {tt(trayOk ? "close.tray" : "close.minimize")}
          </button>
        </div>
      </div>
    </div>
  );
}
