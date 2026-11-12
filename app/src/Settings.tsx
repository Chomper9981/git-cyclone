import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { accountsOpen, avatarUrl, usableAccounts, useGitEnv } from "./Accounts";
import { api, toAppError } from "./api";
import { LANGS, setLang, useT, type Lang } from "./i18n";
import { applyTheme } from "./theme";
import type { Settings } from "./types";
import { joinPath } from "./ui/format";
import { Avatar, Icon, Oct } from "./ui/Icon";
import type { IconName } from "./ui/icons";
import { errorMessage, toast, toastError } from "./ui/store";

type SectionId = "general" | "git" | "workspace" | "accounts" | "window" | "data";

const SECTIONS: { id: SectionId; icon: IconName }[] = [
  { id: "general", icon: "gear" },
  { id: "git", icon: "branch" },
  { id: "workspace", icon: "grid" },
  { id: "accounts", icon: "user" },
  { id: "window", icon: "window" },
  { id: "data", icon: "database" },
];

const SKIPPED = ["node_modules", "target", ".venv", "venv", "dist", "build", ".cache"];
const MIN_DEPTH = 1;
const MAX_DEPTH = 8;

/** Mini preview colours for the theme cards (fixed: they depict each theme, not the current one). */
const PREVIEWS: Record<Settings["theme"], { bg: string; side: string; line: string }> = {
  dark: { bg: "#0B1220", side: "#152038", line: "#2A3956" },
  light: { bg: "#F6F8FB", side: "#E3E8F0", line: "#C9D2DF" },
  system: { bg: "linear-gradient(90deg,#0B1220 50%,#F6F8FB 50%)", side: "#152038", line: "#7C8BA1" },
};

