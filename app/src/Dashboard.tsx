import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, newOpId } from "./api";
import { relTime, useT } from "./i18n";
import type { RepoSummary, Workspace } from "./types";
import { Icon } from "./ui/Icon";
import { cancelOp, confirmDialog, ops, promptDialog, showMenu, toast, toastError } from "./ui/store";

type Filter = "all" | "changes" | "unpushed" | "behind" | "progress" | "stash";

const FILTERS: { id: Filter; test: (s: RepoSummary) => boolean }[] = [
  { id: "all", test: () => true },
  { id: "changes", test: (s) => s.staged + s.unstaged + s.untracked + s.conflicted > 0 },
  { id: "unpushed", test: (s) => s.ahead > 0 || (!!s.branch && !s.upstream) },
  { id: "behind", test: (s) => s.behind > 0 },
  { id: "progress", test: (s) => !!s.inProgress || s.conflicted > 0 },
  { id: "stash", test: (s) => s.stashCount > 0 },
];

const COLS = 6;

export function Dashboard({ onOpen }: { onOpen: (path: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace"], queryFn: api.workspaceGet });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settingsGet });
  const paths = useMemo(() => ws.data?.repos.map((r) => r.path) ?? [], [ws.data]);
  const sums = useQuery({
    queryKey: ["summaries", paths],
    queryFn: () => api.workspaceSummaries(paths),
    enabled: paths.length > 0,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [fetchProg, setFetchProg] = useState<{ done: number; total: number } | null>(null);
  const fetchOp = ops.use((o) => o.find((x) => x.repoId === null));

  useEffect(() => {
    const un = listen<{ done: number; total: number }>("workspace:fetch-progress", (e) => setFetchProg(e.payload));
    return () => void un.then((f) => f());
  }, []);

  const setWs = (w: Workspace) => qc.setQueryData(["workspace"], w);
  const act = async (fn: () => Promise<Workspace>, msg?: string) => {
    try {
      setWs(await fn());
      if (msg) toast("success", msg);
    } catch (e) {
      toastError(e);
    }
  };

  const addRoot = async () => {
    const dir = await open({ directory: true, title: t("dash.pickRoot") });
    if (typeof dir === "string") await act(() => api.workspaceAddRoot(dir), t("dash.scanned"));
  };
  const addRepo = async () => {
    const dir = await open({ directory: true, title: t("dash.pickRepo") });
    if (typeof dir === "string") await act(() => api.workspaceAddRepo(dir), t("dash.added"));
  };

  const fetchAll = async () => {
    const targets = (sums.data ?? []).filter((s) => !s.error && s.upstream).map((s) => s.path);
    if (!targets.length) return toast("info", t("dash.fetchNone"));
    const id = newOpId();
    ops.set((o) => [...o, { id, repoId: null, label: t("dash.fetchAll"), line: "" }]);
    setFetchProg({ done: 0, total: targets.length });
    try {
      const res = await api.workspaceFetchAll(targets, id);
      const failed = res.filter((r) => !r.ok);
      if (failed.length)
        toast(
          "error",
          t("dash.fetchFailed", { failed: failed.length, total: res.length }),
          failed.map((f) => `${f.path}: ${f.error}`).join("\n"),
        );
      else toast("success", t("dash.fetchDone", { count: res.length }));
    } catch (e) {
      toastError(e);
    } finally {
      ops.set((o) => o.filter((x) => x.id !== id));
      setFetchProg(null);
      sums.refetch();
    }
  };

  const byPath = new Map(ws.data?.repos.map((r) => [r.path, r]));
  const term = q.trim().toLowerCase();
  const rows = (sums.data ?? [])
    .filter((s) => FILTERS.find((f) => f.id === filter)!.test(s))
    .filter(
      (s) =>
        !term || s.name.toLowerCase().includes(term) || s.path.toLowerCase().includes(term) || s.branch?.toLowerCase().includes(term),
    )
    .sort((a, b) => {
      const pa = byPath.get(a.path)?.pinned ? 1 : 0;
      const pb = byPath.get(b.path)?.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.lastCommitTime ?? 0) - (a.lastCommitTime ?? 0);
    });

  const rowMenu = (e: React.MouseEvent, s: RepoSummary) => {
    const meta = byPath.get(s.path);
    showMenu(e, [
      { label: t("dash.menu.open"), onClick: () => onOpen(s.path) },
      {
        label: meta?.pinned ? t("dash.menu.unpin") : t("dash.menu.pin"),
        onClick: () => act(() => api.workspaceSetRepo(s.path, !meta?.pinned)),
      },
      {
        label: t("dash.menu.group"),
        onClick: async () => {
          const g = await promptDialog(t("dash.groupTitle"), t("dash.groupLabel"), meta?.group ?? "");
          if (g !== null) act(() => api.workspaceSetRepo(s.path, null, g));
        },
      },
      { separator: true },
      { label: t("dash.menu.explorer"), onClick: () => api.revealPath(s.path, "explorer").catch(toastError) },
      { label: t("dash.menu.terminal"), onClick: () => api.revealPath(s.path, "terminal").catch(toastError) },
      { label: t("dash.menu.vscode"), onClick: () => api.revealPath(s.path, "vscode").catch(toastError) },
      { separator: true },
      {
        label: t("dash.menu.remove"),
        danger: true,
        onClick: async () => {
          if (
            await confirmDialog(t("dash.removeTitle"), t("dash.removeBody", { path: s.path }), {
              confirmLabel: t("common.remove"),
              danger: true,
            })
          )
            act(() => api.workspaceRemoveRepo(s.path));
        },
      },
    ]);
  };

  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, (sums.data ?? []).filter(f.test).length]));
  const repoCount = ws.data?.repos.length ?? 0;
  const roots = ws.data?.roots ?? [];
  const empty = ws.data && repoCount === 0;

  let subtitle = t("dash.subtitle", { count: repoCount });
  if (roots.length) subtitle += ` · ${t("dash.scannedFrom", { roots: roots.join(", "), depth: settings.data?.scanDepth ?? 4 })}`;

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <h1>{t("dash.title")}</h1>
          <p className="small">{subtitle}</p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn" onClick={addRepo}>
          <Icon name="plus" size={15} />
          {t("dash.addRepo")}
        </button>
        <button type="button" className="btn" onClick={addRoot}>
          <Icon name="folder" size={15} />
          {t("dash.scanFolder")}
        </button>
        <button type="button" className="btn" disabled={!roots.length} onClick={() => act(api.workspaceRescan, t("dash.rescanned"))}>
          <Icon name="refresh" size={15} />
          {t("dash.rescan")}
        </button>
        {fetchOp ? (
          <button type="button" className="btn" onClick={() => cancelOp(fetchOp.id)}>
            <span className="spinner" aria-hidden />
            {t("dash.cancelFetch", { done: fetchProg?.done ?? 0, total: fetchProg?.total ?? 0 })}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!sums.data?.length} onClick={fetchAll}>
            <Icon name="fetch" size={15} />
            {t("dash.fetchAll")}
          </button>
        )}
      </div>

      {empty ? (
        <div className="dash-empty">
          <Icon name="folder" size={36} stroke={1.4} style={{ color: "var(--text3)" }} />
          <h2>{t("dash.empty.title")}</h2>
          <p>{t("dash.empty.body")}</p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={addRoot}>
              <Icon name="folder" size={15} />
              {t("dash.empty.scan")}
            </button>
            <button type="button" className="btn" onClick={addRepo}>
              <Icon name="plus" size={15} />
              {t("dash.empty.add")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row wrap" style={{ flex: "none", gap: 10 }}>
            <div className="chips" role="group" aria-label={t("dash.filterGroup")}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  className={filter === f.id ? "chip on" : "chip"}
                  onClick={() => setFilter(f.id)}
                >
                  {t(`dash.filters.${f.id}`)}
                  <span className="mono">{counts[f.id] ?? 0}</span>
                </button>
              ))}
            </div>
            <span className="spacer" />
            {sums.isFetching && (
              <span className="row dim small" role="status">
                <span className="spinner sm" aria-hidden />
                {t("dash.updating")}
              </span>
            )}
            <label htmlFor="repo-search" className="sr-only">
              {t("dash.searchLabel")}
            </label>
            <div className="search-box" style={{ width: 260 }}>
              <Icon name="search" size={14} />
              <input
                id="repo-search"
                type="search"
                placeholder={t("dash.search")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="table-box">
            <table className="dtab">
              <thead>
                <tr>
                  <th scope="col">{t("dash.cols.repo")}</th>
                  <th scope="col">{t("dash.cols.branch")}</th>
                  <th scope="col">{t("dash.cols.sync")}</th>
                  <th scope="col">{t("dash.cols.tree")}</th>
                  <th scope="col">{t("dash.cols.last")}</th>
                  <th scope="col" style={{ width: 1 }}>
                    <span className="sr-only">{t("dash.cols.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const meta = byPath.get(s.path);
                  return (
                    <tr
                      key={s.path}
                      tabIndex={0}
                      onClick={() => onOpen(s.path)}
                      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(s.path)}
                      onContextMenu={(e) => rowMenu(e, s)}
                    >
                      <td>
                        <div className="repo-cell">
                          <b>
                            {meta?.pinned && <Icon name="pin" size={13} label={t("dash.pinned")} style={{ color: "var(--brand)" }} />}
                            <span className="ellipsis">{s.name}</span>
                            {meta?.group && <span className="group-tag">{meta.group}</span>}
                          </b>
                          <span className="mono ellipsis">{s.path}</span>
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          {s.error ? (
                            <span className="danger-text small" title={s.error}>
                              {t("dash.readError")}
                            </span>
                          ) : (
                            <span className="mono small">{s.branch ?? (s.detached ? t("dash.detached") : "—")}</span>
                          )}
                          {s.inProgress && <span className="pill pill-warn">{s.inProgress}</span>}
                        </div>
                      </td>
                      <td>
                        <SyncCell s={s} />
                      </td>
                      <td>
                        <TreeCell s={s} />
                      </td>
                      <td className="muted small" style={{ whiteSpace: "nowrap" }}>
                        {s.error ? "—" : s.lastCommitTime == null ? t("time.noCommits") : relTime(s.lastCommitTime)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn sm"
                          aria-label={t("dash.moreFor", { name: s.name })}
                          title={t("dash.moreFor", { name: s.name })}
                          onClick={(e) => rowMenu(e, s)}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="dots" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={COLS} className="dim" style={{ textAlign: "center", padding: 24, cursor: "default" }}>
                      {sums.isLoading ? t("dash.loadingRows") : t("dash.noMatch")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {roots.length > 0 && (
        <div className="dash-foot">
          <span>{t("dash.roots")}</span>
          {roots.map((r) => (
            <span key={r} className="root-chip">
              {r}
              <button
                type="button"
                className="icon-btn xs"
                aria-label={t("dash.removeRoot", { path: r })}
                title={t("dash.removeRoot", { path: r })}
                onClick={() => act(() => api.workspaceRemoveRoot(r))}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <span className="spacer" />
          <span>{t("dash.skips")}</span>
        </div>
      )}
    </div>
  );
}

function SyncCell({ s }: { s: RepoSummary }) {
  const t = useT();
  if (s.error) return <span className="dim">—</span>;
  if (!s.hasRemote) return <span className="small dim">{t("dash.noRemote")}</span>;
  if (s.branch && !s.upstream) return <span className="pill pill-warn">{t("dash.notPublished")}</span>;
  if (!s.upstream) return <span className="dim">—</span>;
  if (!s.ahead && !s.behind)
    return (
      <span className="row ok-text small" style={{ gap: 5 }}>
        <Icon name="check" size={13} stroke={2.4} />
        {t("dash.inSync")}
      </span>
    );
  return (
    <span className="row mono small" style={{ gap: 8, fontWeight: 600 }}>
      {s.behind > 0 && <span className="warn">↓{s.behind.toLocaleString()}</span>}
      {s.ahead > 0 && <span style={{ color: "var(--accent)" }}>↑{s.ahead.toLocaleString()}</span>}
    </span>
  );
}

function TreeCell({ s }: { s: RepoSummary }) {
  const t = useT();
  if (s.error) return null;
  const parts: React.ReactNode[] = [];
  if (s.conflicted)
    parts.push(
      <span key="c" className="pill pill-danger">
        {t("dash.conflicts", { count: s.conflicted })}
      </span>,
    );
  if (s.staged)
    parts.push(
      <span key="s" className="pill pill-ok">
        {t("dash.staged", { count: s.staged })}
      </span>,
    );
  if (s.unstaged)
    parts.push(
      <span key="u" className="pill">
        {t("dash.modified", { count: s.unstaged })}
      </span>,
    );
  if (s.untracked)
    parts.push(
      <span key="n" className="pill">
        {t("dash.untracked", { count: s.untracked })}
      </span>,
    );
  return parts.length ? <span className="pills">{parts}</span> : <span className="dim small">{t("dash.clean")}</span>;
}
