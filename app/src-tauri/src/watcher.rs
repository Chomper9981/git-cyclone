//! Theo dõi thay đổi file của repo, debounce rồi báo "status" / "refs" đã đổi.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(300);
const IGNORED_DIRS: &[&str] = &["node_modules", "target", ".venv", "dist", "build", ".next", "__pycache__", ".gradle"];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Change {
    pub status: bool,
    pub refs: bool,
}

pub struct RepoWatcher {
    _watchers: Vec<RecommendedWatcher>,
}

fn classify(workdir: &Path, git_dir: &Path, p: &Path) -> Change {
    let mut c = Change::default();
    if let Ok(rel) = p.strip_prefix(git_dir) {
        let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.ends_with(".lock") || first == "objects" || first == "logs" || first == "hooks" {
            return c;
        }
        match first.as_str() {
            "index" => c.status = true,
            "HEAD" | "refs" | "packed-refs" | "FETCH_HEAD" | "ORIG_HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD"
            | "REVERT_HEAD" | "rebase-merge" | "rebase-apply" => {
                c.refs = true;
                c.status = true;
            }
            _ => {}
        }
        return c;
    }
    if let Ok(rel) = p.strip_prefix(workdir) {
        let ignored = rel.components().any(|comp| match comp {
            Component::Normal(s) => {
                let s = s.to_string_lossy();
                s == ".git" || IGNORED_DIRS.contains(&s.as_ref())
            }
            _ => false,
        });
        if !ignored {
            c.status = true;
        }
    }
    c
}

impl RepoWatcher {
    pub fn start(workdir: PathBuf, git_dir: PathBuf, on_change: impl Fn(Change) + Send + 'static) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<Change>();
        let (w2, g2) = (workdir.clone(), git_dir.clone());
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let mut c = Change::default();
            for p in &ev.paths {
                let x = classify(&w2, &g2, p);
                c.status |= x.status;
                c.refs |= x.refs;
            }
            if c.status || c.refs {
                let _ = tx.send(c);
            }
        };
        let mut watchers = Vec::new();
        let mut w = notify::recommended_watcher(handler.clone())?;
        w.watch(&workdir, RecursiveMode::Recursive)?;
        watchers.push(w);
        if !git_dir.starts_with(&workdir) {
            let mut w = notify::recommended_watcher(handler)?;
            w.watch(&git_dir, RecursiveMode::Recursive)?;
            watchers.push(w);
        }

        std::thread::spawn(move || {
            // Kết thúc khi mọi watcher bị drop (sender đóng).
            while let Ok(first) = rx.recv() {
                let mut acc = first;
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(c) => {
                            acc.status |= c.status;
                            acc.refs |= c.refs;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change(acc);
            }
        });
        Ok(RepoWatcher { _watchers: watchers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_paths() {
        let w = PathBuf::from("/r");
        let g = PathBuf::from("/r/.git");
        assert_eq!(classify(&w, &g, Path::new("/r/.git/index")), Change { status: true, refs: false });
        assert_eq!(classify(&w, &g, Path::new("/r/.git/refs/heads/main")), Change { status: true, refs: true });
        assert_eq!(classify(&w, &g, Path::new("/r/.git/index.lock")), Change::default());
        assert_eq!(classify(&w, &g, Path::new("/r/.git/objects/ab/cd")), Change::default());
        assert_eq!(classify(&w, &g, Path::new("/r/src/a.rs")), Change { status: true, refs: false });
        assert_eq!(classify(&w, &g, Path::new("/r/node_modules/x/y.js")), Change::default());
    }
}
