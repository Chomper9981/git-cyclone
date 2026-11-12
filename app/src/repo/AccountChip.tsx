import { useQuery, useQueryClient } from "@tanstack/react-query";
import { accountsOpen, avatarUrl, usableAccounts, useGitEnv } from "../Accounts";
import { api } from "../api";
import { t, useT } from "../i18n";
import { Avatar, Icon } from "../ui/Icon";
import type { MenuItem } from "../ui/store";
import { showMenuBelow, toast, toastError } from "../ui/store";

export function useRepoAuth(repoId: string) {
  return useQuery({ queryKey: ["repoAuth", repoId], queryFn: () => api.repoAuth(repoId), staleTime: 30_000 });
}

/** Nút trên thanh repo: tài khoản GitHub (trong Git Credential Manager) mà repo dùng để push + danh tính commit. */
export function AccountChip({ repoId }: { repoId: string }) {
  const tt = useT();
  const qc = useQueryClient();
  const { data: auth } = useRepoAuth(repoId);
  const { data: env } = useGitEnv();
  const accounts = usableAccounts(env);
  // tài khoản thực tế: cấu hình riêng của repo, hoặc tài khoản GCM duy nhất
  const effective = auth?.account ?? (accounts.length === 1 ? accounts[0].name : null);
  const noEmail = !!auth && !auth.email;
  const refresh = () => qc.invalidateQueries({ queryKey: ["repoAuth", repoId] });

  const setAccount = async (account: string | null) => {
    try {
      await api.repoSetGithubAccount(repoId, account);
    } catch (e) {
      toastError(e);
    }
    refresh();
  };

  const applyIdentity = async (login: string) => {
    try {
      const u = await qc.fetchQuery({ queryKey: ["ghuser", login], queryFn: () => api.githubUser(login), staleTime: Infinity });
      await api.repoSetIdentity(repoId, u.name || u.login, u.noreplyEmail);
      toast("success", t("chip.identitySet", { login: u.login }), u.noreplyEmail);
    } catch (e) {
      toastError(e);
    }
    refresh();
  };

  const open = (el: Element) => {
    const check = (on: boolean) => (on ? "✓" : undefined);
    const items: MenuItem[] = [
      { label: t("chip.pushWith"), heading: true },
      { label: t("chip.auto"), hint: check(!auth?.account), onClick: () => setAccount(null) },
      ...accounts.map((a) => ({ label: `@${a.name}`, hint: check(auth?.account === a.name), onClick: () => setAccount(a.name) })),
      { separator: true },
      ...(effective ? [{ label: t("chip.commitAs", { login: effective }), onClick: () => applyIdentity(effective) }] : []),
      ...(auth?.emailScope === "local" ? [{ label: t("chip.clearIdentity"), onClick: () => api.repoClearIdentity(repoId).then(refresh, toastError) }] : []),
      { label: t("chip.manage"), onClick: () => accountsOpen.set("github") },
    ];
    showMenuBelow(el, items);
  };

  const remoteNote = auth && !auth.githubHttps ? (auth.githubSsh ? tt("chip.sshNote") : tt("chip.noGithub")) : "";
  const title = [
    effective ? tt("chip.tipAccount", { login: effective }) : tt("chip.tipAuto"),
    auth?.email ? tt("chip.tipCommit", { name: auth.name ?? "?", email: auth.email, scope: auth.emailScope ?? "?" }) : tt("chip.tipNoEmail"),
    remoteNote,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button className={noEmail ? "acc-chip warn-chip" : "acc-chip"} onClick={(e) => open(e.currentTarget)} title={title} aria-haspopup="menu">
      {effective ? <Avatar login={effective} url={avatarUrl(effective)} size={20} /> : <Icon name="user" size={16} style={{ marginLeft: 4, color: "var(--text3)" }} />}
      <span>{effective ? `@${effective}` : tt("chip.system")}</span>
      {noEmail && (
        <span className="warn" aria-label={tt("chip.warning")}>
          <Icon name="warn" size={14} />
        </span>
      )}
      <Icon name="chevDown" size={13} style={{ color: "var(--text3)" }} />
    </button>
  );
}
