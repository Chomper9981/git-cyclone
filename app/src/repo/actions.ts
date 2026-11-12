import type { QueryClient } from "@tanstack/react-query";
import { accountsOpen } from "../Accounts";
import { api, toAppError } from "../api";
import { t } from "../i18n";
import type { Branch, Commit } from "../types";
import { shortSha } from "../ui/format";
import { confirmDialog, openDialog, promptDialog, runNetOp, toast, toastError } from "../ui/store";
import { invalidateRepo } from "./hooks";

async function askLogin(stderr: string | null) {
  const ok = await confirmDialog(t("actions.loginTitle"), t("actions.loginBody"), {
    confirmLabel: t("actions.openAccounts"),
    detail: stderr ?? undefined,
  });
  if (ok) accountsOpen.set("github");
}

/** Giống runNetOp nhưng ném lỗi ra để caller xử lý theo loại. */
async function runNetOpThrow<R>(repoId: string, label: string, fn: (op: string) => Promise<R>): Promise<R> {
  let err: unknown = null;
  const r = await runNetOp(repoId, label, async (op) => {
    try {
      return await fn(op);
    } catch (e) {
      err = e;
      return undefined;
    }
  });
  if (err) throw err;
  return r as R;
}

/** Các thao tác có hộp thoại xác nhận, dùng chung giữa sidebar, graph, thanh repo và bảng lệnh. */
export function repoActions(repoId: string, qc: QueryClient) {
  const refresh = () => invalidateRepo(qc, repoId);

  async function run(fn: () => Promise<unknown>, success?: string, errTitle?: string): Promise<boolean> {
    try {
      await fn();
      if (success) toast("success", success);
      return true;
    } catch (e) {
      const err = toAppError(e);
      if (err.kind === "dirtyWorktree") {
        const ok = await confirmDialog(t("actions.stashAndRetryTitle"), t("actions.stashAndRetryBody"), {
          confirmLabel: t("actions.stashAndRetry"),
          detail: err.stderr ?? undefined,
        });
        if (ok) {
          try {
            await api.stashPush(repoId, t("actions.autoStash"), true);
            await fn();
            toast("success", success ?? t("actions.done"), t("actions.doneStashed"));
            return true;
          } catch (e2) {
            toastError(e2, errTitle);
          }
        }
        return false;
      }
      if (err.kind === "mergeConflict") {
        toast("info", t("actions.conflictTitle"), t("actions.conflictBody"));
        return false;
      }
      toastError(e, errTitle);
      return false;
    } finally {
      await refresh();
    }
  }

  /** Lỗi mạng thường gặp: đăng nhập, đang khoá, huỷ. Trả true nếu đã xử lý. */
  async function handleNetError(e: unknown, action: string): Promise<boolean> {
    const err = toAppError(e);
    if (err.kind === "authRequired") return askLogin(err.stderr).then(() => true);
    if (err.kind === "cancelled") return true;
    toastError(e, t("errors.failed", { action }));
    return true;
  }

  const a = {
    run,
    refresh,

    async fetch() {
      try {
        const out = await runNetOpThrow(repoId, t("actions.fetch"), (op) => api.fetch(repoId, op));
        // dòng cập nhật ref của git fetch luôn chứa " -> "
        if (out.includes(" -> ")) toast("success", t("actions.fetched"));
        else toast("info", t("actions.fetchNothing"));
      } catch (e) {
        await handleNetError(e, t("actions.fetch"));
      } finally {
        await refresh();
      }
    },

    async pull(mode: string | null = null) {
      try {
        const out = await runNetOpThrow(repoId, t("actions.pull"), (op) => api.pull(repoId, op, mode));
        if (/Already up[ -]to[ -]date|is up to date/i.test(out)) toast("info", t("actions.pullNothing"));
        else toast("success", t("actions.pulled"));
      } catch (e) {
        const err = toAppError(e);
        if (err.kind === "nonFastForward") {
          const r = await openDialog({
            title: t("actions.divergedTitle"),
            message: t("actions.divergedBody"),
            fields: [
              {
                name: "mode",
                label: t("actions.pullMode"),
                type: "select",
                value: "rebase",
                options: [
                  { value: "rebase", label: t("actions.pullRebase") },
                  { value: "merge", label: t("actions.pullMerge") },
                ],
              },
            ],
            confirmLabel: t("actions.pull"),
          });
          if (r) await a.pull(String(r.mode));
        } else if (err.kind === "mergeConflict") {
          toast("info", t("actions.pullConflict"), t("actions.pullConflictBody"));
        } else await handleNetError(e, t("actions.pull"));
      } finally {
        await refresh();
      }
    },

    async push(force = false) {
      if (force) {
        const ok = await confirmDialog(t("actions.forceTitle"), t("actions.forceBody"), { danger: true, confirmLabel: t("actions.forcePush") });
        if (!ok) return;
      }
      const label = force ? t("actions.forcePush") : t("actions.push");
      try {
        const out = await runNetOpThrow(repoId, label, (op) => api.push(repoId, op, force));
        if (/Everything up-to-date/i.test(out)) toast("info", t("actions.pushNothing"));
        else toast("success", t("actions.pushed"));
      } catch (e) {
        const err = toAppError(e);
        if (err.kind === "nonFastForward") {
          const ok = await confirmDialog(t("actions.remoteAheadTitle"), t("actions.remoteAheadBody"), { confirmLabel: t("actions.pullThenPush") });
          if (ok) {
            await a.pull();
            await a.push();
          }
        } else await handleNetError(e, label);
      } finally {
        await refresh();
      }
    },

    async createBranch(start: string | null = null, label?: string) {
      const r = await openDialog({
        title: t("actions.newBranchTitle"),
        message: start ? t("actions.fromLabel", { label: label ?? shortSha(start) }) : t("actions.fromHead"),
        fields: [
          { name: "name", label: t("actions.branchName"), placeholder: "feature/my-branch", required: true },
          { name: "checkout", label: t("actions.switchToNew"), type: "checkbox", value: true },
        ],
        confirmLabel: t("actions.createBranch"),
      });
      if (!r) return;
      const name = String(r.name).trim();
      await run(() => api.createBranch(repoId, name, start, Boolean(r.checkout)), t("actions.branchCreated", { name }));
    },

    checkout: (b: Branch) =>
      run(() => api.checkoutBranch(repoId, b.name, b.remote), t("actions.switchedTo", { name: b.remote ? b.name.split("/").slice(1).join("/") : b.name })),

    async checkoutCommit(c: Commit) {
      const ok = await confirmDialog(t("actions.detachTitle"), t("actions.detachBody", { sha: shortSha(c.sha) }), { confirmLabel: t("actions.checkout") });
      if (ok) await run(() => api.checkoutCommit(repoId, c.sha), t("actions.checkedOut", { sha: shortSha(c.sha) }));
    },

    async renameBranch(b: Branch) {
      const name = await promptDialog(t("actions.renameTitle"), t("actions.newName"), b.name, { confirmLabel: t("actions.rename") });
      if (name && name !== b.name) await run(() => api.renameBranch(repoId, b.name, name), t("actions.renamed", { name }));
    },

    async deleteBranch(b: Branch) {
      if (b.remote) {
        const ok = await confirmDialog(t("actions.deleteRemoteTitle"), t("actions.deleteRemoteBody", { name: b.name }), {
          danger: true,
          confirmLabel: t("actions.deleteRemote"),
        });
        if (!ok) return;
        try {
          await runNetOpThrow(repoId, t("actions.deleteRemote"), (op) => api.deleteRemoteBranch(repoId, op, b.name));
        } catch (e) {
          await handleNetError(e, t("actions.deleteRemote"));
        }
        return refresh();
      }
      const ok = await confirmDialog(t("actions.deleteTitle"), t("actions.deleteBody", { name: b.name, sha: shortSha(b.sha) }), {
        danger: true,
        confirmLabel: t("actions.deleteBranch"),
      });
      if (!ok) return;
      try {
        await api.deleteBranch(repoId, b.name, false);
        toast("success", t("actions.deleted", { name: b.name }), t("actions.restoreHint", { sha: shortSha(b.sha) }));
      } catch (e) {
        const err = toAppError(e);
        if (err.stderr?.includes("not fully merged")) {
          const force = await confirmDialog(t("actions.unmergedTitle"), t("actions.unmergedBody", { name: b.name, sha: shortSha(b.sha) }), {
            danger: true,
            confirmLabel: t("actions.deleteAnyway"),
          });
          if (force) await run(() => api.deleteBranch(repoId, b.name, true), t("actions.deleted", { name: b.name }));
        } else toastError(e);
      } finally {
        await refresh();
      }
    },

    async merge(name: string, current: string | null) {
      const ok = await confirmDialog(t("actions.mergeTitle"), t("actions.mergeBody", { name, into: current ?? "HEAD" }), { confirmLabel: t("actions.merge") });
      if (!ok) return;
      let out = "";
      const done = await run(async () => {
        out = await api.merge(repoId, name);
      });
      if (!done) return;
      if (/Already up[ -]to[ -]date/i.test(out)) toast("info", t("actions.mergeNothing", { name }));
      else toast("success", t("actions.merged", { name }));
    },

    async rebase(onto: string, current: string | null) {
      const ok = await confirmDialog(t("actions.rebaseTitle"), t("actions.rebaseBody", { branch: current ?? "HEAD", onto }), { confirmLabel: t("actions.rebase") });
      if (!ok) return;
      let out = "";
      const done = await run(async () => {
        out = await api.rebase(repoId, onto);
      });
      if (!done) return;
      if (/is up to date/i.test(out)) toast("info", t("actions.rebaseNothing", { name: onto }));
      else toast("success", t("actions.rebased", { name: onto }));
    },

    cherryPick: (c: Commit) => run(() => api.cherryPick(repoId, c.sha), t("actions.cherryPicked", { sha: shortSha(c.sha) })),

    async revert(c: Commit) {
      const ok = await confirmDialog(t("actions.revertTitle"), t("actions.revertBody", { subject: c.subject }), { confirmLabel: t("actions.revert") });
      if (ok) await run(() => api.revert(repoId, c.sha), t("actions.reverted", { sha: shortSha(c.sha) }));
    },

    async reset(c: Commit, branch: string | null) {
      const r = await openDialog({
        title: t("actions.resetTitle", { branch: branch ?? "HEAD", sha: shortSha(c.sha) }),
        message: c.subject,
        fields: [
          {
            name: "mode",
            label: t("actions.resetMode"),
            type: "select",
            value: "mixed",
            options: [
              { value: "soft", label: t("actions.resetSoft") },
              { value: "mixed", label: t("actions.resetMixed") },
              { value: "hard", label: t("actions.resetHard") },
            ],
          },
        ],
        confirmLabel: t("actions.reset"),
        danger: true,
      });
      if (!r) return;
      let saved: string | null = null;
      const ok = await run(async () => {
        saved = await api.reset(repoId, c.sha, r.mode as "soft" | "mixed" | "hard");
      });
      if (ok) toast("success", t("actions.resetDone", { sha: shortSha(c.sha) }), saved ? t("actions.resetSaved") : undefined);
    },

    async undoLastCommit() {
      const ok = await confirmDialog(t("actions.undoTitle"), t("actions.undoBody"), { confirmLabel: t("actions.undo") });
      if (ok) await run(() => api.undoLastCommit(repoId), t("actions.undone"));
    },

    async createTag(c: Commit) {
      const r = await openDialog({
        title: t("actions.tagTitle", { sha: shortSha(c.sha) }),
        fields: [
          { name: "name", label: t("actions.tagName"), placeholder: "v1.0.0", required: true },
          { name: "message", label: t("actions.tagMessage"), type: "textarea" },
        ],
        confirmLabel: t("actions.createTag"),
      });
      if (!r) return;
      const name = String(r.name).trim();
      await run(() => api.createTag(repoId, name, c.sha, String(r.message) || null), t("actions.tagCreated", { name }));
    },

    async deleteTag(name: string) {
      const ok = await confirmDialog(t("actions.deleteTagTitle"), t("actions.deleteTagBody", { name }), { danger: true, confirmLabel: t("actions.deleteTag") });
      if (ok) await run(() => api.deleteTag(repoId, name), t("actions.tagDeleted", { name }));
    },

    async pushTag(name: string, remotes: string[]) {
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) return toast("error", t("actions.noRemote"));
      const label = t("actions.pushTag", { name });
      try {
        const out = await runNetOpThrow(repoId, label, (op) => api.pushTag(repoId, op, remote, name));
        if (/Everything up-to-date/i.test(out)) toast("info", t("actions.tagOnRemote", { name }));
        else toast("success", t("actions.pushed"));
      } catch (e) {
        await handleNetError(e, label);
      }
      await refresh();
    },

    async stash() {
      const r = await openDialog({
        title: t("actions.stashTitle"),
        fields: [
          { name: "message", label: t("actions.stashNote"), placeholder: t("actions.stashNotePh") },
          { name: "untracked", label: t("actions.stashUntracked"), type: "checkbox", value: true },
        ],
        confirmLabel: t("repo.stash"),
      });
      if (!r) return;
      let out = "";
      const done = await run(async () => {
        out = await api.stashPush(repoId, String(r.message) || null, Boolean(r.untracked));
      });
      if (!done) return;
      if (/No local changes to save/i.test(out)) toast("info", t("actions.stashNothing"));
      else toast("success", t("actions.stashed"));
    },

    stashApply: (index: number, pop: boolean) => run(() => api.stashApply(repoId, index, pop), pop ? t("actions.popped") : t("actions.applied")),

    async stashDrop(index: number, message: string) {
      const ok = await confirmDialog(t("actions.dropTitle"), t("actions.dropBody", { index, message }), { danger: true, confirmLabel: t("actions.dropStash") });
      if (ok) await run(() => api.stashDrop(repoId, index), t("actions.dropped"));
    },

    async addRemote() {
      const r = await openDialog({
        title: t("actions.remoteTitle"),
        fields: [
          { name: "name", label: t("actions.remoteName"), value: "origin", required: true },
          { name: "url", label: t("actions.remoteUrl"), placeholder: "https://github.com/user/repo.git", required: true },
        ],
        confirmLabel: t("actions.add"),
      });
      if (!r) return;
      const name = String(r.name).trim();
      await run(() => api.remoteAdd(repoId, name, String(r.url).trim()), t("actions.remoteAdded", { name }));
    },

    sequencer: (action: "continue" | "abort" | "skip") =>
      run(
        () => api.sequencer(repoId, action),
        action === "abort" ? t("actions.seqAbort") : action === "skip" ? t("actions.seqSkip") : t("actions.seqContinue"),
      ),
  };
  return a;
}

export type RepoActions = ReturnType<typeof repoActions>;
