//! Môi trường git có sẵn trên máy: danh tính commit, hồ sơ theo thư mục (includeIf),
//! tài khoản GitHub trong Git Credential Manager, SSH key.
//! Git Cyclone không tự giữ token — mọi thông tin đăng nhập do GCM / SSH quản lý,
//! nên terminal, VS Code và app luôn dùng chung.

use crate::error::{AppError, Result};
use crate::git::runner::{Git, RunOpts};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// git chạy ở thư mục home (cho lệnh --global / credential-manager).
pub fn home_git() -> Git {
    Git::new(home_dir())
}

fn cfg_get(git: &Git, args: &[&str]) -> Option<String> {
    git.run(args, RunOpts { allow_fail: true, ..RunOpts::read() })
        .ok()
        .filter(|o| o.ok())
        .map(|o| o.text().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Chạy chương trình ngoài git (ssh, ssh-keygen) không mở cửa sổ console.
fn run_tool(program: &str, args: &[&str]) -> Result<(i32, String, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Io(format!("{program} was not found. Install the OpenSSH client (Windows optional feature) or Git for Windows."))
        } else {
            AppError::from(e)
        }
    })?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

// ---------------------------------------------------------------- danh tính

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProfile {
    /// Điều kiện includeIf, vd `gitdir/i:D:/Work/`
    pub condition: String,
    /// Thư mục áp dụng (đã bỏ tiền tố gitdir)
    pub folder: String,
    /// File cấu hình được include
    pub path: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

pub fn global_identity() -> Identity {
    let g = home_git();
    Identity { name: cfg_get(&g, &["config", "--global", "--get", "user.name"]), email: cfg_get(&g, &["config", "--global", "--get", "user.email"]) }
}

pub fn validate_identity(name: &str, email: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains('\n') {
        return Err(AppError::invalid("name", "name cannot be empty"));
    }
    let e = email.trim();
    if !e.contains('@') || e.contains(char::is_whitespace) || e.starts_with('-') {
        return Err(AppError::invalid("email", "invalid email address"));
    }
    Ok(())
}

pub fn set_global_identity(name: &str, email: &str) -> Result<()> {
    validate_identity(name, email)?;
    let g = home_git();
    g.write(&["config", "--global", "user.name", name.trim()])?;
    g.write(&["config", "--global", "user.email", email.trim()])?;
    Ok(())
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(p),
    }
}

pub fn profiles() -> Vec<IdentityProfile> {
    let g = home_git();
    // --null: mỗi mục là "khoá\ngiá trị\0" — an toàn với đường dẫn có dấu cách.
    let raw = g
        .run(&["config", "--global", "--null", "--get-regexp", r"^includeif\..*\.path$"], RunOpts { allow_fail: true, ..RunOpts::read() })
        .ok()
        .filter(|o| o.ok())
        .map(|o| o.text())
        .unwrap_or_default();
    raw.split('\0')
        .filter(|e| !e.trim().is_empty())
        .filter_map(|entry| {
            let (key, value) = entry.split_once('\n')?;
            let cond = key.strip_prefix("includeif.")?.strip_suffix(".path")?;
            let folder = cond.strip_prefix("gitdir/i:").or_else(|| cond.strip_prefix("gitdir:"))?;
            let file = expand_home(value.trim());
            let fs = file.display().to_string();
            Some(IdentityProfile {
                condition: cond.to_string(),
                folder: folder.to_string(),
                name: cfg_get(&g, &["config", "--file", &fs, "--get", "user.name"]),
                email: cfg_get(&g, &["config", "--file", &fs, "--get", "user.email"]),
                path: fs,
            })
        })
        .collect()
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() { "profile".into() } else { t.chars().take(40).collect() }
}

