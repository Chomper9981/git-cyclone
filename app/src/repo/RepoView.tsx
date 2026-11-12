import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { api, newOpId } from "../api";
import { t, useT } from "../i18n";
import { registerRepoCommands } from "../Palette";
import type { RepoInfo } from "../types";
import { shortSha } from "../ui/format";
import { Icon, Oct } from "../ui/Icon";
import { Split } from "../ui/Split";
import { ops, showMenu, showMenuBelow, toastError, type MenuItem } from "../ui/store";
import { AccountChip } from "./AccountChip";
import { repoActions } from "./actions";
import { partition } from "./ChangesView";
import { HistoryView, type HistoryHandle } from "./HistoryView";
import { invalidateRepo, useRefs, useStatus } from "./hooks";
import { Sidebar } from "./Sidebar";

export function RepoView({ repo, active }: { repo: RepoInfo; active: boolean }) {
  const tt = useT();
  const qc = useQueryClient();
  const { data: status, error } = useStatus(repo.id);
  const { data: refs } = useRefs(repo.id);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settingsGet, staleTime: Infinity });
  const a = useMemo(() => repoActions(repo.id, qc), [repo.id, qc]);
  const history = useRef<HistoryHandle>(null);
  const busy = ops.use((o) => o.some((x) => x.repoId === repo.id));
  const counts = useMemo(() => partition(status?.entries ?? []), [status]);
  const changeCount = status?.entries.length ?? 0;

  // fetch nền theo cài đặt (im lặng; lỗi bỏ qua)
  const autoFetch = settings?.autoFetchMinutes ?? 0;
  useEffect(() => {
    if (!autoFetch) return;
    const id = window.setInterval(() => {
      if (ops.get().some((x) => x.repoId === repo.id)) return;
      api
        .fetch(repo.id, newOpId())
        .then(() => invalidateRepo(qc, repo.id))
        .catch(() => {});
    }, autoFetch * 60_000);
    return () => window.clearInterval(id);
  }, [autoFetch, repo.id, qc]);

  // lệnh cho bảng lệnh + phím tắt khi tab đang hiển thị
  useEffect(() => {
    if (!active) return;
    const unreg = registerRepoCommands(repo.id, a, { showHistory: () => history.current?.showHead(), showChanges: () => history.current?.showChanges() });
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "f") (e.preventDefault(), a.fetch());
      else if (e.shiftKey && k === "l") (e.preventDefault(), a.pull());
      else if (e.shiftKey && k === "p") (e.preventDefault(), a.push());
      else if (!e.shiftKey && e.key === "1") (e.preventDefault(), history.current?.showHead());
      else if (!e.shiftKey && e.key === "2") (e.preventDefault(), history.current?.showChanges());
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unreg();
      window.removeEventListener("keydown", onKey);
    };
  }, [active, a, repo.id]);

  if (error && !status)
    return (
      <div className="center-msg">
        <h2 style={{ margin: 0 }}>{tt("repo.readError")}</h2>
        <p className="muted">{String((error as { message?: string }).message ?? error)}</p>
      </div>
    );

  const ip = status?.inProgress;
  const branchLabel = status?.branch ?? (status?.detached ? tt("repo.detachedAt", { sha: shortSha(status.oid ?? "") }) : "—");
  const noRemote = !!refs && refs.remotes.length === 0;
  const unpublished = !noRemote && !!status?.branch && !status.upstream && !!status.oid;
  const inSync = !!status?.upstream && !status.ahead && !status.behind;

  const branchMenu = (el: Element) => {
    const local = refs?.branches.filter((b) => !b.remote) ?? [];
    const items: MenuItem[] = [
      { label: t("repo.branchMenu"), heading: true },
      ...local.slice(0, 20).map((b) => ({ label: b.name, hint: b.current ? "✓" : undefined, disabled: b.current, onClick: () => a.checkout(b) })),
      { separator: true },
      { label: t("palette.newBranch"), onClick: () => a.createBranch() },
    ];
    showMenuBelow(el, items);
  };

  const reveal = (target: "explorer" | "terminal" | "vscode") => api.revealPath(repo.path, target).catch(toastError);

  return (
    <div className="repo">
      <div className="repobar">
        <div className="repo-title" title={repo.path}>
          <h1>{repo.name}</h1>
          <span>{repo.path}</span>
        </div>
        <button className="branch-btn chamfer" onClick={(e) => branchMenu(e.currentTarget)} aria-haspopup="menu" title={status?.upstream ? tt("repo.tracks", { upstream: status.upstream }) : tt("repo.noUpstream")}>
          {status?.detached ? <Icon name="commit" size={15} /> : <Oct size={10} color="var(--brand)" />}
          <span className="mono">{branchLabel}</span>
          {status?.upstream && <span className="small dim" style={{ fontWeight: 400 }}>→ {status.upstream}</span>}
          <Icon name="chevDown" size={14} style={{ color: "var(--text3)" }} />
        </button>
        {unpublished && <span className="pill pill-warn">{tt("repo.notPublished")}</span>}
        {noRemote && <span className="small dim">{tt("dash.noRemote")}</span>}
        {inSync && (
          <span className="pill pill-ok">
            <Icon name="check" size={12} stroke={2.4} />
            {tt("repo.inSync")}
          </span>
        )}
        <div className="syncgroup" role="group" aria-label={tt("repo.sync")}>
          <button disabled={busy || noRemote} onClick={() => a.fetch()} title={tt("repo.fetchTip")}>
            <Icon name="fetch" size={15} />
            {tt("repo.fetch")}
          </button>
          <button disabled={busy || status?.detached || !status?.upstream} onClick={() => a.pull()} title={tt("repo.pullTip")}>
            <Icon name="pull" size={15} />
            {tt("repo.pull")}
            {!!status?.behind && <span className="count" title={tt("repo.behind", { count: status.behind })}>↓{status.behind}</span>}
          </button>
          <button
            className={unpublished || (status?.ahead ?? 0) > 0 ? "primary" : undefined}
            disabled={busy || noRemote || status?.detached || !status?.oid}
            onClick={() => a.push()}
            onContextMenu={(e) => showMenu(e, [{ label: t("repo.forcePush"), danger: true, onClick: () => a.push(true) }])}
            title={tt("repo.pushTip")}
          >
            <Icon name="push" size={15} stroke={2} />
            {unpublished ? tt("repo.publish") : tt("repo.push")}
            {!!status?.ahead && <span className="count" title={tt("repo.ahead", { count: status.ahead })}>↑{status.ahead}</span>}
          </button>
        </div>
        <button className="btn" onClick={() => a.createBranch()} disabled={!status?.oid}>
          <Icon name="branch" size={15} />
          {tt("repo.newBranch")}
        </button>
        <button className="btn" onClick={() => a.stash()} disabled={!changeCount}>
          <Icon name="stash" size={15} />
          {tt("repo.stash")}
        </button>
        <span className="spacer" />
        <AccountChip repoId={repo.id} />
        <button
          className="icon-btn"
          aria-label={tt("repo.openIn")}
          title={tt("repo.openIn")}
          aria-haspopup="menu"
          onClick={(e) =>
            showMenuBelow(e.currentTarget, [
              { label: t("repo.explorer"), onClick: () => reveal("explorer") },
              { label: t("repo.terminal"), onClick: () => reveal("terminal") },
              { label: t("repo.vscode"), onClick: () => reveal("vscode") },
            ])
          }
        >
          <Icon name="folder" size={16} />
        </button>
      </div>

      {ip && (
        <div className="banner" role="status">
          <b>{tt(`repo.inProgress.${ip.kind}`)}</b>
          {ip.kind === "rebase" && ip.step && ip.total && (
            <span>
              {tt("repo.step", { step: ip.step, total: ip.total })}
              {ip.onto ? ` ${tt("repo.onBranch", { name: ip.onto })}` : ""}
            </span>
          )}
          <span className="muted">· {counts.conflicts.length ? tt("repo.conflictsLeft", { count: counts.conflicts.length }) : tt("repo.noConflicts")}</span>
          <span className="spacer" />
          {ip.kind !== "merge" && (
            <button className="btn btn-sm" onClick={() => a.sequencer("skip")}>
              {tt("repo.skip")}
            </button>
          )}
          <button className="btn btn-sm btn-ghost-danger" onClick={() => a.sequencer("abort")}>
            {tt("repo.abort")}
          </button>
          <button className="btn btn-sm btn-primary" disabled={counts.conflicts.length > 0} onClick={() => a.sequencer("continue")}>
            {tt("repo.continue")}
          </button>
        </div>
      )}

      <div className="repo-body">
        <Split id="sidebar" dir="row" initial={252} min={190}>
          <Sidebar repoId={repo.id} status={status} actions={a} onJump={(sha) => history.current?.jumpTo(sha)} />
          <HistoryView ref={history} repoId={repo.id} repoPath={repo.path} status={status} actions={a} />
        </Split>
      </div>
    </div>
  );
}
