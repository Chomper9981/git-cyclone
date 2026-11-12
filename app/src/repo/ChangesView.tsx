import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { accountsOpen, avatarUrl, usableAccounts, useGitEnv } from "../Accounts";
import { api } from "../api";
import { useT } from "../i18n";
import type { HunkSelection, RepoStatus, StatusEntry } from "../types";
import { basename, copyText, dirname, joinPath } from "../ui/format";
import { Avatar, Icon } from "../ui/Icon";
import { confirmDialog, showMenu, toast } from "../ui/store";
import type { RepoActions } from "./actions";
import { useRepoAuth } from "./AccountChip";
import { ConflictView } from "./ConflictView";
import { DiffView } from "./DiffView";
import { openFileInspector } from "./FileInspector";
import { qk } from "./hooks";

export type Side = "unstaged" | "staged" | "conflict";
/** File worktree đang mở trong khung diff đè lên graph. */
export interface WtSel {
  path: string;
  side: Side;
}
type Mode = "tree" | "list";

interface Props {
  repoId: string;
  repoPath: string;
  status: RepoStatus | undefined;
  actions: RepoActions;
  /** File đang mở diff (null = không mở). */
  sel: WtSel | null;
  onSel: (s: WtSel | null) => void;
}

export function partition(entries: StatusEntry[]) {
  const conflicts: StatusEntry[] = [];
  const staged: StatusEntry[] = [];
  const unstaged: StatusEntry[] = [];
  for (const e of entries) {
    if (e.conflict) conflicts.push(e);
    else {
      if (e.index !== "." && e.index !== "?") staged.push(e);
      if (e.worktree !== "." || e.index === "?") unstaged.push(e);
    }
  }
  return { conflicts, staged, unstaged };
}

interface Item {
  path: string;
  origPath: string | null;
  /** Mã trạng thái hiển thị (M/A/D/R/U/N…). */
  status: string;
  /** File có thay đổi ở cả hai phía (một phần đã stage). */
  partial: boolean;
}

const MODE_KEY = "changes:view";

