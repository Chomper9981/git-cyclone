import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api, newOpId, toAppError } from "./api";
import { t, useT } from "./i18n";
import type { GcmAccount, GitEnvStatus, IdentityProfile } from "./types";
import { createStore } from "./ui/createStore";
import { copyText } from "./ui/format";
import { Avatar, Icon } from "./ui/Icon";
import { cancelOp, confirmDialog, toast, toastError } from "./ui/store";

type Tab = "identity" | "github" | "ssh";

/** Mở hộp thoại "Git & tài khoản": true = tab GitHub, hoặc tên tab. */
export const accountsOpen = createStore<false | true | Tab>(false);

export function useGitEnv() {
  return useQuery({ queryKey: ["gitenv"], queryFn: api.gitenvStatus, staleTime: 60_000 });
}

/** Hồ sơ công khai GitHub (avatar, email noreply) — chỉ gọi khi cần. */
export function useGithubUser(login: string | null | undefined) {
  return useQuery({
    queryKey: ["ghuser", login],
    queryFn: () => api.githubUser(login!),
    enabled: !!login,
    staleTime: Infinity,
    retry: false,
  });
}

/** Tài khoản GCM dùng được (bỏ các mục trông như token). */
export function usableAccounts(env: GitEnvStatus | undefined): GcmAccount[] {
  return env?.accounts.filter((a) => !a.looksLikeToken) ?? [];
}

export const avatarUrl = (login: string) => `https://github.com/${encodeURIComponent(login)}.png`;

export function AccountsHost() {
  const o = accountsOpen.use((x) => x);
  if (!o) return null;
  return <GitEnvDialog initial={o === true ? "github" : o} onClose={() => accountsOpen.set(false)} />;
}

