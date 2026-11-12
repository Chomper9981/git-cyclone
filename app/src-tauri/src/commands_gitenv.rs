//! Command cho màn "Git & tài khoản": danh tính, Git Credential Manager, SSH, cấu hình theo repo.

use crate::commands::{blocking, with_repo, write_repo, St};
use crate::error::{AppError, Result};
use crate::git::ops;
use crate::git::runner::RunOpts;
use crate::gitenv::{self, GcmAccount, Identity, IdentityProfile, SshKey, SshTest};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEnvStatus {
    git_version: Option<String>,
    credential_helpers: Vec<String>,
    gcm_version: Option<String>,
    identity: Identity,
    profiles: Vec<IdentityProfile>,
    accounts: Vec<GcmAccount>,
    ssh_dir: String,
    ssh_keys: Vec<SshKey>,
}

#[tauri::command]
pub async fn gitenv_status() -> Result<GitEnvStatus> {
    blocking(|| {
        Ok(GitEnvStatus {
            git_version: crate::git::runner::git_version().ok(),
            credential_helpers: gitenv::credential_helpers(),
            gcm_version: gitenv::gcm_version(),
            identity: gitenv::global_identity(),
            profiles: gitenv::profiles(),
            accounts: gitenv::gcm_accounts(),
            ssh_dir: gitenv::ssh_dir().display().to_string(),
            ssh_keys: gitenv::ssh_keys(),
        })
    })
    .await
}

#[tauri::command]
pub async fn identity_set_global(name: String, email: String) -> Result<()> {
    blocking(move || gitenv::set_global_identity(&name, &email)).await
}

#[tauri::command]
pub async fn identity_profile_add(folder: String, name: String, email: String) -> Result<IdentityProfile> {
    blocking(move || gitenv::add_profile(&folder, &name, &email)).await
}

#[tauri::command]
pub async fn identity_profile_remove(condition: String) -> Result<()> {
    blocking(move || gitenv::remove_profile(&condition)).await
}

/// Mở luồng đăng nhập của Git Credential Manager (trình duyệt / cửa sổ của GCM). Có thể huỷ bằng op_cancel.
#[tauri::command]
pub async fn gcm_login(st: St<'_>, op_id: String) -> Result<Vec<GcmAccount>> {
    let cancel = Arc::new(AtomicBool::new(false));
    st.register_cancel(&op_id, cancel.clone());
    let r = blocking(move || {
        gitenv::home_git().run(
            &["credential-manager", "github", "login"],
            RunOpts { timeout: None, cancel: Some(cancel), ..Default::default() },
        )?;
        Ok(gitenv::gcm_accounts())
    })
    .await;
    st.unregister_cancel(&op_id);
    r
}

#[tauri::command]
pub async fn gcm_logout(account: String) -> Result<Vec<GcmAccount>> {
    blocking(move || {
        gitenv::gcm_logout(&account)?;
        Ok(gitenv::gcm_accounts())
    })
    .await
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    login: String,
    id: u64,
    name: Option<String>,
    avatar_url: String,
    noreply_email: String,
}

