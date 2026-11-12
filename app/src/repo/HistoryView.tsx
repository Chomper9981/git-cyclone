import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fullTime, relTime, t, useT } from "../i18n";
import type { Commit, Edge, GraphRow, RefLabel, RepoStatus } from "../types";
import { basename, copyText, dirname, shortSha } from "../ui/format";
import { Avatar, Icon, octPoints } from "../ui/Icon";
import { Split } from "../ui/Split";
import { showMenu, showMenuBelow, toast, type MenuItem } from "../ui/store";
import type { RepoActions } from "./actions";
import { ChangesPanel, partition, WorktreeDiff, type WtSel } from "./ChangesView";
import { DiffView } from "./DiffView";
import { openFileInspector } from "./FileInspector";
import { qk, useGraph, useRefs } from "./hooks";

const ROW = 30;
const LANE = 18;
const X0 = 16;
const MAX_GRAPH_W = 300;
const PAGE = 1500;
const PALETTE = 10;
/** Id của dòng "Changes" (thay đổi chưa commit) ở đỉnh graph. */
const WIP = "wip";

export interface HistoryHandle {
  jumpTo: (sha: string) => void;
  showChanges: () => void;
  showHead: () => void;
}

interface Props {
  repoId: string;
  repoPath: string;
  status: RepoStatus | undefined;
  actions: RepoActions;
}

/** File đang mở trong khung diff đè lên graph. */
type OpenFile = { kind: "wt"; sel: WtSel } | { kind: "commit"; sha: string; path: string; origPath: string | null } | null;

