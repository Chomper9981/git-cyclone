//! Kiểu dữ liệu gửi sang frontend (khớp `app/src/types.ts`).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub git_dir: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// Ký tự trạng thái index: M A D R C T U ? .
    pub index: char,
    /// Ký tự trạng thái worktree.
    pub worktree: char,
    /// Có conflict (dòng `u` trong porcelain v2); giá trị là XY gốc, vd "UU", "AA".
    pub conflict: Option<String>,
    pub submodule: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    /// merge | rebase | cherry-pick | revert
    pub kind: String,
    pub step: Option<u32>,
    pub total: Option<u32>,
    pub onto: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub oid: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub stash_count: u32,
    pub entries: Vec<StatusEntry>,
    pub in_progress: Option<InProgress>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// head | branch | remote | tag
    pub kind: String,
    pub name: String,
    /// Nhánh local đang được HEAD trỏ tới.
    pub current: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u8,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub commit: Commit,
    pub lane: u16,
    pub color: u8,
    /// Các đoạn nối từ hàng này (cột `from`) xuống hàng kế tiếp (cột `to`).
    pub edges: Vec<Edge>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub rows: Vec<GraphRow>,
    pub max_lanes: u16,
    pub has_more: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub message: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// A M D R C T
    pub status: char,
    pub path: String,
    pub orig_path: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub full_name: String,
    pub sha: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub upstream_gone: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    pub sha: String,
    pub annotated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub name: String,
    pub sha: String,
    pub time: i64,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub branches: Vec<Branch>,
    pub tags: Vec<Tag>,
    pub remotes: Vec<Remote>,
    pub stashes: Vec<Stash>,
}

// ---- Diff ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// ' ' context, '+' thêm, '-' xoá, '\\' "No newline at end of file"
    pub kind: char,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    /// A M D R
    pub status: char,
    pub binary: bool,
    pub too_large: bool,
    pub hunks: Vec<Hunk>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub hunk: usize,
    /// Header của hunk lúc hiển thị — dùng để phát hiện diff đã thay đổi.
    pub header: String,
    /// Chỉ số dòng (trong `Hunk.lines`) được chọn.
    pub lines: Vec<usize>,
}

// ---- Conflict ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    /// Nội dung hiện tại trong worktree (có marker).
    pub merged: Option<String>,
    pub binary: bool,
}

// ---- Blame ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub sha: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    pub line_no: u32,
    pub text: String,
}

// ---- Workspace ----

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub stash_count: u32,
    pub in_progress: Option<String>,
    pub last_commit_time: Option<i64>,
    pub has_remote: bool,
    pub error: Option<String>,
}
