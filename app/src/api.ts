import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

/** Chuẩn hoá lỗi từ Rust (AppError) hoặc lỗi JS. */
export function toAppError(e: unknown): T.AppError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as T.AppError;
  return { kind: "unknown", message: String(e), stderr: null, args: null };
}

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

let opSeq = 0;
export const newOpId = () => `op-${Date.now()}-${++opSeq}`;

export const api = {
  appInfo: () => call<T.AppInfo>("app_info"),
  revealPath: (path: string, target: "explorer" | "terminal" | "vscode") => call<void>("reveal_path", { path, target }),

  repoOpen: (path: string) => call<T.RepoInfo>("repo_open", { path }),
  repoClose: (repoId: string) => call<void>("repo_close", { repoId }),
  sessionSetActive: (repoId: string | null) => call<void>("session_set_active", { repoId }),

  status: (repoId: string) => call<T.RepoStatus>("status_get", { repoId }),
  graph: (repoId: string, limit: number) => call<T.Graph>("graph_get", { repoId, limit }),
  commitDetail: (repoId: string, sha: string) => call<T.CommitDetail>("commit_detail", { repoId, sha }),
  commitFileDiff: (repoId: string, sha: string, path: string, origPath: string | null) =>
    call<T.FileDiff>("commit_file_diff", { repoId, sha, path, origPath }),
  worktreeDiff: (repoId: string, path: string, origPath: string | null, staged: boolean, untracked: boolean) =>
    call<T.FileDiff>("worktree_diff", { repoId, path, origPath, staged, untracked }),
  refs: (repoId: string) => call<T.Refs>("refs_get", { repoId }),
  fileHistory: (repoId: string, path: string) => call<T.Commit[]>("file_history", { repoId, path }),
  blame: (repoId: string, path: string, rev: string | null) => call<T.BlameLine[]>("blame_get", { repoId, path, rev }),
  headMessage: (repoId: string) => call<string>("head_message", { repoId }),
  conflict: (repoId: string, path: string) => call<T.ConflictFile>("conflict_get", { repoId, path }),

  stageFiles: (repoId: string, paths: string[]) => call<void>("stage_files", { repoId, paths }),
  unstageFiles: (repoId: string, paths: string[]) => call<void>("unstage_files", { repoId, paths }),
  stageLines: (repoId: string, path: string, selections: T.HunkSelection[]) =>
    call<void>("stage_lines", { repoId, path, selections }),
  unstageLines: (repoId: string, path: string, selections: T.HunkSelection[]) =>
    call<void>("unstage_lines", { repoId, path, selections }),
  discardLines: (repoId: string, path: string, selections: T.HunkSelection[]) =>
    call<void>("discard_lines", { repoId, path, selections }),
  discardFiles: (repoId: string, paths: string[]) => call<string>("discard_files", { repoId, paths }),
  commit: (repoId: string, message: string, amend: boolean) => call<string>("commit_create", { repoId, message, amend }),
  undoLastCommit: (repoId: string) => call<void>("commit_undo_last", { repoId }),

  checkoutBranch: (repoId: string, name: string, remote: boolean) => call<void>("branch_checkout", { repoId, name, remote }),
  checkoutCommit: (repoId: string, sha: string) => call<void>("commit_checkout", { repoId, sha }),
  createBranch: (repoId: string, name: string, start: string | null, checkout: boolean) =>
    call<void>("branch_create", { repoId, name, start, checkout }),
  renameBranch: (repoId: string, old: string, newName: string) => call<void>("branch_rename", { repoId, old, new: newName }),
  deleteBranch: (repoId: string, name: string, force: boolean) => call<void>("branch_delete", { repoId, name, force }),
  createTag: (repoId: string, name: string, target: string, message: string | null) =>
    call<void>("tag_create", { repoId, name, target, message }),
  deleteTag: (repoId: string, name: string) => call<void>("tag_delete", { repoId, name }),
  stashPush: (repoId: string, message: string | null, includeUntracked: boolean, paths: string[] = []) =>
    call<string>("stash_push", { repoId, message, includeUntracked, paths }),
  stashApply: (repoId: string, index: number, pop: boolean) => call<void>("stash_apply", { repoId, index, pop }),
  stashDrop: (repoId: string, index: number) => call<void>("stash_drop", { repoId, index }),
  remoteAdd: (repoId: string, name: string, url: string) => call<void>("remote_add", { repoId, name, url }),

  merge: (repoId: string, name: string) => call<string>("merge_branch", { repoId, name }),
  rebase: (repoId: string, onto: string) => call<string>("rebase_onto", { repoId, onto }),
  cherryPick: (repoId: string, sha: string) => call<void>("cherry_pick", { repoId, sha }),
  revert: (repoId: string, sha: string) => call<void>("revert_commit", { repoId, sha }),
  sequencer: (repoId: string, action: "continue" | "abort" | "skip") => call<void>("sequencer", { repoId, action }),
  reset: (repoId: string, target: string, mode: "soft" | "mixed" | "hard") =>
    call<string | null>("reset_to", { repoId, target, mode }),
  conflictResolve: (repoId: string, path: string, content: string) =>
    call<void>("conflict_resolve", { repoId, path, content }),
  conflictTake: (repoId: string, path: string, side: "ours" | "theirs") => call<void>("conflict_take", { repoId, path, side }),

  opCancel: (opId: string) => call<void>("op_cancel", { opId }),
  fetch: (repoId: string, opId: string, remote: string | null = null) => call<string>("remote_fetch", { repoId, remote, opId }),
  pull: (repoId: string, opId: string, mode: string | null = null) => call<string>("remote_pull", { repoId, mode, opId }),
  push: (repoId: string, opId: string, force = false) => call<string>("remote_push", { repoId, force, opId }),
  pushTag: (repoId: string, opId: string, remote: string, tag: string) => call<string>("tag_push", { repoId, remote, tag, opId }),
  deleteRemoteBranch: (repoId: string, opId: string, name: string) =>
    call<string>("branch_delete_remote", { repoId, name, opId }),

  settingsGet: () => call<T.Settings>("settings_get"),
  settingsSet: (settings: T.Settings) => call<void>("settings_set", { settings }),
  workspaceGet: () => call<T.Workspace>("workspace_get"),
  workspaceAddRoot: (path: string) => call<T.Workspace>("workspace_add_root", { path }),
  workspaceRescan: () => call<T.Workspace>("workspace_rescan"),
  workspaceRemoveRoot: (path: string) => call<T.Workspace>("workspace_remove_root", { path }),
  workspaceAddRepo: (path: string) => call<T.Workspace>("workspace_add_repo", { path }),
  workspaceRemoveRepo: (path: string) => call<T.Workspace>("workspace_remove_repo", { path }),
  workspaceSetRepo: (path: string, pinned: boolean | null, group: string | null = null) =>
    call<T.Workspace>("workspace_set_repo", { path, pinned, group }),
  workspaceSummaries: (paths: string[]) => call<T.RepoSummary[]>("workspace_summaries", { paths }),
  workspaceFetchAll: (paths: string[], opId: string) => call<T.BatchResult[]>("workspace_fetch_all", { paths, opId }),

  gitenvStatus: () => call<T.GitEnvStatus>("gitenv_status"),
  identitySetGlobal: (name: string, email: string) => call<void>("identity_set_global", { name, email }),
  identityProfileAdd: (folder: string, name: string, email: string) => call<T.IdentityProfile>("identity_profile_add", { folder, name, email }),
  identityProfileRemove: (condition: string) => call<void>("identity_profile_remove", { condition }),
  gcmLogin: (opId: string) => call<T.GcmAccount[]>("gcm_login", { opId }),
  gcmLogout: (account: string) => call<T.GcmAccount[]>("gcm_logout", { account }),
  githubUser: (login: string) => call<T.GithubUser>("github_user", { login }),
  repoAuth: (repoId: string) => call<T.RepoAuth>("repo_auth", { repoId }),
  /** account: null = Git Credential Manager tự chọn, login = repo này dùng tài khoản đó */
  repoSetGithubAccount: (repoId: string, account: string | null) => call<void>("repo_set_github_account", { repoId, account }),
  repoSetIdentity: (repoId: string, name: string, email: string) => call<void>("repo_set_identity", { repoId, name, email }),
  repoClearIdentity: (repoId: string) => call<void>("repo_clear_identity", { repoId }),
  sshGenerate: (name: string, comment: string, passphrase: string) => call<T.SshKey>("ssh_generate", { name, comment, passphrase }),
  sshPublicKey: (name: string) => call<string>("ssh_public_key", { name }),
  sshTest: (host: string | null = null) => call<T.SshTest>("ssh_test", { host }),
  closeChoice: (action: "tray" | "quit", remember: boolean) => call<void>("app_close_choice", { action, remember }),
};