/** Thẻ stage + commit ở panel phải (khi chọn dòng "Changes" trên graph). */
export function ChangesPanel({ repoId, repoPath, status, actions, sel, onSel }: Props) {
  const t = useT();
  const { run } = actions;
  const { conflicts, staged, unstaged } = useMemo(() => partition(status?.entries ?? []), [status]);
  const setSel = onSel;
  const [filter, setFilter] = useState("");
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === "list" ? "list" : "tree"));
  const setMode = (m: Mode) => {
    setModeState(m);
    localStorage.setItem(MODE_KEY, m);
  };

  // giữ lựa chọn hợp lệ khi status thay đổi
  useEffect(() => {
    const list = sel?.side === "staged" ? staged : sel?.side === "conflict" ? conflicts : unstaged;
    if (sel && list.some((e) => e.path === sel.path)) return;
    if (sel) {
      // file vừa chuyển phía (vd. vừa stage hết) → theo nó sang phía kia
      const other = sel.side === "unstaged" ? staged : unstaged;
      if (other.some((e) => e.path === sel.path)) return setSel({ path: sel.path, side: sel.side === "unstaged" ? "staged" : "unstaged" });
    }
    if (sel) setSel(null);
  }, [conflicts, staged, unstaged]);

  const stagedSet = useMemo(() => new Set(staged.map((e) => e.path)), [staged]);
  const unstagedSet = useMemo(() => new Set(unstaged.map((e) => e.path)), [unstaged]);
  const q = filter.trim().toLowerCase();
  const match = (e: StatusEntry) => !q || e.path.toLowerCase().includes(q) || (e.origPath ?? "").toLowerCase().includes(q);
  const conflictItems: Item[] = conflicts.filter(match).map((e) => ({ path: e.path, origPath: e.origPath, status: "U", partial: false }));
  const stagedItems: Item[] = staged.filter(match).map((e) => ({ path: e.path, origPath: e.origPath, status: e.index, partial: unstagedSet.has(e.path) }));
  const unstagedItems: Item[] = unstaged
    .filter(match)
    .map((e) => ({ path: e.path, origPath: e.origPath, status: e.index === "?" ? "N" : e.worktree, partial: stagedSet.has(e.path) }));
  const total = conflicts.length + new Set([...stagedSet, ...unstagedSet]).size;

  const stage = (paths: string[]) => run(() => api.stageFiles(repoId, paths));
  const unstage = (paths: string[]) => run(() => api.unstageFiles(repoId, paths));

  const discard = async (paths: string[]) => {
    const ok = await confirmDialog(
      t("changes.discardTitle"),
      paths.length === 1 ? t("changes.discardOne", { name: paths[0] }) : t("changes.discardMany", { count: paths.length }),
      { danger: true, confirmLabel: t("changes.discardConfirm"), detail: t("changes.discardDetail") },
    );
    if (ok) await run(() => api.discardFiles(repoId, paths), t("changes.discarded"));
  };

  const fileMenu = (e: React.MouseEvent, item: Item, side: "staged" | "unstaged") =>
    showMenu(e, [
      side === "unstaged" ? { label: t("changes.stage"), onClick: () => stage([item.path]) } : { label: t("changes.unstage"), onClick: () => unstage([item.path]) },
      ...(side === "unstaged" ? [{ label: t("changes.discard"), danger: true, onClick: () => discard([item.path]) }] : []),
      { label: t("changes.stashFile"), onClick: () => run(() => api.stashPush(repoId, `stash ${item.path}`, true, [item.path]), t("changes.stashedFile")) },
      { separator: true },
      { label: t("changes.blame"), disabled: item.status === "N" || item.status === "A", onClick: () => openFileInspector(repoId, item.path) },
      { label: t("changes.openFolder"), onClick: () => api.revealPath(joinPath(repoPath, dirname(item.path)), "explorer").catch(() => {}) },
      {
        label: t("changes.copyPath"),
        onClick: () => copyText(item.path).then((ok) => ok && toast("success", t("common.copied"), item.path)),
      },
    ]);

  return (
      <section className="changes-left" aria-label={t("changes.label")}>
        <div className="cl-top">
          <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
            <Icon name="search" size={14} />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              placeholder={t("changes.filter", { count: total })}
              aria-label={t("changes.filterLabel")}
              spellCheck={false}
            />
          </div>
          <div className="seg sm" role="group" aria-label={t("changes.view")}>
            <button type="button" className={mode === "tree" ? "on" : undefined} aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>
              {t("changes.tree")}
            </button>
            <button type="button" className={mode === "list" ? "on" : undefined} aria-pressed={mode === "list"} onClick={() => setMode("list")}>
              {t("changes.list")}
            </button>
          </div>
        </div>

        {conflicts.length > 0 && (
          <FileSection
            side="conflict"
            className="cl-section staged"
            title={<span className="danger-text">{t("changes.conflicts")}</span>}
            count={conflicts.length}
            items={conflictItems}
            filtered={!!q}
            mode={mode}
            selected={sel?.side === "conflict" ? sel.path : null}
            onSelect={(p) => setSel({ path: p, side: "conflict" })}
            empty={t("changes.noMatch")}
          />
        )}

        <FileSection
          side="staged"
          className="cl-section staged"
          title={t("changes.staged")}
          count={staged.length}
          items={stagedItems}
          filtered={!!q}
          mode={mode}
          selected={sel?.side === "staged" ? sel.path : null}
          onSelect={(p) => setSel({ path: p, side: "staged" })}
          onActivate={(p) => unstage([p])}
          onContext={(e, it) => fileMenu(e, it, "staged")}
          empty={q && staged.length ? t("changes.noMatch") : t("changes.noneStaged")}
          rowAction={(it) => (
            <button
              type="button"
              className="mini-btn"
              title={t("changes.unstage")}
              aria-label={t("changes.unstageNamed", { name: it.path })}
              onClick={() => unstage([it.path])}
            >
              −
            </button>
          )}
          actions={
            staged.length > 0 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => unstage(staged.map((e) => e.path))}>
                {t("changes.unstageAll")}
              </button>
            )
          }
        />

        <FileSection
          side="unstaged"
          className="cl-section grow"
          title={t("changes.unstaged")}
          count={unstaged.length}
          items={unstagedItems}
          filtered={!!q}
          mode={mode}
          selected={sel?.side === "unstaged" ? sel.path : null}
          onSelect={(p) => setSel({ path: p, side: "unstaged" })}
          onActivate={(p) => stage([p])}
          onContext={(e, it) => fileMenu(e, it, "unstaged")}
          empty={q && unstaged.length ? t("changes.noMatch") : t("changes.noChanges")}
          rowAction={(it) => (
            <button
              type="button"
              className="mini-btn"
              title={t("changes.stage")}
              aria-label={t("changes.stageNamed", { name: it.path })}
              onClick={() => stage([it.path])}
            >
              +
            </button>
          )}
          actions={
            unstaged.length > 0 && (
              <>
                <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => discard(unstaged.map((e) => e.path))}>
                  {t("changes.discardAll")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => stage(unstaged.map((e) => e.path))}>
                  {t("changes.stageAll")}
                </button>
              </>
            )
          }
        />

        <Composer repoId={repoId} status={status} stagedCount={staged.length} conflictCount={conflicts.length} actions={actions} />
      </section>
  );
}