/// Hồ sơ công khai của một tài khoản GitHub (không cần đăng nhập) — để lấy email noreply cho commit.
#[tauri::command]
pub async fn github_user(login: String) -> Result<GithubUser> {
    gitenv::validate_login(&login)?;
    blocking(move || {
        #[derive(Deserialize)]
        struct U {
            login: String,
            id: u64,
            name: Option<String>,
            avatar_url: String,
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent("git-cyclone")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;
        let r = client
            .get(format!("https://api.github.com/users/{login}"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|e| AppError::Io(format!("Could not reach GitHub: {e}")))?;
        if !r.status().is_success() {
            return Err(AppError::Io(format!("GitHub returned HTTP {}", r.status())));
        }
        let u: U = r.json().map_err(|e| AppError::Io(e.to_string()))?;
        Ok(GithubUser { noreply_email: format!("{}+{}@users.noreply.github.com", u.id, u.login), login: u.login, id: u.id, name: u.name, avatar_url: u.avatar_url })
    })
    .await
}

// ================================================================ theo repo

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAuth {
    /// Tài khoản GitHub ghi riêng cho repo (credential.https://github.com.username); null = GCM tự chọn
    account: Option<String>,
    github_https: bool,
    github_ssh: bool,
    name: Option<String>,
    email: Option<String>,
    /// local | global | system | null — nơi đặt user.email (theo `git config --show-scope`)
    email_scope: Option<String>,
    /// File cấu hình cung cấp user.email (để nhận biết hồ sơ includeIf)
    email_origin: Option<String>,
}

fn is_github_https(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("https://github.com/") || (u.starts_with("https://") && u.contains("@github.com/"))
}

#[tauri::command]
pub async fn repo_auth(st: St<'_>, repo_id: String) -> Result<RepoAuth> {
    with_repo(&st, &repo_id, move |h| {
        let remotes = ops::refs(&h.git).map(|r| r.remotes).unwrap_or_default();
        let urls: Vec<String> = remotes.iter().flat_map(|r| [r.fetch_url.clone(), r.push_url.clone()]).collect();
        let get = |args: &[&str]| -> Option<String> {
            h.git
                .run(args, RunOpts { allow_fail: true, ..RunOpts::read() })
                .ok()
                .filter(|o| o.ok())
                .map(|o| o.text().trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let scope_line = get(&["config", "--show-scope", "--show-origin", "--get", "user.email"]);
        let (email_scope, email_origin) = match &scope_line {
            Some(l) => {
                let mut it = l.split('\t');
                let scope = it.next().map(String::from);
                let origin = it.next().map(|o| o.trim_start_matches("file:").to_string());
                (scope, origin)
            }
            None => (None, None),
        };
        Ok(RepoAuth {
            account: gitenv::repo_github_account(&h.git),
            github_https: urls.iter().any(|u| is_github_https(u)),
            github_ssh: urls.iter().any(|u| u.contains("github.com:") || u.starts_with("ssh://git@github.com")),
            name: get(&["config", "--get", "user.name"]),
            email: get(&["config", "--get", "user.email"]),
            email_scope,
            email_origin,
        })
    })
    .await
}

/// account: null = bỏ cấu hình riêng (GCM tự chọn), login = repo này push/pull bằng tài khoản đó.
#[tauri::command]
pub async fn repo_set_github_account(st: St<'_>, repo_id: String, account: Option<String>) -> Result<()> {
    write_repo(&st, &repo_id, move |h| gitenv::set_repo_github_account(&h.git, account.as_deref())).await
}

/// Đặt user.name / user.email riêng cho repo (git config --local).
#[tauri::command]
pub async fn repo_set_identity(st: St<'_>, repo_id: String, name: String, email: String) -> Result<()> {
    gitenv::validate_identity(&name, &email)?;
    write_repo(&st, &repo_id, move |h| {
        h.git.write(&["config", "--local", "user.name", name.trim()])?;
        h.git.write(&["config", "--local", "user.email", email.trim()])?;
        Ok(())
    })
    .await
}

/// Bỏ danh tính riêng của repo (quay về cấu hình global / hồ sơ thư mục).
#[tauri::command]
pub async fn repo_clear_identity(st: St<'_>, repo_id: String) -> Result<()> {
    write_repo(&st, &repo_id, |h| {
        for k in ["user.name", "user.email"] {
            h.git.run(&["config", "--local", "--unset", k], RunOpts { allow_fail: true, ..RunOpts::write() })?;
        }
        Ok(())
    })
    .await
}

// ================================================================ SSH

#[tauri::command]
pub async fn ssh_generate(name: String, comment: String, passphrase: String) -> Result<SshKey> {
    blocking(move || gitenv::ssh_generate(&name, &comment, &passphrase)).await
}

#[tauri::command]
pub async fn ssh_public_key(name: String) -> Result<String> {
    blocking(move || gitenv::ssh_public_key(&name)).await
}

#[tauri::command]
pub async fn ssh_test(host: Option<String>) -> Result<SshTest> {
    blocking(move || gitenv::ssh_test(host.as_deref().unwrap_or("github.com"))).await
}
