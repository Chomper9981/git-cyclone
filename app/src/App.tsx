import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { AccountsHost, accountsOpen, avatarUrl, usableAccounts, useGitEnv } from "./Accounts";
import { api } from "./api";
import logoUrl from "./assets/logo.svg";
import { CloseDialog } from "./CloseDialog";
import { Dashboard } from "./Dashboard";
import { setLang, t, useT } from "./i18n";
import { Palette, registerCommands } from "./Palette";
import { FileInspectorHost } from "./repo/FileInspector";
import { invalidateRepo, useStatus } from "./repo/hooks";
import { RepoView } from "./repo/RepoView";
import { SettingsView } from "./Settings";
import { applyTheme } from "./theme";
import type { RepoInfo } from "./types";
import { Avatar, Icon } from "./ui/Icon";
import { OpsBar, Overlays } from "./ui/Overlays";
import { ops, paletteOpen, showMenu, toastError, updateOpLine } from "./ui/store";

const DASH = "__dashboard__";
const SETTINGS = "__settings__";

export default function App() {
  const tt = useT();
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<RepoInfo[]>([]);
  const [active, setActive] = useState<string>(DASH);
  const [ready, setReady] = useState(false);
  const info = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo, staleTime: Infinity });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settingsGet, staleTime: Infinity });
  const gitenv = useGitEnv();
  const gcm = usableAccounts(gitenv.data);
  const ident = gitenv.data?.identity;

  useEffect(() => {
    if (!settings.data) return;
    applyTheme(settings.data.theme);
    setLang(settings.data.language === "vi" ? "vi" : "en");
  }, [settings.data?.theme, settings.data?.language]);

  // khôi phục các tab đã mở
  useEffect(() => {
    (async () => {
      try {
        const ws = await api.workspaceGet();
        const opened: RepoInfo[] = [];
        for (const p of ws.openTabs) {
          try {
            opened.push(await api.repoOpen(p));
          } catch {
            /* repo đã bị xoá/di chuyển */
          }
        }
        setTabs(opened);
        const act = ws.activeTab && opened.find((x) => x.id === ws.activeTab);
        setActive(act ? act.id : DASH);
        api.sessionSetActive(act ? act.id : null).catch(() => {});
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // sự kiện từ backend
  useEffect(() => {
    const a = listen<{ repoId: string; status: boolean; refs: boolean }>("repo:changed", (e) =>
      invalidateRepo(qc, e.payload.repoId, e.payload.refs ? "all" : "status"),
    );
    const b = listen<{ opId: string; line: string }>("op:progress", (e) => updateOpLine(e.payload.opId, e.payload.line));
    const onFocus = () => qc.invalidateQueries({ queryKey: ["status"] });
    window.addEventListener("focus", onFocus);
    return () => {
      a.then((f) => f());
      b.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, [qc]);

  const activeRepo = tabs.find((x) => x.id === active);
  useEffect(() => {
    getCurrentWindow()
      .setTitle(activeRepo ? `${activeRepo.name} — Git Cyclone` : "Git Cyclone")
      .catch(() => {});
  }, [activeRepo?.id]);

  const activate = useCallback((id: string) => {
    setActive(id);
    if (id !== SETTINGS) api.sessionSetActive(id === DASH ? null : id).catch(() => {});
  }, []);

  const openRepo = useCallback(
    async (path: string) => {
      try {
        const repo = await api.repoOpen(path);
        setTabs((x) => (x.some((y) => y.id === repo.id) ? x : [...x, repo]));
        activate(repo.id);
        qc.invalidateQueries({ queryKey: ["workspace"] });
      } catch (e) {
        toastError(e);
      }
    },
    [activate, qc],
  );

  const pickRepo = useCallback(async () => {
    const dir = await open({ directory: true, title: t("dash.pickRepo") });
    if (typeof dir === "string") openRepo(dir);
  }, [openRepo]);

  const closeTab = useCallback(
    async (id: string) => {
      await api.repoClose(id).catch(() => {});
      setTabs((x) => {
        const i = x.findIndex((y) => y.id === id);
        const next = x.filter((y) => y.id !== id);
        if (active === id) {
          const n = next[Math.min(i, next.length - 1)];
          activate(n ? n.id : DASH);
        }
        return next;
      });
      qc.removeQueries({ predicate: (q) => q.queryKey[1] === id });
    },
    [active, activate, qc],
  );

  const toggleSettings = useCallback(() => setActive((cur) => (cur === SETTINGS ? DASH : SETTINGS)), []);

  // lệnh toàn cục
  useEffect(
    () =>
      registerCommands("app", [
        { id: "dash", group: "goto", label: () => t("palette.workspace"), hint: "Ctrl+0", run: () => activate(DASH) },
        { id: "open", group: "goto", label: () => t("palette.openRepo"), hint: "Ctrl+O", run: pickRepo },
        ...tabs.map((x) => ({ id: `tab-${x.id}`, group: "goto" as const, label: () => t("palette.repoNamed", { name: x.name }), run: () => activate(x.id) })),
        { id: "settings", group: "app", label: () => t("palette.settings"), hint: "Ctrl+,", run: () => setActive(SETTINGS) },
        { id: "accounts", group: "app", label: () => t("palette.accounts"), run: () => accountsOpen.set(true) },
      ]),
    [tabs, activate, pickRepo],
  );

  // phím tắt toàn cục
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() === "o") (e.preventDefault(), pickRepo());
      else if (e.key.toLowerCase() === "w" && active !== DASH && active !== SETTINGS) (e.preventDefault(), closeTab(active));
      else if (e.key === "0") (e.preventDefault(), activate(DASH));
      else if (e.key === ",") (e.preventDefault(), setActive(SETTINGS));
      else if (e.key === "Tab") {
        e.preventDefault();
        const ids = [DASH, ...tabs.map((x) => x.id)];
        activate(ids[(Math.max(0, ids.indexOf(active)) + 1) % ids.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active, pickRepo, closeTab, activate]);

  const busyIds = ops.use((o) => new Set(o.map((x) => x.repoId)));
  const gitOk = !!info.data?.gitVersion;
  const gitVer = info.data?.gitVersion?.replace(/^git version /, "").replace(/\.windows.*$/, "");

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <img src={logoUrl} width={22} height={22} alt="" draggable={false} />
          <span>Git Cyclone</span>
        </div>
        <nav className="tabs" role="tablist" aria-label={tt("titlebar.openRepos")}>
          <button role="tab" aria-selected={active === DASH} className={active === DASH ? "tab tab-ws on" : "tab tab-ws"} onClick={() => activate(DASH)}>
            <Icon name="grid" size={15} />
            {tt("titlebar.workspace")}
          </button>
          {tabs.map((x) => (
            <RepoTab key={x.id} repo={x} on={active === x.id} busy={busyIds.has(x.id)} onActivate={() => activate(x.id)} onClose={() => closeTab(x.id)} onCloseOthers={() => tabs.filter((y) => y.id !== x.id).forEach((y) => closeTab(y.id))} />
          ))}
          <button className="icon-btn" style={{ alignSelf: "center" }} title={tt("titlebar.openRepo")} aria-label={tt("titlebar.openRepo")} onClick={pickRepo}>
            <Icon name="plus" size={16} />
          </button>
        </nav>
        <button className="cmd-btn" onClick={() => paletteOpen.set(true)}>
          <Icon name="search" size={14} />
          <span>{tt("titlebar.commands")}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="acc-chip" onClick={() => accountsOpen.set(gcm.length ? "github" : "identity")} title={tt("titlebar.accounts")}>
          {gcm.length ? <Avatar login={gcm[0].name} url={avatarUrl(gcm[0].name)} size={20} /> : <Icon name="user" size={15} style={{ marginLeft: 4 }} />}
          {ident?.name ?? tt("titlebar.signIn")}
        </button>
        <button
          className={active === SETTINGS ? "icon-btn on" : "icon-btn"}
          aria-label={tt("titlebar.settings")}
          aria-pressed={active === SETTINGS}
          title={`${tt("titlebar.settings")} (Ctrl+,)`}
          onClick={toggleSettings}
        >
          <Icon name="gear" size={17} />
        </button>
      </header>

      {info.data && !gitOk && <div className="banner banner-danger">{tt("app.gitMissing")}</div>}

      <main className="content">
        {!ready ? (
          <div className="center-msg muted">{tt("app.restoring")}</div>
        ) : (
          <>
            <div className="pane" hidden={active !== DASH}>
              <Dashboard onOpen={openRepo} />
            </div>
            {active === SETTINGS && (
              <div className="pane">
                <SettingsView />
              </div>
            )}
            {tabs.map((x) => (
              <div key={x.id} className="pane" hidden={active !== x.id}>
                <RepoView repo={x} active={active === x.id} />
              </div>
            ))}
          </>
        )}
      </main>
      <OpsBar />
      <footer className="statusbar">
        <span className="row" style={{ gap: 6 }}>
          <span className={gitOk ? "status-dot" : "status-dot bad"} aria-hidden />
          {gitOk ? tt("app.statusWatching", { version: gitVer }) : tt("app.statusNoGit")}
        </span>
        <span className="spacer" />
        {activeRepo && <span>{tt("app.shortcuts")}</span>}
      </footer>
      <Overlays />
      <FileInspectorHost />
      <AccountsHost />
      <Palette />
      <CloseDialog />
    </div>
  );
}

function RepoTab({
  repo,
  on,
  busy,
  onActivate,
  onClose,
  onCloseOthers,
}: {
  repo: RepoInfo;
  on: boolean;
  busy: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
}) {
  const tt = useT();
  const { data: status } = useStatus(repo.id);
  const dirty = (status?.entries.length ?? 0) > 0;
  return (
    <div
      role="tab"
      aria-selected={on}
      tabIndex={0}
      className={on ? "tab on" : "tab"}
      title={repo.path}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate()}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: t("titlebar.closeTab"), hint: "Ctrl+W", onClick: onClose },
          { label: t("titlebar.closeOthers"), onClick: onCloseOthers },
          { label: t("titlebar.openInExplorer"), onClick: () => api.revealPath(repo.path, "explorer").catch(toastError) },
        ])
      }
    >
      {busy ? <span className="spinner sm" aria-label={tt("titlebar.running")} /> : dirty && <span className="tab-dot" aria-label={tt("titlebar.uncommitted")} />}
      <span>{repo.name}</span>
      <button
        className="tab-close"
        aria-label={tt("titlebar.closeTabNamed", { name: repo.name })}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