/** Diff (hoặc trình giải conflict) của một file worktree — hiển thị trong khung đè lên graph. */
export function WorktreeDiff({
  repoId,
  repoPath,
  status,
  actions,
  sel,
  headerExtra,
}: {
  repoId: string;
  repoPath: string;
  status: RepoStatus | undefined;
  actions: RepoActions;
  sel: WtSel;
  headerExtra?: React.ReactNode;
}) {
  const t = useT();
  const { run } = actions;
  const { conflicts, staged, unstaged } = useMemo(() => partition(status?.entries ?? []), [status]);
  const stage = (paths: string[]) => run(() => api.stageFiles(repoId, paths));
  const unstage = (paths: string[]) => run(() => api.unstageFiles(repoId, paths));
  const entry = sel && (sel.side === "staged" ? staged : sel.side === "conflict" ? conflicts : unstaged).find((e) => e.path === sel.path);
  const untracked = entry?.index === "?";
  const { data: diff, isFetching } = useQuery({
    queryKey: qk.wtdiff(repoId, sel?.path ?? "", sel?.side === "staged"),
    queryFn: () => api.worktreeDiff(repoId, entry!.path, entry!.origPath, sel!.side === "staged", untracked),
    enabled: !!entry && sel?.side !== "conflict",
  });

  const lineSide = sel?.side === "staged" ? "staged" : "unstaged";

  const right =
    sel?.side === "conflict" ? (
      <ConflictView repoId={repoId} repoPath={repoPath} path={sel.path} run={run} headerExtra={headerExtra} />
    ) : (
      <DiffView
        diff={entry ? diff : undefined}
        loading={isFetching}
        selectable
        headerExtra={headerExtra}
        repoId={repoId}
        repoPath={repoPath}
        emptyText={status?.entries.length ? t("changes.choose") : t("changes.clean")}
        hunkActions={(hi, h) => {
          if (!entry || !diff) return null;
          const all: HunkSelection[] = [{ hunk: hi, header: h.header, lines: h.lines.map((_, i) => i).filter((i) => h.lines[i].kind === "+" || h.lines[i].kind === "-") }];
          const wholeFile = diff.status === "A" || diff.status === "D";
          if (lineSide === "staged")
            return (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => run(() => (wholeFile ? api.unstageFiles(repoId, [entry.path]) : api.unstageLines(repoId, entry.path, all)))}
              >
                {t("changes.hunkUnstage")}
              </button>
            );
          return (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost-danger"
                disabled={wholeFile}
                onClick={async () => {
                  if (await confirmDialog(t("changes.discardHunkTitle"), t("changes.discardHunkBody"), { danger: true, confirmLabel: t("changes.hunkDiscard") }))
                    await run(() => api.discardLines(repoId, entry.path, all));
                }}
              >
                {t("changes.hunkDiscard")}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => run(() => (wholeFile ? api.stageFiles(repoId, [entry.path]) : api.stageLines(repoId, entry.path, all)))}
              >
                <Icon name="plus" size={13} />
                {wholeFile ? t("changes.fileStage") : t("changes.hunkStage")}
              </button>
            </>
          );
        }}
        selectionActions={(s, clear) => {
          if (!entry) return null;
          const count = s.reduce((n, x) => n + x.lines.length, 0);
          return lineSide === "staged" ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => run(() => api.unstageLines(repoId, entry.path, s)).then(clear)}>
              {t("changes.unstageLines", { count })}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost-danger"
                onClick={async () => {
                  if (await confirmDialog(t("changes.discardLinesTitle"), t("changes.discardLinesBody"), { danger: true, confirmLabel: t("changes.discardLines") }))
                    await run(() => api.discardLines(repoId, entry.path, s)).then(clear);
                }}
              >
                {t("changes.discardLines")}
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => run(() => api.stageLines(repoId, entry.path, s)).then(clear)}>
                <Icon name="plus" size={13} />
                {t("changes.stageLines", { count })}
              </button>
            </>
          );
        }}
        onStageKey={
          entry && lineSide === "unstaged"
            ? (s, clear) => (s.length ? run(() => api.stageLines(repoId, entry.path, s)).then(clear) : stage([entry.path]))
            : undefined
        }
        onUnstageKey={
          entry && lineSide === "staged"
            ? (s, clear) => (s.length ? run(() => api.unstageLines(repoId, entry.path, s)).then(clear) : unstage([entry.path]))
            : undefined
        }
      />
    );

  return right;
}

