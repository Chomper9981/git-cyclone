// Khớp 1-1 với src-tauri/src/git/model.rs, store.rs, commands.rs

export interface RepoInfo {
  id: string;
  path: string;
  name: string;
  gitDir: string;
}

export interface StatusEntry {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  conflict: string | null;
  submodule: boolean;
}

export interface InProgress {
  kind: "merge" | "rebase" | "cherry-pick" | "revert";
  step: number | null;
  total: number | null;
  onto: string | null;
}

export interface RepoStatus {
  oid: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  stashCount: number;
  entries: StatusEntry[];
  inProgress: InProgress | null;
}

export interface RefLabel {
  kind: "head" | "branch" | "remote" | "tag";
  name: string;
  current: boolean;
}

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  time: number;
  subject: string;
  refs: RefLabel[];
}

export interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  commit: Commit;
  lane: number;
  color: number;
  edges: Edge[];
}

export interface Graph {
  rows: GraphRow[];
  maxLanes: number;
  hasMore: boolean;
}

export interface ChangedFile {
  status: string;
  path: string;
  origPath: string | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
  files: ChangedFile[];
}

export interface Branch {
  name: string;
  fullName: string;
  sha: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
}

export interface Tag {
  name: string;
  sha: string;
  annotated: boolean;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  name: string;
  sha: string;
  time: number;
  message: string;
}

export interface Refs {
  branches: Branch[];
  tags: Tag[];
  remotes: Remote[];
  stashes: Stash[];
}

export interface DiffLine {
  kind: " " | "+" | "-" | "\\";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: string;
  binary: boolean;
  tooLarge: boolean;
  hunks: Hunk[];
}

export interface HunkSelection {
  hunk: number;
  header: string;
  lines: number[];
}

export interface ConflictFile {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged: string | null;
  binary: boolean;
}

export interface BlameLine {
  sha: string;
  author: string;
  time: number;
  summary: string;
  lineNo: number;
  text: string;
}

export interface RepoSummary {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  stashCount: number;
  inProgress: string | null;
  lastCommitTime: number | null;
  hasRemote: boolean;
  error: string | null;
}

export interface Settings {
  theme: "dark" | "light" | "system";
  pullMode: "ff-only" | "rebase" | "merge";
  autoFetchMinutes: number;
  scanDepth: number;
  diffContext: number;
  language: "en" | "vi";
  closeAction: "ask" | "tray" | "quit";
}


export interface WorkspaceRepo {
  path: string;
  pinned: boolean;
  group: string | null;
  lastOpened: number | null;
}

export interface Workspace {
  roots: string[];
  repos: WorkspaceRepo[];
  openTabs: string[];
  activeTab: string | null;
}

export interface AppInfo {
  gitVersion: string | null;
  dataDir: string;
  version: string;
  /** windows | linux | macos */
  platform: string;
  /** false khi môi trường desktop không hiện icon khay (ví dụ GNOME mặc định). */
  trayAvailable: boolean;
}

export interface BatchResult {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface AppError {
  kind: string;
  message: string;
  stderr: string | null;
  args: string[] | null;
  waitSeconds?: number;
}

export interface GcmAccount {
  name: string;
  looksLikeToken: boolean;
  display: string;
}

export interface Identity {
  name: string | null;
  email: string | null;
}

export interface IdentityProfile {
  condition: string;
  folder: string;
  path: string;
  name: string | null;
  email: string | null;
}

export interface SshKey {
  name: string;
  path: string;
  kind: string;
  comment: string;
  fingerprint: string | null;
}

export interface SshTest {
  ok: boolean;
  message: string;
}

export interface GitEnvStatus {
  gitVersion: string | null;
  credentialHelpers: string[];
  gcmVersion: string | null;
  identity: Identity;
  profiles: IdentityProfile[];
  accounts: GcmAccount[];
  sshDir: string;
  sshKeys: SshKey[];
}

export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
  noreplyEmail: string;
}

export interface RepoAuth {
  /** Tài khoản GitHub ghi riêng cho repo; null = Git Credential Manager tự chọn */
  account: string | null;
  githubHttps: boolean;
  githubSsh: boolean;
  name: string | null;
  email: string | null;
  emailScope: string | null;
  emailOrigin: string | null;
}
