//! Lớp Tauri command: validate → gọi service trong thread blocking.
//! Tên tham số phía JS là camelCase (Tauri tự đổi sang snake_case).

use crate::error::{AppError, Result};
use crate::git::model::*;
use crate::git::ops::{self, NetOpts};
use crate::git::runner;
use crate::repo::{Registry, RepoHandle};
use crate::store::{Settings, Store, Workspace};
use crate::watcher::RepoWatcher;
use crate::workspace;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub registry: Registry,
    pub store: Store,
    ws_lock: Mutex<()>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        AppState {
            registry: Registry::default(),
            store: Store::new(data_dir),
            ws_lock: Mutex::new(()),
            cancels: Default::default(),
        }
    }

    pub(crate) fn register_cancel(&self, op_id: &str, flag: Arc<AtomicBool>) {
        self.cancels.lock().unwrap().insert(op_id.to_string(), flag);
    }

    pub(crate) fn unregister_cancel(&self, op_id: &str) {
        self.cancels.lock().unwrap().remove(op_id);
    }

    pub(crate) fn update_workspace(&self, f: impl FnOnce(&mut Workspace)) -> Result<Workspace> {
        let _g = self.ws_lock.lock().unwrap();
        let mut w = self.store.workspace();
        f(&mut w);
        self.store.save_workspace(&w)?;
        Ok(w)
    }
}

pub(crate) type St<'a> = State<'a, Arc<AppState>>;


pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Io(e.to_string()))?
}

/// Chạy một thao tác đọc trên repo.
pub(crate) async fn with_repo<T: Send + 'static>(
    st: &St<'_>,
    repo_id: &str,
    f: impl FnOnce(&RepoHandle) -> Result<T> + Send + 'static,
) -> Result<T> {
    let h = st.registry.get(repo_id)?;
    blocking(move || f(&h)).await
}

/// Chạy một thao tác ghi (giữ khoá ghi của repo).
pub(crate) async fn write_repo<T: Send + 'static>(
    st: &St<'_>,
    repo_id: &str,
    f: impl FnOnce(&RepoHandle) -> Result<T> + Send + 'static,
) -> Result<T> {
    let h = st.registry.get(repo_id)?;
    blocking(move || {
        let _g = h.lock_write();
        f(&h)
    })
    .await
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ================================================================ app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    git_version: Option<String>,
    data_dir: String,
    version: String,
    /// windows | linux | macos
    platform: &'static str,
    tray_available: bool,
}

#[tauri::command]
pub async fn app_info(st: St<'_>, app: AppHandle) -> Result<AppInfo> {
    let data_dir = st.store.dir.display().to_string();
    let git_version = blocking(|| Ok(runner::git_version().ok())).await?;
    Ok(AppInfo {
        git_version,
        data_dir,
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        tray_available: crate::tray::available(),
    })
}

/// Mở thư mục trong Explorer / terminal / VS Code.
#[tauri::command]
pub async fn reveal_path(path: String, target: String) -> Result<()> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(AppError::invalid("path", "path does not exist"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let r = match target.as_str() {
            "explorer" => std::process::Command::new("explorer").arg(&p).spawn(),
            "terminal" => std::process::Command::new("wt").args(["-d"]).arg(&p).spawn().or_else(|_| {
                std::process::Command::new("cmd").args(["/c", "start", "cmd", "/K", "cd", "/d"]).arg(&p).spawn()
            }),
            "vscode" => std::process::Command::new("cmd").args(["/c", "code"]).arg(&p).creation_flags(CREATE_NO_WINDOW).spawn(),
            _ => return Err(AppError::invalid("target", target)),
        };
        r.map(|_| ()).map_err(AppError::from)
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        let r = match target.as_str() {
            "explorer" => Command::new(opener).arg(&p).spawn(),
            "vscode" => Command::new("code").arg(&p).spawn(),
            "terminal" if cfg!(target_os = "macos") => Command::new("open").args(["-a", "Terminal"]).arg(&p).spawn(),
            "terminal" => {
                // Thử lần lượt các terminal phổ biến, mở tại thư mục `p`.
                let dir = if p.is_dir() { p.clone() } else { p.parent().map(PathBuf::from).unwrap_or_else(|| p.clone()) };
                let mut last = Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no terminal emulator found"));
                let mut names: Vec<String> = std::env::var("TERMINAL").ok().into_iter().collect();
                names.extend(
                    ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "alacritty", "xterm"].map(String::from),
                );
                for name in names {
                    last = Command::new(&name).current_dir(&dir).spawn();
                    if last.is_ok() {
                        break;
                    }
                }
                last
            }
            _ => return Err(AppError::invalid("target", target)),
        };
        r.map(|_| ()).map_err(AppError::from)
    }
}

