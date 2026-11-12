import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";
import type { FileDiff, Hunk, HunkSelection } from "../types";
import { basename, dirname, joinPath } from "../ui/format";
import { Icon } from "../ui/Icon";
import { openFileInspector } from "./FileInspector";

const RENDER_LIMIT = 4000;

interface Props {
  diff: FileDiff | undefined;
  loading?: boolean;
  /** Cho phép chọn dòng (+/-) để thao tác. */
  selectable?: boolean;
  hunkActions?: (hunkIndex: number, hunk: Hunk) => React.ReactNode;
  /** Nút trên thanh chọn dòng (sau nút "Bỏ chọn"). */
  selectionActions?: (sel: HunkSelection[], clear: () => void) => React.ReactNode;
  emptyText?: string;
  /** Có repoId → hiện nút Blame; có thêm repoPath → nút mở trong VS Code. */
  repoId?: string;
  repoPath?: string;
  /** Phím S / U khi diff đang focus. `sel` rỗng = cả file. */
  onStageKey?: (sel: HunkSelection[], clear: () => void) => void;
  onUnstageKey?: (sel: HunkSelection[], clear: () => void) => void;
  /** Nút thêm ở cuối thanh tiêu đề (phóng to, đóng khung đè). */
  headerExtra?: React.ReactNode;
}

type Sel = Map<number, Set<number>>;

const isChange = (k: string) => k === "+" || k === "-";