/// Tạo hồ sơ: mọi repo trong `folder` dùng danh tính này (git includeIf gitdir/i:).
pub fn add_profile(folder: &str, name: &str, email: &str) -> Result<IdentityProfile> {
    validate_identity(name, email)?;
    let dir = dunce::canonicalize(folder).map_err(|_| AppError::invalid("folder", "folder does not exist"))?;
    if !dir.is_dir() {
        return Err(AppError::invalid("folder", "not a folder"));
    }
    let folder_fwd = format!("{}/", dir.display().to_string().replace('\\', "/").trim_end_matches('/'));
    let leaf = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut file = home_dir().join(format!(".gitconfig-{}", slug(&leaf)));
    let mut n = 2;
    while file.exists() {
        file = home_dir().join(format!(".gitconfig-{}-{n}", slug(&leaf)));
        n += 1;
    }
    let fs = file.display().to_string();
    let g = home_git();
    g.write(&["config", "--file", &fs, "user.name", name.trim()])?;
    g.write(&["config", "--file", &fs, "user.email", email.trim()])?;
    let key = format!("includeIf.gitdir/i:{folder_fwd}.path");
    g.write(&["config", "--global", &key, &fs.replace('\\', "/")])?;
    profiles()
        .into_iter()
        .find(|p| p.folder.eq_ignore_ascii_case(&folder_fwd))
        .ok_or_else(|| AppError::Io("profile was not saved".into()))
}

/// Gỡ hồ sơ; xoá file cấu hình nếu do Git Cyclone tạo (~/.gitconfig-*).
pub fn remove_profile(condition: &str) -> Result<()> {
    let p = profiles().into_iter().find(|p| p.condition == condition).ok_or_else(|| AppError::invalid("condition", "profile not found"))?;
    let key = format!("includeIf.{condition}.path");
    home_git().write(&["config", "--global", "--unset-all", &key])?;
    let file = PathBuf::from(&p.path);
    let ours = file.parent().is_some_and(|d| d == home_dir())
        && file.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".gitconfig-"));
    if ours {
        let _ = std::fs::remove_file(file);
    }
    Ok(())
}

// ---------------------------------------------------------------- Git Credential Manager

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GcmAccount {
    /// Tên tài khoản như GCM lưu (dùng để đăng xuất). Với mục lỗi trông như token: không gửi nguyên văn.
    pub name: String,
    /// Mục có tên trông như token (gho_/ghp_/github_pat_…) — thường do dán nhầm token vào ô username.
    pub looks_like_token: bool,
    pub display: String,
}

fn looks_like_token(s: &str) -> bool {
    ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_"].iter().any(|p| s.starts_with(p)) && s.len() > 20
}

fn mask(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len());
    }
    format!("{}…{}", chars[..4].iter().collect::<String>(), chars[chars.len() - 4..].iter().collect::<String>())
}

pub fn gcm_version() -> Option<String> {
    cfg_get(&home_git(), &["credential-manager", "--version"]).map(|v| v.split('+').next().unwrap_or(&v).to_string())
}

pub fn credential_helpers() -> Vec<String> {
    cfg_get(&home_git(), &["config", "--get-all", "credential.helper"]).map(|s| s.lines().map(String::from).collect()).unwrap_or_default()
}

pub fn gcm_accounts() -> Vec<GcmAccount> {
    let raw = cfg_get(&home_git(), &["credential-manager", "github", "list"]).unwrap_or_default();
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let tok = looks_like_token(l);
            GcmAccount { name: l.to_string(), looks_like_token: tok, display: if tok { mask(l) } else { l.to_string() } }
        })
        .collect()
}

pub fn gcm_logout(account: &str) -> Result<()> {
    if account.starts_with('-') || account.trim().is_empty() || account.contains(char::is_whitespace) {
        return Err(AppError::invalid("account", "invalid account"));
    }
    home_git().write(&["credential-manager", "github", "logout", account])?;
    Ok(())
}

// ---------------------------------------------------------------- theo repo

pub const REPO_USER_KEY: &str = "credential.https://github.com.username";

pub fn validate_login(login: &str) -> Result<()> {
    let ok = !login.is_empty() && login.len() <= 39 && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !login.starts_with('-');
    if ok { Ok(()) } else { Err(AppError::invalid("account", "invalid GitHub username")) }
}

pub fn repo_github_account(git: &Git) -> Option<String> {
    cfg_get(git, &["config", "--local", "--get", REPO_USER_KEY])
}

