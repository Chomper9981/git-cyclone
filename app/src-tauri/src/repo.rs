//! Registry các repo đang mở. RepoId = đường dẫn toplevel đã canonicalize.

use crate::error::{AppError, Result};
use crate::git::model::RepoInfo;
use crate::git::ops;
use crate::git::runner::Git;
use crate::watcher::RepoWatcher;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub struct RepoHandle {
    pub info: RepoInfo,
    pub git: Git,
    pub git_dir: PathBuf,
    /// Khoá cho thao tác ghi: mỗi repo chỉ một lệnh ghi tại một thời điểm.
    write_lock: Mutex<()>,
    pub watcher: Mutex<Option<RepoWatcher>>,
}

impl RepoHandle {
    pub fn lock_write(&self) -> MutexGuard<'_, ()> {
        self.write_lock.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Default)]
pub struct Registry {
    repos: Mutex<HashMap<String, Arc<RepoHandle>>>,
}

impl Registry {
    pub fn open(&self, path: &Path) -> Result<(Arc<RepoHandle>, bool)> {
        let (top, git_dir) = ops::discover(path)?;
        let id = top.display().to_string();
        let mut map = self.repos.lock().unwrap();
        if let Some(h) = map.get(&id) {
            return Ok((h.clone(), false));
        }
        let name = top.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| id.clone());
        let handle = Arc::new(RepoHandle {
            info: RepoInfo { id: id.clone(), path: id.clone(), name, git_dir: git_dir.display().to_string() },
            git: Git::new(&top),
            git_dir,
            write_lock: Mutex::new(()),
            watcher: Mutex::new(None),
        });
        map.insert(id, handle.clone());
        Ok((handle, true))
    }

    pub fn get(&self, id: &str) -> Result<Arc<RepoHandle>> {
        self.repos.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::RepoNotOpen(id.to_string()))
    }

    pub fn close(&self, id: &str) {
        if let Some(h) = self.repos.lock().unwrap().remove(id) {
            h.watcher.lock().unwrap().take();
        }
    }

    pub fn list(&self) -> Vec<RepoInfo> {
        self.repos.lock().unwrap().values().map(|h| h.info.clone()).collect()
    }
}