export function DiffView({ diff, loading, selectable, hunkActions, selectionActions, emptyText, repoId, repoPath, onStageKey, onUnstageKey, headerExtra }: Props) {
  const t = useT();
  const [sel, setSel] = useState<Sel>(new Map());
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null);
  const [showAll, setShowAll] = useState(false);

  // reset lựa chọn khi diff đổi
  const sig = diff ? diff.path + diff.hunks.map((h) => h.header).join("|") : "";
  useEffect(() => {
    setSel(new Map());
    setAnchor(null);
    setShowAll(false);
  }, [sig]);

  const selections: HunkSelection[] = useMemo(() => {
    if (!diff) return [];
    return [...sel.entries()]
      .filter(([h, s]) => s.size > 0 && diff.hunks[h])
      .map(([h, s]) => ({ hunk: h, header: diff.hunks[h].header, lines: [...s].sort((a, b) => a - b) }));
  }, [sel, diff]);
  const selCount = selections.reduce((n, s) => n + s.lines.length, 0);

  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const h of diff?.hunks ?? [])
      for (const l of h.lines) {
        if (l.kind === "+") add++;
        else if (l.kind === "-") del++;
      }
    return { add, del };
  }, [diff]);

  if (loading && !diff)
    return (
      <div className="diff">
        {headerExtra && (
          <div className="diff-head">
            <span className="spacer" />
            {headerExtra}
          </div>
        )}
        <div className="diff-empty">{t("diff.loading")}</div>
      </div>
    );
  if (!diff)
    return (
      <div className="diff">
        {headerExtra && (
          <div className="diff-head">
            <span className="spacer" />
            {headerExtra}
          </div>
        )}
        <div className="diff-empty">{emptyText ?? t("diff.choose")}</div>
      </div>
    );

  const clear = () => {
    setSel(new Map());
    setAnchor(null);
  };
  const canSelect = !!selectable && (diff.status === "M" || diff.status === "R");
  const noHistory = diff.status === "A" || diff.status === "?" || diff.status === "N";
  const dir = dirname(diff.path);

  const header = (
    <div className="diff-head">
      <span className={`st st-${diff.status === "?" ? "N" : diff.status}`}>{diff.status === "?" ? "N" : diff.status}</span>
      <span className="diff-path" title={diff.oldPath && diff.oldPath !== diff.path ? `${diff.oldPath} → ${diff.path}` : diff.path}>
        {diff.oldPath && diff.oldPath !== diff.path && <span className="dim">{diff.oldPath} → </span>}
        {dir && <span className="dim">{dir}/</span>}
        {basename(diff.path)}
      </span>
      {(stats.add > 0 || stats.del > 0) && (
        <span className="row" style={{ gap: 6 }}>
          {stats.add > 0 && <span className="num-add">+{stats.add}</span>}
          {stats.del > 0 && <span className="num-del">−{stats.del}</span>}
        </span>
      )}
      <span className="spacer" />
      {diff.hunks.length > 0 && !diff.binary && !diff.tooLarge && (
        <div className="seg sm" role="group" aria-label={t("diff.mode")}>
          <button type="button" className="on" aria-pressed="true">
            {t("diff.unified")}
          </button>
        </div>
      )}
      {repoId && (
        <button
          type="button"
          className="icon-btn sm"
          title={t("changes.blame")}
          aria-label={t("changes.blame")}
          disabled={noHistory}
          onClick={() => openFileInspector(repoId, diff.path)}
        >
          <Icon name="history" />
        </button>
      )}
      {repoPath && (
        <button
          type="button"
          className="icon-btn sm"
          title={t("conflict.openVscode")}
          aria-label={t("conflict.openVscode")}
          disabled={diff.status === "D"}
          onClick={() => api.revealPath(joinPath(repoPath, diff.path), "vscode").catch(() => {})}
        >
          <Icon name="code" />
        </button>
      )}
      {headerExtra}
    </div>
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "s" && onStageKey) {
      e.preventDefault();
      onStageKey(canSelect ? selections : [], clear);
    } else if (k === "u" && onUnstageKey) {
      e.preventDefault();
      onUnstageKey(canSelect ? selections : [], clear);
    } else if (e.key === "Escape" && selCount > 0) {
      e.preventDefault();
      clear();
    }
  };

  const foot = (hint: boolean) =>
    (hint || onStageKey || onUnstageKey) && (
      <div className="diff-foot">
        {hint && <span>{t("changes.hint")}</span>}
        <span className="spacer" />
        {(onStageKey || onUnstageKey) && (
          <span className="row" style={{ gap: 6 }}>
            {onStageKey && (
              <>
                <kbd>S</kbd> {t("changes.stage")}
              </>
            )}
            {onUnstageKey && (
              <>
                <kbd>U</kbd> {t("changes.unstage")}
              </>
            )}
          </span>
        )}
      </div>
    );

  const message = (text: string) => (
    <div className="diff" onKeyDown={onKeyDown}>
      {header}
      <div className="diff-body" tabIndex={0}>
        <div className="diff-empty">{text}</div>
      </div>
      {foot(false)}
    </div>
  );

  if (diff.binary) return message(t("diff.binary"));
  if (diff.tooLarge) return message(t("diff.tooLarge"));
  if (diff.hunks.length === 0) return message(t("diff.noContent"));

  const toggle = (h: number, l: number, shift: boolean) => {
    const next: Sel = new Map([...sel].map(([k, v]) => [k, new Set(v)]));
    const set = next.get(h) ?? new Set<number>();
    const lines = diff.hunks[h].lines;
    if (shift && anchor && anchor.h === h) {
      const [a, b] = [Math.min(anchor.l, l), Math.max(anchor.l, l)];
      const on = !set.has(l);
      for (let i = a; i <= b; i++) if (isChange(lines[i].kind)) on ? set.add(i) : set.delete(i);
    } else {
      set.has(l) ? set.delete(l) : set.add(l);
      setAnchor({ h, l });
    }
    next.set(h, set);
    setSel(next);
  };

  let budget = showAll ? Infinity : RENDER_LIMIT;
  let truncated = false;

  return (
    <div className="diff" onKeyDown={onKeyDown}>
      {header}
      {canSelect && selCount > 0 && selectionActions && (
        <div className="selbar" role="status">
          <span>{t("changes.selected", { count: selCount })}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
            {t("changes.clearSelection")}
          </button>
          {selectionActions(selections, clear)}
        </div>
      )}
      <div className="diff-body" tabIndex={0}>
        {diff.hunks.map((h, hi) => {
          if (budget <= 0) {
            truncated = true;
            return null;
          }
          const lines = h.lines.slice(0, budget);
          budget -= lines.length;
          if (lines.length < h.lines.length) truncated = true;
          return (
            <div key={hi} className="hunk">
              <div className="hunk-head">
                <code title={h.header}>{h.header}</code>
                {hunkActions?.(hi, h)}
              </div>
              <table className="dtable">
                <tbody>
                  {lines.map((l, li) => {
                    const change = isChange(l.kind);
                    const pickable = canSelect && change;
                    const picked = !!sel.get(hi)?.has(li);
                    let cls = l.kind === "+" ? "dl add" : l.kind === "-" ? "dl del" : l.kind === "\\" ? "dl meta" : "dl";
                    if (pickable) cls += " selectable-line";
                    if (picked) cls += " picked";
                    return (
                      <tr key={li} className={cls} onClick={pickable ? (e) => toggle(hi, li, e.shiftKey) : undefined}>
                        {canSelect && (
                          <td className="dl-check">
                            {change && (
                              <span
                                className={picked ? "box on" : "box"}
                                role="checkbox"
                                aria-checked={picked}
                                aria-label={t("diff.selectLine", { n: l.newNo ?? l.oldNo ?? li + 1 })}
                              >
                                {picked && <Icon name="check" size={10} stroke={3.2} />}
                              </span>
                            )}
                          </td>
                        )}
                        <td className="dl-no">{l.oldNo ?? ""}</td>
                        <td className="dl-no">{l.newNo ?? ""}</td>
                        <td className="dl-sign">{l.kind === "\\" ? "" : l.kind === "-" ? "−" : l.kind}</td>
                        <td className="dl-text">{l.kind === "\\" ? t("diff.noEol") : l.text || " "}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
        {truncated && (
          <div className="diff-more">
            <button type="button" className="btn btn-sm" onClick={() => setShowAll(true)}>
              {t("diff.showAll")}
            </button>
          </div>
        )}
      </div>
      {foot(canSelect)}
    </div>
  );
}