export const HistoryView = forwardRef<HistoryHandle, Props>(function HistoryView({ repoId, repoPath, status, actions }, ref) {
  const tt = useT();
  const [limit, setLimit] = useState(PAGE);
  const { data: graph, isFetching, error } = useGraph(repoId, limit);
  const { data: refs } = useRefs(repoId);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile>(null);
  const [maximized, setMaximized] = useState(false);
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingJump = useRef<string | null>(null);

  const rows = graph?.rows ?? [];
  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? rows.filter(
            (r) =>
              r.commit.subject.toLowerCase().includes(q) ||
              r.commit.sha.startsWith(q) ||
              r.commit.authorName.toLowerCase().includes(q) ||
              r.commit.refs.some((x) => x.name.toLowerCase().includes(q)),
          )
        : rows,
    [rows, q],
  );
  const filtered = q.length > 0;
  const headSha = status?.oid ?? null;
  const counts = useMemo(() => partition(status?.entries ?? []), [status]);
  const dirty = status?.entries.length ?? 0;

  const select = (id: string) => {
    setSelected(id);
    setOpen(null);
  };

  // lúc mở repo: có thay đổi → chọn dòng Changes để commit được ngay; không thì chọn HEAD
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !status) return;
    inited.current = true;
    setSelected(status.entries.length || !status.oid ? WIP : status.oid);
  }, [status]);

  // commit xong hết thay đổi → chuyển sang commit vừa tạo; xuất hiện conflict → về dòng Changes
  const prevDirty = useRef(0);
  const prevConf = useRef(0);
  useEffect(() => {
    if (selected === WIP && prevDirty.current > 0 && dirty === 0 && headSha) select(headSha);
    if (counts.conflicts.length > prevConf.current) select(WIP);
    prevDirty.current = dirty;
    prevConf.current = counts.conflicts.length;
  }, [dirty, counts.conflicts.length, headSha]);

  // hàng 0 luôn là dòng Changes
  const v = useVirtualizer({ count: visible.length + 1, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 20 });
  const items = v.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (!filtered && graph?.hasMore && last && last.index > visible.length - 60 && !isFetching) setLimit((l) => l + PAGE);
  }, [last?.index, graph?.hasMore, isFetching, visible.length, filtered]);

  const jumpTo = (sha: string) => {
    const i = visible.findIndex((r) => r.commit.sha === sha);
    if (i >= 0) {
      select(sha);
      v.scrollToIndex(i + 1, { align: "center" });
    } else if (graph?.hasMore) {
      pendingJump.current = sha;
      setLimit((l) => l + PAGE * 4);
    } else toast("info", t("history.notLoaded"));
  };
  const showChanges = () => {
    select(WIP);
    v.scrollToIndex(0);
  };
  useImperativeHandle(ref, () => ({ jumpTo, showChanges, showHead: () => (headSha ? jumpTo(headSha) : showChanges()) }));
  useEffect(() => {
    if (pendingJump.current && rows.some((r) => r.commit.sha === pendingJump.current)) {
      const s = pendingJump.current;
      pendingJump.current = null;
      jumpTo(s);
    }
  }, [rows]);

  // Vị trí node Changes: cùng lane với HEAD; nối nét đứt xuống HEAD nếu lane đó trống ở các hàng phía trên.
  const wip = useMemo(() => {
    const headIdx = headSha ? rows.findIndex((r) => r.commit.sha === headSha) : -1;
    if (headIdx < 0) return { lane: 0, headIdx: -1, connect: false };
    const lane = rows[headIdx].lane;
    let connect = true;
    for (let i = 0; i < headIdx && connect; i++) {
      const r = rows[i];
      if (r.lane === lane) connect = false;
      else if (r.edges.some((e) => e.from === lane || (e.to === lane && i + 1 < headIdx))) connect = false;
    }
    return { lane, headIdx, connect };
  }, [rows, headSha]);

  const graphW = Math.min(MAX_GRAPH_W, X0 * 2 + Math.max(0, (graph?.maxLanes ?? 1) - 1) * LANE + 8);
  const branchCount = refs?.branches.filter((b) => !b.remote).length ?? 0;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const ids = [WIP, ...visible.map((r) => r.commit.sha)];
    const i = ids.indexOf(selected ?? "");
    const n = Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    select(ids[n]);
    v.scrollToIndex(n);
  };

  // Esc đóng khung diff (khi không có hộp thoại / menu nào đang mở)
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (listRef.current?.offsetParent === null) return; // tab repo đang ẩn
      if (document.querySelector(".modal-backdrop, .ctx-menu")) return;
      setOpen(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  const commitMenuItems = (c: Commit): MenuItem[] => {
    const isHead = c.sha === headSha;
    const cur = status?.branch ?? null;
    return [
      { label: t("history.menu.checkout"), onClick: () => actions.checkoutCommit(c) },
      { label: t("history.menu.branch"), onClick: () => actions.createBranch(c.sha) },
      { label: t("history.menu.tag"), onClick: () => actions.createTag(c) },
      { separator: true },
      { label: t("history.menu.cherry"), disabled: isHead, onClick: () => actions.cherryPick(c) },
      { label: t("history.menu.revert"), onClick: () => actions.revert(c) },
      { label: t("history.menu.reset", { branch: cur ?? "HEAD" }), danger: true, disabled: isHead, onClick: () => actions.reset(c, cur) },
      ...(isHead && c.parents.length > 0 ? [{ label: t("history.menu.undo"), onClick: () => actions.undoLastCommit() }] : []),
      { separator: true },
      { label: t("history.menu.copySha"), hint: shortSha(c.sha), onClick: () => copyText(c.sha) },
      { label: t("history.menu.copySubject"), onClick: () => copyText(c.subject) },
    ];
  };

  const selectedRow = selected && selected !== WIP ? rows.find((r) => r.commit.sha === selected) : undefined;

  const overlayButtons = (
    <>
      <button
        type="button"
        className={maximized ? "icon-btn sm on" : "icon-btn sm"}
        title={maximized ? tt("overlay.restore") : tt("overlay.maximize")}
        aria-label={maximized ? tt("overlay.restore") : tt("overlay.maximize")}
        aria-pressed={maximized}
        onClick={() => setMaximized(!maximized)}
      >
        <Icon name="window" />
      </button>
      <button type="button" className="icon-btn sm" title={`${tt("common.close")} (Esc)`} aria-label={tt("common.close")} onClick={() => setOpen(null)}>
        <Icon name="close" />
      </button>
    </>
  );

  const list = (
    <div ref={listRef} className="history" style={{ ["--gw" as string]: `${graphW}px` }}>
      <div className="history-bar">
        <label className="search-box" style={{ flex: "0 1 340px" }}>
          <span className="sr-only">{tt("history.searchLabel")}</span>
          <Icon name="search" size={14} />
          <input placeholder={tt("history.search")} value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} />
        </label>
        <span className="spacer" />
        <span className="small dim">
          {filtered ? `${visible.length} / ` : ""}
          {tt("history.count", { count: rows.length })}
          {graph?.hasMore ? "+" : ""} · {tt("history.branches", { count: branchCount })}
          {isFetching && ` · ${tt("history.loading")}`}
        </span>
      </div>
      <div className="cols" aria-hidden>
        <span style={{ paddingLeft: 14 }}>{tt("history.cols.graph")}</span>
        <span>{tt("history.cols.desc")}</span>
        <span>{tt("history.cols.time")}</span>
        <span>{tt("history.cols.sha")}</span>
      </div>
      {error ? (
        <div className="diff-empty">{tt("history.readError", { message: String((error as { message?: string }).message ?? error) })}</div>
      ) : (
        <div ref={scrollRef} className="graph-scroll" tabIndex={0} onKeyDown={onKey} role="listbox" aria-label={tt("history.list")}>
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {items.map((it) => {
              if (it.index === 0)
                return (
                  <div
                    key={WIP}
                    className={`g-row wip${selected === WIP ? " selected" : ""}${dirty ? "" : " clean"}`}
                    style={{ transform: `translateY(${it.start}px)` }}
                    role="option"
                    aria-selected={selected === WIP}
                    onClick={() => select(WIP)}
                  >
                    <div className="g-graph">{!filtered && <WipCell lane={wip.lane} connect={wip.connect} width={graphW} />}</div>
                    <div className="g-subject">
                      <span className="g-msg">{dirty ? tt("history.wipTitle") : tt("history.wipClean")}</span>
                      {counts.conflicts.length > 0 && <span className="pill pill-danger">{tt("dash.conflicts", { count: counts.conflicts.length })}</span>}
                      {counts.staged.length > 0 && <span className="pill pill-ok">{tt("dash.staged", { count: counts.staged.length })}</span>}
                      {counts.unstaged.length > 0 && <span className="pill pill-warn">{tt("history.wipFiles", { count: counts.unstaged.length })}</span>}
                    </div>
                    <span className="g-time" />
                    <span className="g-sha" />
                  </div>
                );
              const idx = it.index - 1;
              const row = visible[idx];
              const prev = filtered ? undefined : visible[idx - 1];
              const c = row.commit;
              const isHead = c.sha === headSha;
              // nét đứt từ node Changes chạy qua các hàng phía trên HEAD
              const wipPass = !filtered && wip.connect && idx <= wip.headIdx ? (idx === wip.headIdx ? "end" : "through") : undefined;
              return (
                <div
                  key={c.sha}
                  className={`g-row${c.sha === selected ? " selected" : ""}${isHead ? " head" : ""}`}
                  style={{ transform: `translateY(${it.start}px)` }}
                  role="option"
                  aria-selected={c.sha === selected}
                  onClick={() => select(c.sha)}
                  onContextMenu={(e) => showMenu(e, commitMenuItems(c))}
                  title={`${c.authorName} · ${fullTime(c.time)}`}
                >
                  <div className="g-graph">
                    {filtered ? null : <GraphCell row={row} prevEdges={prev?.edges} isHead={isHead} width={graphW} wipLane={wipPass ? wip.lane : undefined} wipPass={wipPass} />}
                  </div>
                  <div className="g-subject">
                    {c.refs.map((r) => (
                      <RefBadge key={r.kind + r.name} r={r} />
                    ))}
                    <span className="g-msg">{c.subject}</span>
                  </div>
                  <span className="g-time">{relTime(c.time)}</span>
                  <span className="g-sha">{shortSha(c.sha)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {open && (
        <DiffOverlay anchor={listRef} maximized={maximized}>
          {open.kind === "wt" ? (
            <WorktreeDiff repoId={repoId} repoPath={repoPath} status={status} actions={actions} sel={open.sel} headerExtra={overlayButtons} />
          ) : (
            <CommitFileDiff repoId={repoId} sha={open.sha} path={open.path} origPath={open.origPath} headerExtra={overlayButtons} />
          )}
        </DiffOverlay>
      )}
    </div>
  );

  const initialList = Math.max(360, window.innerWidth - 252 - 440);
  return (
    <Split id="history-v3" dir="row" initial={initialList} min={320}>
      {list}
      {selected === WIP ? (
        <ChangesPanel
          repoId={repoId}
          repoPath={repoPath}
          status={status}
          actions={actions}
          sel={open?.kind === "wt" ? open.sel : null}
          onSel={(s) => setOpen(s ? { kind: "wt", sel: s } : null)}
        />
      ) : (
        <CommitPanel
          repoId={repoId}
          row={selectedRow}
          sha={selected}
          isHead={!!selected && selected === headSha}
          onJump={jumpTo}
          actions={actions}
          menu={commitMenuItems}
          openPath={open?.kind === "commit" && open.sha === selected ? open.path : null}
          onOpenFile={(path, origPath) => selected && setOpen({ kind: "commit", sha: selected, path, origPath })}
        />
      )}
    </Split>
  );
});

/**
 * Khung diff đè lên danh sách graph (không đè panel phải). Khi phóng to, phủ luôn sidebar.
 * Dùng position: fixed theo toạ độ đo được vì các vùng chia (Split) cắt overflow.
 */
function DiffOverlay({ anchor, maximized, children }: { anchor: React.RefObject<HTMLDivElement | null>; maximized: boolean; children: React.ReactNode }) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const body = el.closest(".repo-body") ?? el;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const left = maximized ? body.getBoundingClientRect().left : r.left;
      setRect({ left, top: r.top, width: r.right - left, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor, maximized]);
  if (!rect || rect.width <= 0) return null;
  return (
    <div className="diff-overlay" style={rect} role="region">
      {children}
    </div>
  );
}

function CommitFileDiff({ repoId, sha, path, origPath, headerExtra }: { repoId: string; sha: string; path: string; origPath: string | null; headerExtra: React.ReactNode }) {
  const { data: diff, isLoading } = useQuery({
    queryKey: qk.cdiff(repoId, sha, path),
    queryFn: () => api.commitFileDiff(repoId, sha, path, origPath),
  });
  return <DiffView diff={diff} loading={isLoading} repoId={repoId} headerExtra={headerExtra} />;
}

function RefBadge({ r }: { r: RefLabel }) {
  if (r.kind === "head") return null;
  const cls = r.kind === "branch" ? (r.current ? "ref-current" : "ref-branch") : r.kind === "remote" ? "ref-remote" : "ref-tag";
  const icon = r.kind === "tag" ? "tag" : r.kind === "remote" ? "cloud" : "branch";
  return (
    <span className={`ref-badge chamfer ${cls}`} title={r.name}>
      <Icon name={icon} size={11} stroke={2.2} />
      {r.name}
    </span>
  );
}

const laneX = (l: number) => X0 + l * LANE;

/** Đoạn nối giữa 2 hàng: thẳng, hoặc chéo 45° (rẽ nhánh: chéo ngay dưới node; hội tụ: chéo ngay trên node). */
function edgePath(e: Edge, y0: number, y1: number) {
  const x0 = laneX(e.from);
  const x1 = laneX(e.to);
  if (x0 === x1) return `M${x0} ${y0}V${y1}`;
  const dy = Math.min(Math.abs(x1 - x0), y1 - y0);
  if (x1 > x0) return `M${x0} ${y0}L${x1} ${y0 + dy}V${y1}`;
  return `M${x0} ${y0}V${y1 - dy}L${x1} ${y1}`;
}

/** Node của dòng Changes: vòng nét đứt, nối nét đứt xuống HEAD. */
function WipCell({ lane, connect, width }: { lane: number; connect: boolean; width: number }) {
  const mid = ROW / 2;
  const x = laneX(lane);
  return (
    <svg width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} aria-hidden>
      {connect && <path d={`M${x} ${mid + 5}V${ROW}`} className="wip-line" />}
      <circle cx={x} cy={mid} r={5} className="wip-node" />
    </svg>
  );
}

function GraphCell({
  row,
  prevEdges,
  isHead,
  width,
  wipLane,
  wipPass,
}: {
  row: GraphRow;
  prevEdges?: Edge[];
  isHead: boolean;
  width: number;
  wipLane?: number;
  wipPass?: "through" | "end";
}) {
  const mid = ROW / 2;
  const x = laneX(row.lane);
  const merge = row.commit.parents.length > 1;
  const col = `c${row.color % PALETTE}`;
  return (
    <svg width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} aria-hidden>
      {wipLane !== undefined && <path d={`M${laneX(wipLane)} 0V${wipPass === "end" ? mid : ROW}`} className="wip-line" />}
      {prevEdges?.map((e, i) => <path key={`p${i}`} d={edgePath(e, mid - ROW, mid)} className={`lane c${e.color % PALETTE}`} />)}
      {row.edges.map((e, i) => (
        <path key={`n${i}`} d={edgePath(e, mid, mid + ROW)} className={`lane c${e.color % PALETTE}`} />
      ))}
      {isHead ? (
        <>
          <polygon points={octPoints(x, mid, 8.2)} className="node-head" />
          <circle cx={x} cy={mid} r={2.8} fill="#fff" />
        </>
      ) : merge ? (
        <circle cx={x} cy={mid} r={5} className={`node node-merge ${col}`} />
      ) : (
        <circle cx={x} cy={mid} r={4.3} className={`node ${col}`} />
      )}
    </svg>
  );
}

function CommitPanel({
  repoId,
  sha,
  row,
  isHead,
  onJump,
  actions,
  menu,
  openPath,
  onOpenFile,
}: {
  repoId: string;
  sha: string | null;
  row: GraphRow | undefined;
  isHead: boolean;
  onJump: (sha: string) => void;
  actions: RepoActions;
  menu: (c: Commit) => MenuItem[];
  openPath: string | null;
  onOpenFile: (path: string, origPath: string | null) => void;
}) {
  const tt = useT();
  const { data: c, isLoading } = useQuery({ queryKey: qk.commit(repoId, sha ?? ""), queryFn: () => api.commitDetail(repoId, sha!), enabled: !!sha });

  if (!sha)
    return (
      <div className="inspector">
        <div className="diff-empty">{tt("history.selectHint")}</div>
      </div>
    );
  if (isLoading || !c)
    return (
      <div className="inspector">
        <div className="diff-empty">{tt("common.loading")}</div>
      </div>
    );

  const [subject, ...body] = c.message.split("\n");
  const bodyText = body.join("\n").trim();
  const commit = row?.commit;

  const moveFile = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = c.files.findIndex((x) => x.path === openPath);
    const n = Math.max(0, Math.min(c.files.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    const f = c.files[n];
    if (f) onOpenFile(f.path, f.origPath);
  };

  return (
    <aside className="inspector" aria-label={tt("history.detail")}>
      <div className="ins-head">
        <div className="row">
          {isHead && <span className="ref-badge chamfer ref-head">HEAD</span>}
          <button className="sha-btn" title={tt("history.copySha")} onClick={() => copyText(c.sha).then(() => toast("info", t("history.copiedSha")))}>
            {shortSha(c.sha)}
            <Icon name="copy" size={12} />
          </button>
          <span className="spacer" />
          {commit && (
            <button className="icon-btn sm" aria-label={tt("common.more")} title={tt("common.more")} onClick={(e) => showMenuBelow(e.currentTarget, menu(commit))}>
              <Icon name="dots" size={16} />
            </button>
          )}
        </div>
        <h2>{subject}</h2>
        {bodyText && <pre className="ins-body">{bodyText}</pre>}
        <div className="row wrap small" style={{ gap: 8 }}>
          <Avatar login={c.authorName || "?"} size={22} />
          <b title={c.authorEmail}>{c.authorName}</b>
          <span className="dim" title={fullTime(c.authorTime)}>
            · {relTime(c.authorTime)}
          </span>
          <span className="dim">· {c.parents.length === 0 ? tt("history.rootCommit") : tt("history.parent")}</span>
          {c.parents.map((p) => (
            <button key={p} className="link-btn mono small" onClick={() => onJump(p)}>
              {shortSha(p)}
            </button>
          ))}
        </div>
        {commit && (
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => actions.createBranch(commit.sha)}>
              <Icon name="branch" size={14} />
              {tt("history.actions.branch")}
            </button>
            <button className="btn btn-sm" onClick={() => actions.createTag(commit)}>
              <Icon name="tag" size={14} />
              {tt("history.actions.tag")}
            </button>
            {!isHead && (
              <button className="btn btn-sm" onClick={() => actions.cherryPick(commit)}>
                <Icon name="cherry" size={14} />
                {tt("history.actions.cherry")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="ins-files grow" onKeyDown={moveFile}>
        <div className="row" style={{ padding: "0 10px 6px" }}>
          <h3 className="label-caps" style={{ flex: 1 }}>
            {tt("history.files", { count: c.files.length })}
          </h3>
          <span className="small dim">{tt("history.clickFile")}</span>
        </div>
        {c.files.length === 0 && <div className="fl-empty">{tt("history.noFiles")}</div>}
        {c.files.map((x) => (
          <button
            key={x.path}
            className={x.path === openPath ? "file-row selected" : "file-row"}
            aria-pressed={x.path === openPath}
            onClick={() => onOpenFile(x.path, x.origPath)}
            onContextMenu={(e) =>
              showMenu(e, [
                { label: t("history.menu.blame"), onClick: () => openFileInspector(repoId, x.path, c.sha) },
                { label: t("history.menu.copyPath"), onClick: () => copyText(x.path) },
              ])
            }
            title={x.origPath ? `${x.origPath} → ${x.path}` : x.path}
          >
            <span className={`st st-${x.status}`}>{x.status}</span>
            <span className="fname">{basename(x.path)}</span>
            <span className="fdir">{dirname(x.path)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