function GitEnvDialog({ initial, onClose }: { initial: Tab; onClose: () => void }) {
  const tt = useT();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>(initial);
  const { data: env, isFetching } = useGitEnv();
  const refresh = () => qc.invalidateQueries({ queryKey: ["gitenv"] }).then(() => qc.invalidateQueries({ queryKey: ["repoAuth"] }));
  useEffect(() => void refresh(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-md" style={{ width: "min(720px, 100%)" }} role="dialog" aria-modal="true" aria-labelledby="ge-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <Icon name="branch" size={20} />
          <h2 id="ge-title" className="modal-title">
            {tt("gitenv.title")}
          </h2>
          <button className="icon-btn" aria-label={tt("gitenv.refresh")} title={tt("gitenv.refresh")} onClick={refresh}>
            {isFetching ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
          </button>
          <button className="icon-btn" aria-label={tt("common.close")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="modal-msg small">{tt("gitenv.intro")}</p>
        <div className="seg" role="tablist" style={{ alignSelf: "flex-start" }}>
          {(["identity", "github", "ssh"] as Tab[]).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
              <Icon name={x === "identity" ? "user" : x === "github" ? "github" : "key"} size={15} />
              {tt(`gitenv.tabs.${x}`)}
            </button>
          ))}
        </div>
        {!env ? (
          <div className="acc-empty">{tt("common.loading")}</div>
        ) : tab === "identity" ? (
          <IdentityTab env={env} onChanged={refresh} />
        ) : tab === "github" ? (
          <GithubTab env={env} onChanged={refresh} />
        ) : (
          <SshTab env={env} onChanged={refresh} />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Danh tính

function IdentityTab({ env, onChanged }: { env: GitEnvStatus; onChanged: () => void }) {
  const tt = useT();
  const [name, setName] = useState(env.identity.name ?? "");
  const [email, setEmail] = useState(env.identity.email ?? "");
  const [folder, setFolder] = useState("");
  const [pName, setPName] = useState(env.identity.name ?? "");
  const [pEmail, setPEmail] = useState("");
  const dirty = name !== (env.identity.name ?? "") || email !== (env.identity.email ?? "");

  const saveGlobal = async () => {
    try {
      await api.identitySetGlobal(name, email);
      toast("success", t("gitenv.identity.saved"));
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const pick = async () => {
    const dir = await open({ directory: true, title: t("gitenv.identity.pickTitle") });
    if (typeof dir === "string") setFolder(dir);
  };
  const addProfile = async () => {
    try {
      const p = await api.identityProfileAdd(folder, pName, pEmail);
      toast("success", t("gitenv.identity.profileAdded", { folder: p.folder }));
      setFolder("");
      setPEmail("");
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const removeProfile = async (p: IdentityProfile) => {
    const ok = await confirmDialog(t("gitenv.identity.removeTitle"), t("gitenv.identity.removeBody", { folder: p.folder }), {
      danger: true,
      confirmLabel: t("gitenv.identity.removeProfile"),
    });
    if (!ok) return;
    try {
      await api.identityProfileRemove(p.condition);
      toast("success", t("gitenv.identity.profileRemoved"));
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="acc-config">
        <b>{tt("gitenv.identity.global")}</b>
        <span className="small muted">{tt("gitenv.identity.globalHint")}</span>
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="field" style={{ flex: "1 1 180px" }}>
            <span className="field-label">{tt("gitenv.identity.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <label className="field" style={{ flex: "2 1 260px" }}>
            <span className="field-label">{tt("gitenv.identity.email")}</span>
            <input className="mono" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
          </label>
          <button className="btn btn-primary" style={{ alignSelf: "flex-end" }} disabled={!dirty || !name.trim() || !email.trim()} onClick={saveGlobal}>
            {tt("gitenv.identity.save")}
          </button>
        </div>
        <span className="small dim">{tt("gitenv.identity.noreplyHint")}</span>
      </section>

      <section className="col" style={{ gap: 8 }}>
        <b>{tt("gitenv.identity.profiles")}</b>
        <span className="small muted">{tt("gitenv.identity.profilesHint")}</span>
        <div className="acc-list">
          {env.profiles.length === 0 && <div className="acc-empty">{tt("gitenv.identity.noProfiles")}</div>}
          {env.profiles.map((p) => (
            <div key={p.condition} className="acc-row">
              <Icon name="folder" size={18} style={{ color: "var(--text3)" }} />
              <div className="acc-info">
                <span className="mono small ellipsis" title={p.folder}>
                  {p.folder}
                </span>
                <span className="small muted ellipsis">
                  {p.name ?? "?"} &lt;{p.email ?? "?"}&gt;
                </span>
              </div>
              <button className="btn btn-sm btn-ghost-danger" onClick={() => removeProfile(p)}>
                {tt("gitenv.identity.removeProfile")}
              </button>
            </div>
          ))}
        </div>
        <div className="acc-config">
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={pick}>
              <Icon name="folder" size={14} />
              {tt("gitenv.identity.pickFolder")}
            </button>
            <span className="mono small ellipsis" style={{ flex: 1 }} title={folder}>
              {folder || "—"}
            </span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="field" style={{ flex: "1 1 160px" }}>
              <span className="field-label">{tt("gitenv.identity.name")}</span>
              <input value={pName} onChange={(e) => setPName(e.target.value)} spellCheck={false} />
            </label>
            <label className="field" style={{ flex: "2 1 240px" }}>
              <span className="field-label">{tt("gitenv.identity.email")}</span>
              <input className="mono" value={pEmail} onChange={(e) => setPEmail(e.target.value)} spellCheck={false} />
            </label>
            <button className="btn" style={{ alignSelf: "flex-end" }} disabled={!folder || !pName.trim() || !pEmail.trim()} onClick={addProfile}>
              <Icon name="plus" size={14} />
              {tt("gitenv.identity.addProfile")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ GitHub (GCM)

function GithubTab({ env, onChanged }: { env: GitEnvStatus; onChanged: () => void }) {
  const tt = useT();
  const [opId, setOpId] = useState<string | null>(null);
  const helperOk = env.credentialHelpers.some((h) => /manager/i.test(h));
  const gcmInstalled = !!env.gcmVersion;

  const signIn = async () => {
    const id = newOpId();
    setOpId(id);
    try {
      await api.gcmLogin(id);
      toast("success", t("gitenv.github.signedIn"));
    } catch (e) {
      if (toAppError(e).kind !== "cancelled") toastError(e);
    } finally {
      setOpId(null);
      onChanged();
    }
  };

  const signOut = async (a: GcmAccount) => {
    const ok = await confirmDialog(t("gitenv.github.signOutTitle", { name: a.display }), t("gitenv.github.signOutBody"), {
      danger: true,
      confirmLabel: a.looksLikeToken ? t("gitenv.github.remove") : t("gitenv.github.signOut"),
    });
    if (!ok) return;
    try {
      await api.gcmLogout(a.name);
      toast("success", t("gitenv.github.signedOut"));
    } catch (e) {
      toastError(e);
    }
    onChanged();
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {!gcmInstalled ? (
        <div className="banner banner-danger" style={{ borderRadius: 8, border: 0 }}>
          <Icon name="warn" size={15} />
          <span className="small">
            {tt("gitenv.github.gcmMissing")}{" "}
            <a href="https://github.com/git-ecosystem/git-credential-manager/blob/release/docs/install.md" target="_blank" rel="noreferrer">
              {tt("gitenv.github.gcmInstall")}
            </a>
          </span>
        </div>
      ) : (
        !helperOk && (
          <div className="banner banner-danger" style={{ borderRadius: 8, border: 0 }}>
            <Icon name="warn" size={15} />
            <span className="small">{tt("gitenv.github.helperMissing")}</span>
          </div>
        )
      )}
      <div className="row">
        <b style={{ flex: 1 }}>{tt("gitenv.github.accounts")}</b>
        {env.gcmVersion && <span className="small dim">{tt("gitenv.github.gcmVersion", { version: env.gcmVersion })}</span>}
      </div>
      <span className="small muted">{tt("gitenv.github.accountsHint")}</span>
      <div className="acc-list">
        {env.accounts.length === 0 && <div className="acc-empty">{tt("gitenv.github.none")}</div>}
        {env.accounts.map((a) => (
          <div key={a.name} className="acc-row">
            {a.looksLikeToken ? (
              <Icon name="warn" size={22} style={{ color: "var(--amber)" }} />
            ) : (
              <Avatar login={a.name} url={avatarUrl(a.name)} size={34} />
            )}
            <div className="acc-info">
              <div className="row wrap" style={{ gap: 8 }}>
                <b className={a.looksLikeToken ? "mono" : undefined}>{a.looksLikeToken ? a.display : `@${a.name}`}</b>
                {a.looksLikeToken && <span className="pill pill-warn">{tt("gitenv.github.tokenEntry")}</span>}
              </div>
              {a.looksLikeToken && <span className="small muted">{tt("gitenv.github.tokenHint")}</span>}
            </div>
            <button className="btn btn-sm btn-ghost-danger" onClick={() => signOut(a)}>
              {a.looksLikeToken ? tt("gitenv.github.remove") : tt("gitenv.github.signOut")}
            </button>
          </div>
        ))}
      </div>
      {opId ? (
        <div className="flow" style={{ padding: 14 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="spinner" aria-hidden />
            <span className="small" style={{ flex: 1 }}>
              {tt("gitenv.github.signingIn")}
            </span>
            <button className="btn btn-sm" onClick={() => cancelOp(opId)}>
              {tt("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <span className="spacer" />
          <button className="btn btn-primary" onClick={signIn} disabled={!gcmInstalled}>
            <Icon name="github" size={15} />
            {tt("gitenv.github.signIn")}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ SSH

function SshTab({ env, onChanged }: { env: GitEnvStatus; onChanged: () => void }) {
  const tt = useT();
  const taken = new Set(env.sshKeys.map((k) => k.name));
  const [name, setName] = useState(taken.has("id_ed25519") ? "id_ed25519_github" : "id_ed25519");
  const [comment, setComment] = useState(env.identity.email ?? "");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);

  const copyKey = async (n: string) => {
    try {
      const key = await api.sshPublicKey(n);
      if (await copyText(key)) toast("success", t("gitenv.ssh.copied"));
    } catch (e) {
      toastError(e);
    }
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await api.sshTest("github.com"));
    } catch (e) {
      setTest(null);
      toastError(e);
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const k = await api.sshGenerate(name.trim(), comment.trim(), pass);
      setPass("");
      toast("success", t("gitenv.ssh.created", { name: k.name }));
      onChanged();
      await copyKey(k.name);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap">
        <b style={{ flex: 1 }}>{tt("gitenv.ssh.keys")}</b>
        <button className="btn btn-sm" onClick={runTest} disabled={test === "running"}>
          {test === "running" ? <span className="spinner sm" aria-hidden /> : <Icon name="external" size={14} />}
          {tt("gitenv.ssh.test")}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => openUrl("https://github.com/settings/keys")}>
          {tt("gitenv.ssh.addOnGithub")}
        </button>
      </div>
      <span className="small muted">{tt("gitenv.ssh.keysHint", { dir: env.sshDir })}</span>
      {test && test !== "running" && (
        <div className={test.ok ? "banner" : "banner banner-danger"} style={{ borderRadius: 8, border: 0, background: test.ok ? "var(--green-soft)" : undefined }} role="status">
          <Icon name={test.ok ? "check" : "warn"} size={15} />
          <b className="small">{test.ok ? tt("gitenv.ssh.testOk") : tt("gitenv.ssh.testFail")}</b>
          <span className="small mono ellipsis" style={{ flex: 1 }} title={test.message}>
            {test.message}
          </span>
        </div>
      )}
      {test === "running" && <span className="small dim">{tt("gitenv.ssh.testing")}</span>}
      <div className="acc-list">
        {env.sshKeys.length === 0 && <div className="acc-empty">{tt("gitenv.ssh.none")}</div>}
        {env.sshKeys.map((k) => (
          <div key={k.path} className="acc-row">
            <Icon name="key" size={20} style={{ color: "var(--text3)" }} />
            <div className="acc-info">
              <div className="row wrap" style={{ gap: 8 }}>
                <b className="mono">{k.name}</b>
                <span className="pill">{k.kind.replace(/^ssh-/, "")}</span>
                {k.comment && <span className="small muted ellipsis">{k.comment}</span>}
              </div>
              {k.fingerprint && <span className="mono small dim ellipsis">{k.fingerprint}</span>}
            </div>
            <button className="btn btn-sm" onClick={() => copyKey(k.name)}>
              <Icon name="copy" size={14} />
              {tt("gitenv.ssh.copy")}
            </button>
          </div>
        ))}
      </div>
      <div className="acc-config">
        <b>{tt("gitenv.ssh.generate")}</b>
        <span className="small muted">{tt("gitenv.ssh.generateHint")}</span>
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="field" style={{ flex: "1 1 160px" }}>
            <span className="field-label">{tt("gitenv.ssh.keyName")}</span>
            <input className="mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <label className="field" style={{ flex: "2 1 220px" }}>
            <span className="field-label">{tt("gitenv.ssh.comment")}</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} spellCheck={false} />
          </label>
          <label className="field" style={{ flex: "1 1 160px" }}>
            <span className="field-label">{tt("gitenv.ssh.passphrase")}</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="btn btn-primary" style={{ alignSelf: "flex-end" }} disabled={busy || !name.trim() || taken.has(name.trim())} onClick={create}>
            {busy && <span className="spinner sm" aria-hidden />}
            {tt("gitenv.ssh.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