/// None = bỏ (GCM tự chọn / hỏi), Some(login) = repo này push bằng tài khoản đó.
pub fn set_repo_github_account(git: &Git, account: Option<&str>) -> Result<()> {
    match account {
        Some(l) => {
            validate_login(l)?;
            git.write(&["config", "--local", REPO_USER_KEY, l])?;
        }
        None => {
            git.run(&["config", "--local", "--unset-all", REPO_USER_KEY], RunOpts { allow_fail: true, ..RunOpts::write() })?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- SSH

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub comment: String,
    pub fingerprint: Option<String>,
}

pub fn ssh_dir() -> PathBuf {
    home_dir().join(".ssh")
}

fn read_pub(path: &Path) -> Option<SshKey> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut parts = text.split_whitespace();
    let kind = parts.next()?.to_string();
    let _b64 = parts.next()?;
    let comment = parts.collect::<Vec<_>>().join(" ");
    let p = path.display().to_string();
    let fingerprint = run_tool("ssh-keygen", &["-lf", &p])
        .ok()
        .filter(|(c, _, _)| *c == 0)
        .and_then(|(_, out, _)| out.split_whitespace().nth(1).map(String::from));
    Some(SshKey {
        name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.with_extension("").display().to_string(),
        kind,
        comment,
        fingerprint,
    })
}

pub fn ssh_keys() -> Vec<SshKey> {
    let Ok(rd) = std::fs::read_dir(ssh_dir()) else { return vec![] };
    let mut v: Vec<SshKey> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub"))
        .filter_map(|p| read_pub(&p))
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

fn validate_key_name(name: &str) -> Result<()> {
    let ok = !name.is_empty() && name.len() <= 64 && !name.starts_with(['.', '-']) && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok { Ok(()) } else { Err(AppError::invalid("name", "use letters, digits, '_', '-' or '.'")) }
}

pub fn ssh_public_key(name: &str) -> Result<String> {
    validate_key_name(name)?;
    Ok(std::fs::read_to_string(ssh_dir().join(format!("{name}.pub")))?.trim().to_string())
}

/// Tạo key ed25519. Passphrase rỗng = không đặt.
pub fn ssh_generate(name: &str, comment: &str, passphrase: &str) -> Result<SshKey> {
    validate_key_name(name)?;
    if comment.starts_with('-') || comment.contains('\n') {
        return Err(AppError::invalid("comment", "invalid comment"));
    }
    let dir = ssh_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    if path.exists() || path.with_extension("pub").exists() {
        return Err(AppError::invalid("name", "a key with this name already exists"));
    }
    let p = path.display().to_string();
    let (code, _, err) = run_tool("ssh-keygen", &["-q", "-t", "ed25519", "-C", comment, "-f", &p, "-N", passphrase])?;
    if code != 0 {
        return Err(AppError::Io(format!("ssh-keygen failed: {}", err.trim())));
    }
    read_pub(&path.with_extension("pub")).ok_or_else(|| AppError::Io("key was not created".into()))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshTest {
    pub ok: bool,
    pub message: String,
}

/// `ssh -T git@github.com` — GitHub trả "Hi <user>! You've successfully authenticated…" (exit 1).
pub fn ssh_test(host: &str) -> Result<SshTest> {
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) || host.is_empty() {
        return Err(AppError::invalid("host", "invalid host"));
    }
    let target = format!("git@{host}");
    let (_, out, err) = run_tool(
        "ssh",
        &["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", &target],
    )?;
    let text = format!("{}{}", out, err);
    let line = text.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string();
    let ok = text.contains("successfully authenticated");
    let message = if ok {
        text.lines().find(|l| l.contains("successfully authenticated")).unwrap_or(&line).trim().to_string()
    } else {
        line
    };
    Ok(SshTest { ok, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_detection_and_mask() {
        assert!(looks_like_token("gho_abcdefghijklmnopqrstuvwxyz0123"));
        assert!(!looks_like_token("octocat"));
        let m = mask("gho_abcdefghijklmnopqrstuvwxyz0123");
        assert!(m.starts_with("gho_") && m.ends_with("0123") && m.contains('…') && !m.contains("abcdef"));
    }

    #[test]
    fn slug_and_login_validation() {
        assert_eq!(slug("Red Cyclone Work"), "red-cyclone-work");
        assert!(validate_login("octocat").is_ok());
        assert!(validate_login("--force").is_err());
        assert!(validate_login("a b").is_err());
        assert!(validate_key_name("id_ed25519_work").is_ok());
        assert!(validate_key_name("../evil").is_err());
    }
}