export function SettingsView() {
  const t = useT();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settingsGet });
  const info = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo, staleTime: Infinity });
  const gitenv = useGitEnv();

  const [active, setActive] = useState<SectionId>("general");
  const mainRef = useRef<HTMLElement>(null);
  const jumpUntil = useRef(0);

  const save = async (patch: Partial<Settings>) => {
    const cur = qc.getQueryData<Settings>(["settings"]) ?? settings.data;
    if (!cur) return;
    const next = { ...cur, ...patch };
    try {
      await api.settingsSet(next);
      qc.setQueryData(["settings"], next);
    } catch (e) {
      toastError(e);
    }
  };

  const onScroll = () => {
    const main = mainRef.current;
    if (!main || Date.now() < jumpUntil.current) return;
    const top = main.getBoundingClientRect().top;
    let cur: SectionId = SECTIONS[0].id;
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1].id;
    else
      for (const s of SECTIONS) {
        const el = document.getElementById(`set-${s.id}`);
        if (el && el.getBoundingClientRect().top - top <= 48) cur = s.id;
      }
    setActive(cur);
  };

  const jump = (id: SectionId) => {
    setActive(id);
    jumpUntil.current = Date.now() + 700;
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const s = settings.data;
  const depth = s?.scanDepth ?? 4;
  const setDepth = (n: number) => {
    if (!Number.isFinite(n)) return;
    const v = Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(n)));
    if (v !== depth) save({ scanDepth: v });
  };

  const gcmAccounts = usableAccounts(gitenv.data);
  const dataDir = info.data?.dataDir;
  const trayOk = info.data?.trayAvailable !== false;

  return (
    <div className="settings">
      <nav className="set-nav" aria-label={t("settings.sections")}>
        <h1>{t("settings.title")}</h1>
        {SECTIONS.map((sec) => {
          const on = active === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              className={on ? "on" : undefined}
              aria-current={on ? "true" : undefined}
              onClick={() => jump(sec.id)}
            >
              <span className="marker">{on && <Oct size={8} color="var(--brand)" />}</span>
              <Icon name={sec.icon} size={16} />
              {t(`settings.nav.${sec.id}`)}
            </button>
          );
        })}
        <span className="spacer" />
        <p className="dim small" style={{ margin: "14px 12px 0" }}>
          {t("settings.autosave")}
          {info.data?.version && (
            <>
              <br />
              Git Cyclone {info.data.version}
            </>
          )}
        </p>
      </nav>

      <main className="set-main" ref={mainRef} onScroll={onScroll}>
        {!s ? (
          <div className="center-msg dim">{settings.isError ? errorMessage(toAppError(settings.error)) : t("common.loading")}</div>
        ) : (
          <div className="set-inner">
            <Section id="general">
              <Row label={t("settings.language.label")} hint={t("settings.language.hint")}>
                <Seg
                  name="language"
                  label={t("settings.language.label")}
                  value={s.language}
                  options={LANGS.map((l) => ({ value: l.id, label: l.label, lang: l.id }))}
                  onChange={(l: Lang) => {
                    setLang(l);
                    save({ language: l });
                  }}
                />
              </Row>
              <Row label={t("settings.theme.label")} hint={t("settings.theme.hint")}>
                <div className="row" role="radiogroup" aria-label={t("settings.theme.label")} style={{ gap: 10 }}>
                  {(["dark", "light", "system"] as const).map((th) => {
                    const on = s.theme === th;
                    const p = PREVIEWS[th];
                    return (
                      <button
                        key={th}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={on ? "theme-card on" : "theme-card"}
                        onClick={() => {
                          applyTheme(th);
                          save({ theme: th });
                        }}
                      >
                        <span className="theme-prev" aria-hidden style={{ background: p.bg }}>
                          <span style={{ width: 26, borderRadius: 3, background: p.side }} />
                          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ height: 7, borderRadius: 2, background: p.line }} />
                            <span style={{ height: 7, width: "70%", borderRadius: 2, background: p.line }} />
                            <span style={{ height: 7, width: "50%", borderRadius: 2, background: "#38BDF8" }} />
                          </span>
                          {on && (
                            <span className="theme-tick">
                              <Icon name="check" size={11} stroke={3} />
                            </span>
                          )}
                        </span>
                        <span>{t(`settings.theme.${th}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </Row>
            </Section>

            <Section id="git">
              <Row label={t("settings.git.exe")} hint={t("settings.git.exeHint")}>
                {info.data?.gitVersion ? (
                  <>
                    <span className="mono small selectable">{info.data.gitVersion}</span>
                    <span className="pill pill-ok">
                      <Icon name="check" size={12} stroke={2.6} />
                      {t("settings.git.found")}
                    </span>
                  </>
                ) : info.data ? (
                  <span className="pill pill-danger">
                    <Icon name="warn" size={12} stroke={2.2} />
                    {t("settings.git.missing")}
                  </span>
                ) : (
                  <span className="spinner" aria-label={t("common.loading")} />
                )}
              </Row>
              <Row label={t("settings.git.pull")} hint={t("settings.git.pullHint")}>
                <Seg
                  name="pullMode"
                  label={t("settings.git.pull")}
                  value={s.pullMode}
                  options={[
                    { value: "ff-only", label: t("settings.git.ff") },
                    { value: "rebase", label: t("settings.git.rebase") },
                    { value: "merge", label: t("settings.git.merge") },
                  ]}
                  onChange={(v: Settings["pullMode"]) => save({ pullMode: v })}
                />
              </Row>
              <Row label={t("settings.git.fetch")} hint={t("settings.git.fetchHint")}>
                <Seg
                  name="autoFetch"
                  label={t("settings.git.fetch")}
                  value={s.autoFetchMinutes}
                  options={[0, 5, 15, 30].map((n) => ({
                    value: n,
                    label: n === 0 ? t("settings.git.off") : t("settings.git.minutes", { n }),
                  }))}
                  onChange={(n: number) => save({ autoFetchMinutes: n })}
                />
              </Row>
            </Section>

            <Section id="workspace">
              <Row label={t("settings.workspace.depth")} hint={t("settings.workspace.depthHint")}>
                <div className="stepper">
                  <button
                    type="button"
                    aria-label={t("settings.workspace.less")}
                    disabled={depth <= MIN_DEPTH}
                    onClick={() => setDepth(depth - 1)}
                  >
                    −
                  </button>
                  <label htmlFor="scan-depth" className="sr-only">
                    {t("settings.workspace.depth")}
                  </label>
                  <input
                    id="scan-depth"
                    type="text"
                    inputMode="numeric"
                    value={depth}
                    onChange={(e) => setDepth(parseInt(e.target.value, 10))}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp") (e.preventDefault(), setDepth(depth + 1));
                      if (e.key === "ArrowDown") (e.preventDefault(), setDepth(depth - 1));
                    }}
                  />
                  <button
                    type="button"
                    aria-label={t("settings.workspace.moreDepth")}
                    disabled={depth >= MAX_DEPTH}
                    onClick={() => setDepth(depth + 1)}
                  >
                    +
                  </button>
                </div>
              </Row>
              <Row label={t("settings.workspace.skipped")} hint={t("settings.workspace.skippedHint")}>
                {SKIPPED.map((d) => (
                  <span key={d} className="tagchip">
                    {d}
                  </span>
                ))}
              </Row>
            </Section>

            <Section id="accounts">
              <Row label={t("settings.accounts.github")} hint={t("settings.accounts.githubHint")}>
                {gcmAccounts.length ? (
                  <span className="row wrap" style={{ gap: 10 }}>
                    {gcmAccounts.map((a) => (
                      <span key={a.name} className="row" style={{ gap: 6 }}>
                        <Avatar login={a.name} url={avatarUrl(a.name)} size={22} />
                        <span style={{ fontWeight: 600 }}>@{a.name}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="dim small">{t("settings.accounts.none")}</span>
                )}
                <button type="button" className="btn btn-sm" onClick={() => accountsOpen.set(true)}>
                  <Icon name="user" size={14} />
                  {t("settings.accounts.manage")}
                </button>
              </Row>
            </Section>

            <Section id="window">
              <Row label={t("settings.window.close")} hint={t(trayOk ? "settings.window.closeHint" : "settings.window.noTray")}>
                <Seg
                  name="closeAction"
                  label={t("settings.window.close")}
                  value={s.closeAction}
                  options={[
                    { value: "ask", label: t("settings.window.ask") },
                    { value: "tray", label: t(trayOk ? "settings.window.tray" : "settings.window.minimize") },
                    { value: "quit", label: t("settings.window.quit") },
                  ]}
                  onChange={(v: Settings["closeAction"]) => save({ closeAction: v })}
                />
              </Row>
            </Section>

            <Section id="data">
              <Row label={t("settings.data.backups")} hint={t("settings.data.backupsHint")}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!dataDir}
                  onClick={() =>
                    dataDir && api.revealPath(joinPath(dataDir, "trash"), "explorer").catch(() => toast("info", t("settings.data.noBackups")))
                  }
                >
                  <Icon name="folder" size={14} />
                  {t("settings.data.openBackups")}
                </button>
              </Row>
              <Row label={t("settings.data.reset")} hint={t("settings.data.resetHint")}>
                <AlwaysOn />
              </Row>
              <Row label={t("settings.data.force")} hint={t("settings.data.forceHint")}>
                <AlwaysOn />
              </Row>
              <Row label={t("settings.data.folder")} hint={t("settings.data.folderHint")}>
                <span className="mono small selectable" style={{ wordBreak: "break-all" }}>
                  {dataDir ?? "—"}
                </span>
              </Row>
            </Section>
          </div>
        )}
      </main>
    </div>
  );
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const t = useT();
  return (
    <section className="set-group" id={`set-${id}`} aria-labelledby={`set-${id}-h`} style={{ scrollMarginTop: 8 }}>
      <h2 id={`set-${id}-h`}>{t(`settings.nav.${id}`)}</h2>
      <p>{t(`settings.${id}.desc`)}</p>
      <div className="set-card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <span>{label}</span>
        <span>{hint}</span>
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function Seg<V extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: V;
  options: { value: V; label: string; lang?: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label key={String(o.value)} className={on ? "on" : undefined} lang={o.lang}>
            <input type="radio" name={name} value={String(o.value)} checked={on} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

function AlwaysOn() {
  const t = useT();
  return (
    <span className="row ok-text small" style={{ gap: 6, fontWeight: 600 }}>
      <Icon name="shield" size={14} />
      {t("settings.data.always")}
    </span>
  );
}
