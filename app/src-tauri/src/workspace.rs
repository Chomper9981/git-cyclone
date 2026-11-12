//! Quét thư mục tìm repo và tính trạng thái tóm tắt cho dashboard.

use crate::git::model::RepoSummary;
use crate::git::ops;
use crate::git::parse;
use crate::git::runner::{Git, RunOpts};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SKIP: &[&str] =
    &["node_modules", "target", ".venv", "venv", "dist", "build", ".cache", "$RECYCLE.BIN", "System Volume Information"];

/// Tìm repo trong `root` tới độ sâu `depth`. Không đi vào bên trong repo đã tìm thấy.
pub fn scan(root: &Path, depth: u32) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, depth, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if dir.join(".git").exists() {
        out.push(dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()));
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        walk(&e.path(), depth - 1, out);
    }
}

pub fn summary(path: &Path) -> RepoSummary {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut s = RepoSummary { path: path.display().to_string(), name, ..Default::default() };
    let git = Git::new(path);
    let raw = match git.read(&["status", "--porcelain=v2", "--branch", "--show-stash", "-z", "--untracked-files=normal"]) {
        Ok(r) => r,
        Err(e) => {
            s.error = Some(e.to_string());
            return s;
        }
    };
    let st = parse::parse_status(&raw);
    s.branch = st.branch;
    s.detached = st.detached;
    s.upstream = st.upstream;
    s.ahead = st.ahead;
    s.behind = st.behind;
    s.stash_count = st.stash_count;
    for e in &st.entries {
        if e.conflict.is_some() {
            s.conflicted += 1;
        } else if e.index == '?' {
            s.untracked += 1;
        } else {
            if e.index != '.' {
                s.staged += 1;
            }
            if e.worktree != '.' {
                s.unstaged += 1;
            }
        }
    }
    if let Ok(gd) = git.read_str(&["rev-parse", "--absolute-git-dir"]) {
        s.in_progress = ops::in_progress(Path::new(gd.trim())).map(|p| p.kind);
    }
    s.has_remote = git.read_str(&["remote"]).map(|r| !r.trim().is_empty()).unwrap_or(false);
    if st.oid.is_some() {
        s.last_commit_time = git
            .run(&["log", "-1", "--format=%ct"], RunOpts { allow_fail: true, ..RunOpts::read() })
            .ok()
            .and_then(|o| o.text().trim().parse().ok());
    }
    s
}

/// Chạy `f` song song trên các phần tử, tối đa `workers` luồng.
pub fn parallel<T: Send + Sync + 'static, R: Send + 'static>(
    items: Vec<T>,
    workers: usize,
    f: impl Fn(&T) -> R + Send + Sync + 'static,
) -> Vec<R> {
    let n = items.len();
    let items = Arc::new(items);
    let next = Arc::new(Mutex::new(0usize));
    let results: Arc<Mutex<Vec<Option<R>>>> = Arc::new(Mutex::new((0..n).map(|_| None).collect()));
    let f = Arc::new(f);
    let handles: Vec<_> = (0..workers.max(1).min(n.max(1)))
        .map(|_| {
            let (items, next, results, f) = (items.clone(), next.clone(), results.clone(), f.clone());
            std::thread::spawn(move || loop {
                let i = {
                    let mut g = next.lock().unwrap();
                    let i = *g;
                    *g += 1;
                    i
                };
                if i >= items.len() {
                    break;
                }
                let r = f(&items[i]);
                results.lock().unwrap()[i] = Some(r);
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    Arc::try_unwrap(results)
        .ok()
        .map(|m| m.into_inner().unwrap().into_iter().flatten().collect())
        .unwrap_or_default()
}

pub fn summaries(paths: Vec<PathBuf>) -> Vec<RepoSummary> {
    parallel(paths, 4, |p| summary(p))
}