// ================================================================ repo / session

fn start_watcher(app: &AppHandle, h: &Arc<RepoHandle>) {
    let app = app.clone();
    let id = h.info.id.clone();
    let w = RepoWatcher::start(h.git.cwd.clone(), h.git_dir.clone(), move |c| {
        let _ = app.emit("repo:changed", serde_json::json!({ "repoId": id, "status": c.status, "refs": c.refs }));
    });
    if let Ok(w) = w {
        *h.watcher.lock().unwrap() = Some(w);
    }
}

#[tauri::command]
pub async fn repo_open(st: St<'_>, app: AppHandle, path: String) -> Result<RepoInfo> {
    let state = st.inner().clone();
    let h = blocking(move || {
        let (h, fresh) = state.registry.open(Path::new(&path))?;
        if fresh {
            start_watcher(&app, &h);
        }
        let id = h.info.id.clone();
        state.update_workspace(|w| {
            w.upsert_repo(&id).last_opened = Some(now());
            if !w.open_tabs.contains(&id) {
                w.open_tabs.push(id.clone());
            }
            w.active_tab = Some(id.clone());
        })?;
        Ok(h)
    })
    .await?;
    Ok(h.info.clone())
}

#[tauri::command]
pub async fn repo_close(st: St<'_>, repo_id: String) -> Result<()> {
    st.registry.close(&repo_id);
    let state = st.inner().clone();
    blocking(move || {
        state.update_workspace(|w| {
            w.open_tabs.retain(|t| t != &repo_id);
            if w.active_tab.as_deref() == Some(repo_id.as_str()) {
                w.active_tab = None;
            }
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn session_set_active(st: St<'_>, repo_id: Option<String>) -> Result<()> {
    let state = st.inner().clone();
    blocking(move || {
        state.update_workspace(|w| w.active_tab = repo_id)?;
        Ok(())
    })
    .await
}

// ================================================================ read

#[tauri::command]
pub async fn status_get(st: St<'_>, repo_id: String) -> Result<RepoStatus> {
    with_repo(&st, &repo_id, |h| ops::status(&h.git, &h.git_dir)).await
}

#[tauri::command]
pub async fn graph_get(st: St<'_>, repo_id: String, limit: usize) -> Result<Graph> {
    with_repo(&st, &repo_id, move |h| ops::log_graph(&h.git, limit)).await
}

#[tauri::command]
pub async fn commit_detail(st: St<'_>, repo_id: String, sha: String) -> Result<CommitDetail> {
    with_repo(&st, &repo_id, move |h| ops::commit_detail(&h.git, &sha)).await
}

#[tauri::command]
pub async fn commit_file_diff(
    st: St<'_>,
    repo_id: String,
    sha: String,
    path: String,
    orig_path: Option<String>,
) -> Result<FileDiff> {
    with_repo(&st, &repo_id, move |h| ops::commit_file_diff(&h.git, &sha, &path, orig_path.as_deref())).await
}

#[tauri::command]
pub async fn worktree_diff(
    st: St<'_>,
    repo_id: String,
    path: String,
    orig_path: Option<String>,
    staged: bool,
    untracked: bool,
) -> Result<FileDiff> {
    with_repo(&st, &repo_id, move |h| ops::worktree_diff(&h.git, &path, orig_path.as_deref(), staged, untracked)).await
}

#[tauri::command]
pub async fn refs_get(st: St<'_>, repo_id: String) -> Result<Refs> {
    with_repo(&st, &repo_id, |h| ops::refs(&h.git)).await
}

#[tauri::command]
pub async fn file_history(st: St<'_>, repo_id: String, path: String) -> Result<Vec<Commit>> {
    with_repo(&st, &repo_id, move |h| ops::file_history(&h.git, &path, 500)).await
}

#[tauri::command]
pub async fn blame_get(st: St<'_>, repo_id: String, path: String, rev: Option<String>) -> Result<Vec<BlameLine>> {
    with_repo(&st, &repo_id, move |h| ops::blame(&h.git, &path, rev.as_deref())).await
}

#[tauri::command]
pub async fn head_message(st: St<'_>, repo_id: String) -> Result<String> {
    with_repo(&st, &repo_id, |h| ops::head_message(&h.git)).await
}

#[tauri::command]
pub async fn conflict_get(st: St<'_>, repo_id: String, path: String) -> Result<ConflictFile> {
    with_repo(&st, &repo_id, move |h| ops::conflict_file(&h.git, &path)).await
}

// ================================================================ write: staging / commit

#[tauri::command]
pub async fn stage_files(st: St<'_>, repo_id: String, paths: Vec<String>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::stage_files(&h.git, &paths)).await
}

#[tauri::command]
pub async fn unstage_files(st: St<'_>, repo_id: String, paths: Vec<String>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::unstage_files(&h.git, &paths)).await
}

#[tauri::command]
pub async fn stage_lines(st: St<'_>, repo_id: String, path: String, selections: Vec<HunkSelection>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::stage_lines(&h.git, &path, &selections)).await
}

#[tauri::command]
pub async fn unstage_lines(st: St<'_>, repo_id: String, path: String, selections: Vec<HunkSelection>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::unstage_lines(&h.git, &path, &selections)).await
}

#[tauri::command]
pub async fn discard_lines(st: St<'_>, repo_id: String, path: String, selections: Vec<HunkSelection>) -> Result<()> {
    let state = st.inner().clone();
    write_repo(&st, &repo_id, move |h| {
        let trash = state.store.trash_dir(&h.git.cwd);
        ops::discard_lines(&h.git, &path, &selections, &trash)
    })
    .await
}

#[tauri::command]
pub async fn discard_files(st: St<'_>, repo_id: String, paths: Vec<String>) -> Result<String> {
    let state = st.inner().clone();
    write_repo(&st, &repo_id, move |h| {
        let trash = state.store.trash_dir(&h.git.cwd);
        ops::discard_files(&h.git, &h.git_dir, &paths, &trash)?;
        Ok(trash.display().to_string())
    })
    .await
}

#[tauri::command]
pub async fn commit_create(st: St<'_>, repo_id: String, message: String, amend: bool) -> Result<String> {
    write_repo(&st, &repo_id, move |h| ops::commit(&h.git, &message, amend)).await
}

#[tauri::command]
pub async fn commit_undo_last(st: St<'_>, repo_id: String) -> Result<()> {
    write_repo(&st, &repo_id, |h| ops::undo_last_commit(&h.git)).await
}

// ================================================================ write: branches / tags / stash

#[tauri::command]
pub async fn branch_checkout(st: St<'_>, repo_id: String, name: String, remote: bool) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::checkout_branch(&h.git, &name, remote)).await
}

#[tauri::command]
pub async fn commit_checkout(st: St<'_>, repo_id: String, sha: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::checkout_commit(&h.git, &sha)).await
}

#[tauri::command]
pub async fn branch_create(st: St<'_>, repo_id: String, name: String, start: Option<String>, checkout: bool) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::create_branch(&h.git, &name, start.as_deref(), checkout)).await
}

#[tauri::command]
pub async fn branch_rename(st: St<'_>, repo_id: String, old: String, new: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::rename_branch(&h.git, &old, &new)).await
}

#[tauri::command]
pub async fn branch_delete(st: St<'_>, repo_id: String, name: String, force: bool) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::delete_branch(&h.git, &name, force)).await
}

#[tauri::command]
pub async fn tag_create(st: St<'_>, repo_id: String, name: String, target: String, message: Option<String>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::create_tag(&h.git, &name, &target, message.as_deref())).await
}

#[tauri::command]
pub async fn tag_delete(st: St<'_>, repo_id: String, name: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::delete_tag(&h.git, &name)).await
}

#[tauri::command]
pub async fn stash_push(
    st: St<'_>,
    repo_id: String,
    message: Option<String>,
    include_untracked: bool,
    paths: Vec<String>,
) -> Result<String> {
    write_repo(&st, &repo_id, move |h| ops::stash_push(&h.git, message.as_deref(), include_untracked, &paths)).await
}

#[tauri::command]
pub async fn stash_apply(st: St<'_>, repo_id: String, index: u32, pop: bool) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::stash_apply(&h.git, index, pop)).await
}

#[tauri::command]
pub async fn stash_drop(st: St<'_>, repo_id: String, index: u32) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::stash_drop(&h.git, index)).await
}

#[tauri::command]
pub async fn remote_add(st: St<'_>, repo_id: String, name: String, url: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::add_remote(&h.git, &name, &url)).await
}

// ================================================================ write: history

#[tauri::command]
pub async fn merge_branch(st: St<'_>, repo_id: String, name: String) -> Result<String> {
    write_repo(&st, &repo_id, move |h| ops::merge(&h.git, &name)).await
}

#[tauri::command]
pub async fn rebase_onto(st: St<'_>, repo_id: String, onto: String) -> Result<String> {
    write_repo(&st, &repo_id, move |h| ops::rebase(&h.git, &onto)).await
}

#[tauri::command]
pub async fn cherry_pick(st: St<'_>, repo_id: String, sha: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::cherry_pick(&h.git, &sha)).await
}

#[tauri::command]
pub async fn revert_commit(st: St<'_>, repo_id: String, sha: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::revert(&h.git, &sha)).await
}

#[tauri::command]
pub async fn sequencer(st: St<'_>, repo_id: String, action: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::sequencer(&h.git, &h.git_dir, &action)).await
}

#[tauri::command]
pub async fn reset_to(st: St<'_>, repo_id: String, target: String, mode: String) -> Result<Option<String>> {
    write_repo(&st, &repo_id, move |h| ops::reset(&h.git, &h.git_dir, &target, &mode)).await
}

#[tauri::command]
pub async fn conflict_resolve(st: St<'_>, repo_id: String, path: String, content: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::resolve_with_content(&h.git, &path, &content)).await
}

#[tauri::command]
pub async fn conflict_take(st: St<'_>, repo_id: String, path: String, side: String) -> Result<()> {
    write_repo(&st, &repo_id, move |h| ops::resolve_take(&h.git, &path, &side)).await
}

// ================================================================ network (có tiến trình + huỷ)

fn net_opts(state: &Arc<AppState>, app: &AppHandle, op_id: &str) -> NetOpts {
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(op_id.to_string(), cancel.clone());
    let app = app.clone();
    let id = op_id.to_string();
    NetOpts {
        cancel,
        on_progress: Box::new(move |line: &str| {
            let _ = app.emit("op:progress", serde_json::json!({ "opId": id, "line": line }));
        }),
    }
}

async fn network<T: Send + 'static>(
    st: &St<'_>,
    app: AppHandle,
    repo_id: &str,
    op_id: String,
    f: impl FnOnce(&RepoHandle, &runner::Git, NetOpts) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = st.inner().clone();
    let opts = net_opts(&state, &app, &op_id);
    let r = write_repo(st, repo_id, move |h| f(h, &h.git, opts)).await;
    state.cancels.lock().unwrap().remove(&op_id);
    r
}

#[tauri::command]
pub async fn op_cancel(st: St<'_>, op_id: String) -> Result<()> {
    if let Some(c) = st.cancels.lock().unwrap().get(&op_id) {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_fetch(st: St<'_>, app: AppHandle, repo_id: String, remote: Option<String>, op_id: String) -> Result<String> {
    network(&st, app, &repo_id, op_id, move |_h, g, o| ops::fetch(g, remote.as_deref(), o)).await
}

#[tauri::command]
pub async fn remote_pull(st: St<'_>, app: AppHandle, repo_id: String, mode: Option<String>, op_id: String) -> Result<String> {
    let mode = mode.unwrap_or_else(|| st.store.settings().pull_mode);
    network(&st, app, &repo_id, op_id, move |_h, g, o| ops::pull(g, &mode, o)).await
}

#[tauri::command]
pub async fn remote_push(st: St<'_>, app: AppHandle, repo_id: String, force: bool, op_id: String) -> Result<String> {
    network(&st, app, &repo_id, op_id, move |h, g, o| ops::push(g, &h.git_dir, force, o)).await
}

#[tauri::command]
pub async fn tag_push(st: St<'_>, app: AppHandle, repo_id: String, remote: String, tag: String, op_id: String) -> Result<String> {
    network(&st, app, &repo_id, op_id, move |_h, g, o| ops::push_tag(g, &remote, &tag, o)).await
}

#[tauri::command]
pub async fn branch_delete_remote(st: St<'_>, app: AppHandle, repo_id: String, name: String, op_id: String) -> Result<String> {
    network(&st, app, &repo_id, op_id, move |_h, g, o| ops::delete_remote_branch(g, &name, o)).await
}

// ================================================================ settings / workspace

#[tauri::command]
pub async fn settings_get(st: St<'_>) -> Result<Settings> {
    Ok(st.store.settings())
}

#[tauri::command]
pub async fn settings_set(st: St<'_>, app: AppHandle, settings: Settings) -> Result<()> {
    let lang_changed = st.store.settings().language != settings.language;
    st.store.save_settings(&settings)?;
    if lang_changed {
        crate::tray::refresh_language(&app, &settings.language);
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_get(st: St<'_>) -> Result<Workspace> {
    Ok(st.store.workspace())
}

/// Thêm thư mục gốc và quét repo bên trong. Trả workspace mới.
#[tauri::command]
pub async fn workspace_add_root(st: St<'_>, path: String) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || {
        let root = dunce::canonicalize(&path).map_err(|_| AppError::invalid("path", "folder does not exist"))?;
        let depth = state.store.settings().scan_depth;
        let found = workspace::scan(&root, depth);
        let root_s = root.display().to_string();
        state.update_workspace(|w| {
            if !w.roots.iter().any(|r| r.eq_ignore_ascii_case(&root_s)) {
                w.roots.push(root_s.clone());
            }
            for p in found {
                w.upsert_repo(&p.display().to_string());
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_rescan(st: St<'_>) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || {
        let w = state.store.workspace();
        let depth = state.store.settings().scan_depth;
        let mut found = Vec::new();
        for r in &w.roots {
            found.extend(workspace::scan(Path::new(r), depth));
        }
        state.update_workspace(|w| {
            for p in found {
                w.upsert_repo(&p.display().to_string());
            }
            // bỏ repo không còn tồn tại
            w.repos.retain(|r| Path::new(&r.path).join(".git").exists());
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_remove_root(st: St<'_>, path: String) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || {
        state.update_workspace(|w| {
            w.roots.retain(|r| r != &path);
            let prefix = format!("{}{}", path.trim_end_matches(['\\', '/']), std::path::MAIN_SEPARATOR);
            w.repos.retain(|r| r.pinned || !r.path.starts_with(&prefix));
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_add_repo(st: St<'_>, path: String) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || {
        let (top, _) = ops::discover(Path::new(&path))?;
        state.update_workspace(|w| {
            w.upsert_repo(&top.display().to_string());
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_remove_repo(st: St<'_>, path: String) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || state.update_workspace(|w| w.repos.retain(|r| r.path != path))).await
}

#[tauri::command]
pub async fn workspace_set_repo(st: St<'_>, path: String, pinned: Option<bool>, group: Option<String>) -> Result<Workspace> {
    let state = st.inner().clone();
    blocking(move || {
        state.update_workspace(|w| {
            let r = w.upsert_repo(&path);
            if let Some(p) = pinned {
                r.pinned = p;
            }
            if let Some(g) = group {
                r.group = (!g.trim().is_empty()).then(|| g.trim().to_string());
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_summaries(paths: Vec<String>) -> Result<Vec<RepoSummary>> {
    blocking(move || Ok(workspace::summaries(paths.into_iter().map(PathBuf::from).collect()))).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    path: String,
    ok: bool,
    error: Option<String>,
}

/// Fetch tất cả repo (4 song song). Phát event `workspace:fetch-progress` sau mỗi repo.
#[tauri::command]
pub async fn workspace_fetch_all(st: St<'_>, app: AppHandle, paths: Vec<String>, op_id: String) -> Result<Vec<BatchResult>> {
    let state = st.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(op_id.clone(), cancel.clone());
    let total = paths.len();
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let r = blocking(move || {
        Ok(workspace::parallel(paths, 4, move |p: &String| {
            let git = runner::Git::new(p);
            let res = if cancel.load(Ordering::Relaxed) {
                Err(AppError::Cancelled)
            } else {
                ops::fetch(&git, None, NetOpts { cancel: cancel.clone(), on_progress: Box::new(|_| {}) })
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app.emit("workspace:fetch-progress", serde_json::json!({ "done": n, "total": total, "path": p }));
            BatchResult { path: p.clone(), ok: res.is_ok(), error: res.err().map(|e| e.to_string()) }
        }))
    })
    .await;
    st.cancels.lock().unwrap().remove(&op_id);
    r
}
