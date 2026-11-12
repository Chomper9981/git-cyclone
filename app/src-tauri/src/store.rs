//! Lưu settings/workspace dạng JSON trong thư mục dữ liệu app (%APPDATA%\vn.gitcyclone.app).

use crate::error::Result;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// dark | light | system
    pub theme: String,
    /// ff-only | rebase | merge
    pub pull_mode: String,
    /// Fetch nền cho repo đang mở, phút; 0 = tắt.
    pub auto_fetch_minutes: u32,
    pub scan_depth: u32,
    pub diff_context: u32,
    /// en | vi
    pub language: String,
    /// Khi đóng cửa sổ: ask | tray | quit
    pub close_action: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { theme: "dark".into(), pull_mode: "ff-only".into(), auto_fetch_minutes: 0, scan_depth: 4, diff_context: 3, language: "en".into(), close_action: "ask".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceRepo {
    pub path: String,
    pub pinned: bool,
    pub group: Option<String>,
    pub last_opened: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub roots: Vec<String>,
    pub repos: Vec<WorkspaceRepo>,
    /// Repo đang mở dạng tab — khôi phục khi khởi động lại.
    pub open_tabs: Vec<String>,
    pub active_tab: Option<String>,
}

/// Chuẩn hoá đường dẫn repo để so sánh/lưu: canonical nếu tồn tại, dấu phân cách của hệ điều hành, bỏ '\' cuối.
pub fn norm_path(p: &str) -> String {
    let s = dunce::canonicalize(p).map(|x| x.display().to_string()).unwrap_or_else(|_| {
        if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() }
    });
    s.trim_end_matches(['\\', '/']).to_string()
}

pub fn same_path(a: &str, b: &str) -> bool {
    norm_path(a).eq_ignore_ascii_case(&norm_path(b))
}

impl Workspace {
    /// Gộp các mục trùng (cùng repo nhưng khác cách viết đường dẫn).
    pub fn dedupe(&mut self) {
        let mut seen: Vec<String> = Vec::new();
        let mut out: Vec<WorkspaceRepo> = Vec::new();
        for mut r in std::mem::take(&mut self.repos) {
            r.path = norm_path(&r.path);
            let key = r.path.to_lowercase();
            if let Some(i) = seen.iter().position(|k| k == &key) {
                let o = &mut out[i];
                o.pinned |= r.pinned;
                if o.group.is_none() { o.group = r.group; }
                o.last_opened = o.last_opened.max(r.last_opened);
            } else {
                seen.push(key);
                out.push(r);
            }
        }
        self.repos = out;
        let mut tabs: Vec<String> = Vec::new();
        for t in std::mem::take(&mut self.open_tabs) {
            let n = norm_path(&t);
            if !tabs.iter().any(|x| x.eq_ignore_ascii_case(&n)) { tabs.push(n); }
        }
        self.open_tabs = tabs;
        self.active_tab = self.active_tab.take().map(|a| norm_path(&a));
    }

    pub fn upsert_repo(&mut self, path: &str) -> &mut WorkspaceRepo {
        let path = &norm_path(path);
        let idx = match self.repos.iter().position(|r| same_path(&r.path, path)) {
            Some(i) => i,
            None => {
                self.repos.push(WorkspaceRepo { path: path.to_string(), ..Default::default() });
                self.repos.len() - 1
            }
        };
        &mut self.repos[idx]
    }
}

pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Store { dir }
    }

    fn load<T: DeserializeOwned + Default>(&self, name: &str) -> T {
        std::fs::read(self.dir.join(name)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Ghi nguyên tử: ghi file tạm rồi rename.
    fn save<T: Serialize>(&self, name: &str, v: &T) -> Result<()> {
        let tmp = self.dir.join(format!("{name}.tmp"));
        let data = serde_json::to_vec_pretty(v).map_err(|e| crate::error::AppError::Io(e.to_string()))?;
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, self.dir.join(name))?;
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        self.load("settings.json")
    }
    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.save("settings.json", s)
    }
    pub fn workspace(&self) -> Workspace {
        let mut w: Workspace = self.load("workspace.json");
        w.dedupe();
        w
    }
    pub fn save_workspace(&self, w: &Workspace) -> Result<()> {
        self.save("workspace.json", w)
    }

    /// Thư mục sao lưu cho một lần discard.
    pub fn trash_dir(&self, repo_path: &Path) -> PathBuf {
        let name = repo_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        self.dir.join("trash").join(name).join(ts.to_string())
    }

    /// Xoá bản sao lưu cũ hơn `days` ngày.
    pub fn prune_trash(&self, days: u64) {
        let root = self.dir.join("trash");
        let Ok(repos) = std::fs::read_dir(&root) else { return };
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
        for repo in repos.flatten() {
            let Ok(entries) = std::fs::read_dir(repo.path()) else { continue };
            for e in entries.flatten() {
                let old = e.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
                if old {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
}
