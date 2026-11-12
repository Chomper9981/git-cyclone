import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { fullTime, relTime, useT } from "../i18n";
import { createStore } from "../ui/createStore";
import { shortSha } from "../ui/format";
import { Icon } from "../ui/Icon";

/** Modal xem blame + lịch sử của một file. */
const inspector = createStore<{ repoId: string; path: string; rev: string | null } | null>(null);

export const openFileInspector = (repoId: string, path: string, rev: string | null = null) => inspector.set({ repoId, path, rev });

export function FileInspectorHost() {
  const cur = inspector.use((s) => s);
  if (!cur) return null;
  return <FileInspector key={cur.repoId + cur.path + cur.rev} {...cur} onClose={() => inspector.set(null)} />;
}

function FileInspector({ repoId, path, rev, onClose }: { repoId: string; path: string; rev: string | null; onClose: () => void }) {
  const tt = useT();
  const [tab, setTab] = useState<"blame" | "history">("blame");
  const [blameRev, setBlameRev] = useState<string | null>(rev);
  const blame = useQuery({ queryKey: ["blame", repoId, path, blameRev], queryFn: () => api.blame(repoId, path, blameRev), enabled: tab === "blame" });
  const hist = useQuery({ queryKey: ["fhist", repoId, path], queryFn: () => api.fileHistory(repoId, path), enabled: tab === "history" });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={path}>
        <div className="inspector-head">
          <Icon name="file" size={18} />
          <h2 className="modal-title mono ellipsis" style={{ fontSize: 13 }}>
            {path}
          </h2>
          <div className="seg sm" role="tablist">
            <button role="tab" aria-selected={tab === "blame"} className={tab === "blame" ? "on" : ""} onClick={() => setTab("blame")}>
              {tt("inspector.blame")}
            </button>
            <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
              {tt("inspector.history")}
            </button>
          </div>
          <button className="icon-btn" aria-label={tt("common.close")} onClick={onClose} autoFocus>
            <Icon name="close" size={16} />
          </button>
        </div>
        {blameRev && tab === "blame" && (
          <div className="small muted" style={{ padding: "6px 16px" }}>
            {tt("inspector.at", { sha: shortSha(blameRev) })} ·{" "}
            <button className="link-btn" onClick={() => setBlameRev(null)}>
              {tt("inspector.current")}
            </button>
          </div>
        )}
        <div className="inspector-body">
          {tab === "blame" &&
            (blame.isLoading ? (
              <div className="diff-empty">{tt("inspector.running")}</div>
            ) : blame.error ? (
              <div className="diff-empty">{String((blame.error as { message?: string }).message)}</div>
            ) : (
              <table className="blame">
                <tbody>
                  {blame.data?.map((l, i) => {
                    const first = i === 0 || blame.data![i - 1].sha !== l.sha;
                    return (
                      <tr key={i} className={first ? "bl first" : "bl"}>
                        <td className="bl-info" title={first ? `${l.summary}\n${l.author} · ${fullTime(l.time)}` : undefined}>
                          {first && (
                            <>
                              <span className="mono">{shortSha(l.sha)}</span> <span>{l.author}</span> <span className="dim">{relTime(l.time)}</span>
                            </>
                          )}
                        </td>
                        <td className="dl-no">{l.lineNo}</td>
                        <td className="dl-text">{l.text || " "}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}
          {tab === "history" &&
            (hist.isLoading ? (
              <div className="diff-empty">{tt("common.loading")}</div>
            ) : (
              <div className="col">
                {hist.data?.map((c) => (
                  <button
                    key={c.sha}
                    className="hist-row"
                    onClick={() => {
                      setBlameRev(c.sha);
                      setTab("blame");
                    }}
                    title={tt("inspector.blameHere")}
                  >
                    <span className="mono dim">{shortSha(c.sha)}</span>
                    <span className="ellipsis">{c.subject}</span>
                    <span className="muted ellipsis">{c.authorName}</span>
                    <span className="dim">{relTime(c.time)}</span>
                  </button>
                ))}
                {hist.data?.length === 0 && <div className="diff-empty">{tt("inspector.noHistory")}</div>}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