/* ---------- danh sách file (cây / phẳng) ---------- */

type Line = { kind: "folder"; dir: string; count: number; open: boolean } | { kind: "file"; item: Item; nested: boolean };

function FileSection({
  side,
  className,
  title,
  count,
  items,
  filtered,
  mode,
  selected,
  onSelect,
  onActivate,
  onContext,
  rowAction,
  actions,
  empty,
}: {
  side: Side;
  className: string;
  title: React.ReactNode;
  count: number;
  items: Item[];
  filtered: boolean;
  mode: Mode;
  selected: string | null;
  onSelect: (path: string) => void;
  onActivate?: (path: string) => void;
  onContext?: (e: React.MouseEvent, item: Item) => void;
  rowAction?: (item: Item) => React.ReactNode;
  actions?: React.ReactNode;
  empty: string;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const lines: Line[] = useMemo(() => {
    if (mode === "list") return items.map((item) => ({ kind: "file" as const, item, nested: false }));
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      const d = dirname(it.path).replace(/\\/g, "/");
      const g = groups.get(d);
      if (g) g.push(it);
      else groups.set(d, [it]);
    }
    const dirs = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    // chỉ có file ở gốc → không cần dòng thư mục
    if (dirs.length === 1 && dirs[0] === "") return items.map((item) => ({ kind: "file" as const, item, nested: false }));
    const out: Line[] = [];
    for (const d of dirs) {
      const files = groups.get(d)!;
      const open = filtered || !collapsed.has(d);
      out.push({ kind: "folder", dir: d, count: files.length, open });
      if (open) for (const item of files) out.push({ kind: "file", item, nested: true });
    }
    return out;
  }, [items, mode, collapsed, filtered]);

  const visibleFiles = lines.filter((l): l is Extract<Line, { kind: "file" }> => l.kind === "file").map((l) => l.item);

  const toggleDir = (d: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(d) ? n.delete(d) : n.add(d);
      return n;
    });

  // cuộn tới dòng đang chọn
  useEffect(() => {
    if (!selected) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" && e.target !== e.currentTarget) return;
    const i = visibleFiles.findIndex((f) => f.path === selected);
    const k = e.key.toLowerCase();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(0, Math.min(visibleFiles.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (visibleFiles[n]) onSelect(visibleFiles[n].path);
    } else if (selected && onActivate && (e.key === "Enter" || e.key === " " || (k === "s" && side === "unstaged") || (k === "u" && side === "staged"))) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      onActivate(selected);
    }
  };

  return (
    <div className={className}>
      <div className="cl-head">
        <h3>
          {title} <span className="mono">{count}</span>
        </h3>
        {actions}
      </div>
      <div className="cl-list" ref={listRef} role="listbox" aria-label={typeof title === "string" ? title : undefined} tabIndex={visibleFiles.length ? 0 : -1} onKeyDown={onKeyDown}>
        {items.length === 0 && <div className="fl-empty">{empty}</div>}
        {lines.map((l) => {
          if (l.kind === "folder")
            return (
              <button
                key={`d:${l.dir}`}
                type="button"
                className="folder-row"
                aria-expanded={l.open}
                tabIndex={-1}
                onClick={() => toggleDir(l.dir)}
                title={l.dir || t("changes.root")}
              >
                <span className="chev" style={{ display: "inline-grid" }}>
                  <Icon name="chevDown" size={12} />
                </span>
                <Icon name="folder" size={14} />
                <span className="mono small ellipsis" style={{ flex: 1 }}>
                  {l.dir || t("changes.root")}
                </span>
                <span className="mono dim small">{l.count}</span>
              </button>
            );
          const it = l.item;
          const dir = dirname(it.path);
          const isSel = it.path === selected;
          return (
            <div
              key={it.path}
              role="option"
              aria-selected={isSel}
              className={isSel ? "fl-row selected" : "fl-row"}
              style={l.nested ? { paddingLeft: 32 } : undefined}
              onClick={() => onSelect(it.path)}
              onDoubleClick={() => onActivate?.(it.path)}
              onContextMenu={onContext ? (e) => onContext(e, it) : undefined}
              title={it.origPath ? `${it.origPath} → ${it.path}` : it.path}
            >
              <span className={`st st-${it.status}`}>{it.status}</span>
              <span className="fname">{basename(it.path)}</span>
              {mode === "list" && dir ? <span className="fdir">{dir}</span> : <span className="spacer" />}
              {it.partial && <span className="dim small">{t("changes.partial")}</span>}
              {rowAction && (
                <span className="row-act" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  {rowAction(it)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- soạn commit ---------- */

function splitMsg(m: string): [string, string] {
  const i = m.indexOf("\n");
  return i < 0 ? [m, ""] : [m.slice(0, i), m.slice(i + 1).replace(/^\s*\n/, "")];
}
const joinMsg = (summary: string, body: string) => (body.trim() ? `${summary}\n\n${body}` : summary);

function Composer({
  repoId,
  status,
  stagedCount,
  conflictCount,
  actions,
}: {
  repoId: string;
  status: RepoStatus | undefined;
  stagedCount: number;
  conflictCount: number;
  actions: RepoActions;
}) {
  const t = useT();
  const key = `draft:${repoId}`;
  const [initial] = useState(() => splitMsg(localStorage.getItem(key) ?? ""));
  const [summary, setSummary] = useState(initial[0]);
  const [body, setBody] = useState(initial[1]);
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const msg = joinMsg(summary, body);
  useEffect(() => localStorage.setItem(key, msg), [key, msg]);

  const setMsg = (m: string) => {
    const [s, b] = splitMsg(m);
    setSummary(s);
    setBody(b);
  };

  const ip = status?.inProgress;
  const { data: auth } = useRepoAuth(repoId);
  const { data: env } = useGitEnv();
  const gcm = usableAccounts(env);
  const account = auth?.account ?? (gcm.length === 1 ? gcm[0].name : null);
  const canCommit = !busy && conflictCount === 0 && (amend || (stagedCount > 0 && msg.trim().length > 0));
  const finishMerge = ip?.kind === "merge" && !msg.trim();

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !msg.trim()) setMsg(await api.headMessage(repoId).catch(() => ""));
  };

  const commit = async (push = false) => {
    if (!canCommit) return;
    setBusy(true);
    const ok = await actions.run(() => api.commit(repoId, msg, amend), amend ? t("composer.amended") : t("composer.committed"));
    setBusy(false);
    if (ok) {
      setMsg("");
      setAmend(false);
      if (push) await actions.push();
    }
  };

  const submit = () => {
    if (finishMerge) {
      if (conflictCount === 0) actions.sequencer("continue");
    } else commit();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  };

  if (ip && ip.kind !== "merge") {
    return (
      <div className="composer">
        <p className="muted small" style={{ margin: 0 }}>
          {t("composer.sequencer", { kind: ip.kind })}
        </p>
      </div>
    );
  }

  return (
    <form
      className="composer"
      aria-label={t("composer.label")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="msg-box">
        <div className="msg-sum">
          <label htmlFor={`commit-summary-${repoId}`} className="sr-only">
            {t("composer.summary")}
          </label>
          <input
            id={`commit-summary-${repoId}`}
            value={summary}
            placeholder={ip?.kind === "merge" ? t("composer.mergePh") : t("composer.summaryPh")}
            spellCheck={false}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.ctrlKey) {
                e.preventDefault();
                bodyRef.current?.focus();
              } else onKey(e);
            }}
          />
          <span className={summary.length > 72 ? "mono small warn" : "mono small dim"} title={t("composer.lengthTip")}>
            {summary.length}/72
          </span>
        </div>
        <label htmlFor={`commit-body-${repoId}`} className="sr-only">
          {t("composer.body")}
        </label>
        <textarea
          id={`commit-body-${repoId}`}
          ref={bodyRef}
          rows={2}
          value={body}
          placeholder={t("composer.bodyPh")}
          spellCheck={false}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
        />
      </div>

      <div className="identity" title={auth?.emailScope ? t("composer.scope", { scope: auth.emailScope }) : undefined}>
        {auth?.email ? (
          <>
            {account ? <Avatar login={account} url={avatarUrl(account)} size={20} /> : <Avatar login={auth.name || auth.email} size={20} />}
            <span className="ellipsis">
              {t("composer.identity")} <b>{auth.name ?? "?"}</b> <span className="dim">&lt;{auth.email}&gt;</span>
            </span>
          </>
        ) : (
          <span className="warn">
            {t("composer.noIdentity")}{" "}
            <button type="button" className="link-btn" onClick={() => accountsOpen.set("identity")}>
              {t("composer.signIn")}
            </button>{" "}
            {t("composer.orRun")} <code>git config --global user.email …</code>
          </span>
        )}
      </div>

      <label className="check-row">
        <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} disabled={!status?.oid} />
        {t("composer.amend")}
      </label>

      {conflictCount > 0 && (
        <p className="warn small" style={{ margin: 0 }}>
          {t("composer.resolveFirst", { count: conflictCount })}
        </p>
      )}

      <div className="row">
        {finishMerge ? (
          <button type="submit" className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} disabled={conflictCount > 0}>
            <Icon name="merge" size={15} />
            {t("composer.finishMerge")}
            <kbd>Ctrl ↵</kbd>
          </button>
        ) : (
          <>
            <button type="submit" className="btn btn-primary" style={{ flex: 1, justifyContent: "center", minWidth: 0 }} disabled={!canCommit} title="Ctrl+Enter">
              <Icon name="commit" size={15} />
              <span className="ellipsis">{busy ? t("composer.committing") : amend ? t("composer.commitAmend") : t("composer.commit", { count: stagedCount })}</span>
              <kbd>Ctrl ↵</kbd>
            </button>
            <button type="button" className="btn" disabled={!canCommit} onClick={() => commit(true)}>
              <Icon name="push" size={15} />
              {t("composer.commitPush")}
            </button>
          </>
        )}
      </div>

      {stagedCount === 0 && !amend && msg.trim() && conflictCount === 0 && !finishMerge && (
        <button type="button" className="link-btn small" style={{ alignSelf: "flex-start" }} onClick={() => toast("info", t("composer.whyTitle"), t("composer.whyBody"))}>
          {t("composer.whyDisabled")}
        </button>
      )}
    </form>
  );
}
