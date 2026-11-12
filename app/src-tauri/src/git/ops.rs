//! Các thao tác git cấp cao. Mọi hàm nhận `&Git` (đã gắn working dir).

use super::diff::{self, PatchMode, RawFile};
use super::model::*;
use super::parse::{self, LOG_FORMAT, REF_FORMAT, STASH_FORMAT};
use super::runner::{Git, LineSink, RunOpts};
use crate::error::{AppError, Result};
use crate::graph;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---------------------------------------------------------------- validate

pub fn validate_path(p: &str) -> Result<()> {
    let bad = p.is_empty()
        || p.contains('\0')
        || p.starts_with('/')
        || p.starts_with('\\')
        || p.as_bytes().get(1) == Some(&b':')
        || p.split(['/', '\\']).any(|c| c == "..");
    if bad { Err(AppError::invalid("path", format!("invalid path: {p}"))) } else { Ok(()) }
}

pub fn validate_paths(ps: &[String]) -> Result<()> {
    if ps.is_empty() {
        return Err(AppError::invalid("paths", "no files given"));
    }
    ps.iter().try_for_each(|p| validate_path(p))
}

/// Revision: sha, tên ref, `HEAD~1`... Không cho bắt đầu bằng '-' (chống argument injection).
pub fn validate_rev(r: &str) -> Result<()> {
    let bad = r.is_empty()
        || r.starts_with('-')
        || r.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ':' | '?' | '*' | '[' | '\\'))
        || r.contains("..");
    if bad { Err(AppError::invalid("rev", format!("invalid revision: {r}"))) } else { Ok(()) }
}

pub fn validate_branch_name(git: &Git, name: &str) -> Result<()> {
    if name.starts_with('-') || name.trim() != name || name.is_empty() {
        return Err(AppError::invalid("name", "invalid branch name"));
    }
    let out = git.run(&["check-ref-format", "--branch", name], RunOpts { allow_fail: true, ..RunOpts::read() })?;
    if !out.ok() {
        return Err(AppError::invalid("name", format!("invalid branch name: {name}")));
    }
    Ok(())
}

pub fn validate_tag_name(git: &Git, name: &str) -> Result<()> {
    if name.starts_with('-') || name.is_empty() {
        return Err(AppError::invalid("name", "invalid tag name"));
    }
    let full = format!("refs/tags/{name}");
    let out = git.run(&["check-ref-format", &full], RunOpts { allow_fail: true, ..RunOpts::read() })?;
    if !out.ok() {
        return Err(AppError::invalid("name", format!("invalid tag name: {name}")));
    }
    Ok(())
}

// ---------------------------------------------------------------- repo

/// Trả (toplevel, git_dir) cho một thư mục bất kỳ bên trong repo.
pub fn discover(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let git = Git::new(path);
    let out = git
        .read_str(&["rev-parse", "--show-toplevel", "--absolute-git-dir"])
        .map_err(|e| match e {
            AppError::NotARepo(_) | AppError::GitFailed { .. } => AppError::NotARepo(path.display().to_string()),
            e => e,
        })?;
    let mut lines = out.lines();
    let top = lines.next().ok_or_else(|| AppError::NotARepo(path.display().to_string()))?;
    let gd = lines.next().ok_or_else(|| AppError::NotARepo(path.display().to_string()))?;
    let top = dunce::canonicalize(top).unwrap_or_else(|_| PathBuf::from(top));
    let gd = dunce::canonicalize(gd).unwrap_or_else(|_| PathBuf::from(gd));
    Ok((top, gd))
}

pub fn head_exists(git: &Git) -> bool {
    git.run(&["rev-parse", "--verify", "-q", "HEAD"], RunOpts { allow_fail: true, ..RunOpts::read() })
        .map(|o| o.ok())
        .unwrap_or(false)
}

pub fn head_sha(git: &Git) -> Option<String> {
    git.read_str(&["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string())
}

// ---------------------------------------------------------------- status

pub fn in_progress(git_dir: &Path) -> Option<InProgress> {
    let read_num = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|s| s.trim().parse::<u32>().ok());
    let rm = git_dir.join("rebase-merge");
    if rm.is_dir() {
        let onto = std::fs::read_to_string(rm.join("head-name"))
            .ok()
            .map(|s| s.trim().trim_start_matches("refs/heads/").to_string());
        return Some(InProgress {
            kind: "rebase".into(),
            step: read_num(rm.join("msgnum")),
            total: read_num(rm.join("end")),
            onto,
        });
    }
    let ra = git_dir.join("rebase-apply");
    if ra.is_dir() {
        return Some(InProgress {
            kind: "rebase".into(),
            step: read_num(ra.join("next")),
            total: read_num(ra.join("last")),
            onto: None,
        });
    }
    for (file, kind) in [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if git_dir.join(file).exists() {
            return Some(InProgress { kind: kind.into(), ..Default::default() });
        }
    }
    None
}

pub fn status(git: &Git, git_dir: &Path) -> Result<RepoStatus> {
    let raw = git.read(&["status", "--porcelain=v2", "--branch", "--show-stash", "-z", "--untracked-files=all"])?;
    let mut st = parse::parse_status(&raw);
    st.in_progress = in_progress(git_dir);
    Ok(st)
}

// ---------------------------------------------------------------- log / graph

pub fn remote_names(git: &Git) -> Vec<String> {
    git.read_str(&["remote"]).map(|s| s.lines().map(String::from).collect()).unwrap_or_default()
}

pub fn log_graph(git: &Git, limit: usize) -> Result<Graph> {
    let limit = limit.clamp(1, 200_000);
    let remotes = remote_names(git);
    let n = format!("--max-count={}", limit + 1);
    let out = git.run(
        &["log", "--exclude=refs/stash", "--all", "--date-order", "--decorate=short", &n, LOG_FORMAT],
        RunOpts { allow_fail: true, ..RunOpts::read() },
    )?;
    if !out.ok() {
        if out.stderr.contains("does not have any commits") || !head_exists(git) {
            return Ok(Graph { rows: vec![], max_lanes: 1, has_more: false });
        }
        return Err(AppError::classify(out.code, out.stderr, vec!["log".into()]));
    }
    let mut commits = parse::parse_log(&out.stdout, &remotes);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(graph::layout(commits, has_more))
}

pub fn file_history(git: &Git, path: &str, limit: usize) -> Result<Vec<Commit>> {
    validate_path(path)?;
    let n = format!("--max-count={limit}");
    let raw = git.read(&["log", "--follow", &n, LOG_FORMAT, "--", path])?;
    Ok(parse::parse_log(&raw, &remote_names(git)))
}

pub fn commit_detail(git: &Git, sha: &str) -> Result<CommitDetail> {
    validate_rev(sha)?;
    let raw = git.read_str(&[
        "show",
        "-s",
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B",
        sha,
        "--",
    ])?;
    let f: Vec<&str> = raw.splitn(9, parse::FS).collect();
    if f.len() < 9 {
        return Err(AppError::invalid("sha", "could not read commit"));
    }
    let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
    let full = f[0].to_string();
    let files_raw = match parents.first() {
        Some(p) => git.read(&["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id", p, &full])?,
        None => git.read(&["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id", "--root", &full])?,
    };
    Ok(CommitDetail {
        sha: full,
        parents,
        author_name: f[2].into(),
        author_email: f[3].into(),
        author_time: f[4].parse().unwrap_or(0),
        committer_name: f[5].into(),
        committer_email: f[6].into(),
        committer_time: f[7].parse().unwrap_or(0),
        message: f[8].trim_end().to_string(),
        files: parse::parse_name_status(&files_raw),
    })
}

fn first_file(raw: &[u8], fallback_path: &str) -> FileDiff {
    parse_first_raw(raw, fallback_path).to_display()
}

fn parse_first_raw(raw: &[u8], fallback_path: &str) -> RawFile {
    diff::parse_raw(raw).into_iter().next().unwrap_or(RawFile {
        header: vec![],
        path: fallback_path.to_string(),
        old_path: None,
        status: 'M',
        binary: false,
        hunks: vec![],
    })
}

pub fn commit_file_diff(git: &Git, sha: &str, path: &str, orig_path: Option<&str>) -> Result<FileDiff> {
    validate_rev(sha)?;
    validate_path(path)?;
    let parent = git
        .read_str(&["rev-parse", "--verify", "-q", &format!("{sha}^1")])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| EMPTY_TREE.to_string());
    let mut args = vec!["diff", "-M", "--no-color", "--no-ext-diff", parent.as_str(), sha, "--", path];
    if let Some(o) = orig_path {
        validate_path(o)?;
        args.push(o);
    }
    let raw = git.read(&args)?;
    Ok(first_file(&raw, path))
}

fn worktree_raw(git: &Git, path: &str, orig_path: Option<&str>, staged: bool, untracked: bool) -> Result<RawFile> {
    validate_path(path)?;
    if untracked {
        let out = git.run(
            &["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path],
            RunOpts { allow_fail: true, ..RunOpts::read() },
        )?;
        let mut f = parse_first_raw(&out.stdout, path);
        f.path = path.to_string();
        f.status = 'A';
        return Ok(f);
    }
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    if let Some(o) = orig_path {
        validate_path(o)?;
        args.push(o);
    }
    let raw = git.read(&args)?;
    Ok(parse_first_raw(&raw, path))
}

pub fn worktree_diff(git: &Git, path: &str, orig_path: Option<&str>, staged: bool, untracked: bool) -> Result<FileDiff> {
    Ok(worktree_raw(git, path, orig_path, staged, untracked)?.to_display())
}

// ---------------------------------------------------------------- refs

pub fn refs(git: &Git) -> Result<Refs> {
    let raw = git.read(&["for-each-ref", REF_FORMAT, "refs/heads", "refs/remotes", "refs/tags"])?;
    let (branches, tags) = parse::parse_refs(&raw);
    let remotes = parse::parse_remotes(&git.read_str(&["remote", "-v"])?);
    let stashes = parse::parse_stashes(&git.read_str(&["stash", "list", STASH_FORMAT]).unwrap_or_default());
    Ok(Refs { branches, tags, remotes, stashes })
}

// ---------------------------------------------------------------- staging

pub fn stage_files(git: &Git, paths: &[String]) -> Result<()> {
    validate_paths(paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git.write(&args)?;
    Ok(())
}

pub fn unstage_files(git: &Git, paths: &[String]) -> Result<()> {
    validate_paths(paths)?;
    let mut args: Vec<&str> =
        if head_exists(git) { vec!["reset", "-q", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git.write(&args)?;
    Ok(())
}

pub fn stage_lines(git: &Git, path: &str, sel: &[HunkSelection]) -> Result<()> {
    let raw = worktree_raw(git, path, None, false, false)?;
    apply_selection(git, &raw, sel, PatchMode::Forward, &["apply", "--cached", "--recount", "--whitespace=nowarn", "-"])
}

pub fn unstage_lines(git: &Git, path: &str, sel: &[HunkSelection]) -> Result<()> {
    let raw = worktree_raw(git, path, None, true, false)?;
    apply_selection(
        git,
        &raw,
        sel,
        PatchMode::Reverse,
        &["apply", "--cached", "--reverse", "--recount", "--whitespace=nowarn", "-"],
    )
}

pub fn discard_lines(git: &Git, path: &str, sel: &[HunkSelection], trash: &Path) -> Result<()> {
    let raw = worktree_raw(git, path, None, false, false)?;
    backup_file(&git.cwd, path, trash)?;
    apply_selection(git, &raw, sel, PatchMode::Reverse, &["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"])
}

fn apply_selection(git: &Git, raw: &RawFile, sel: &[HunkSelection], mode: PatchMode, args: &[&str]) -> Result<()> {
    if raw.hunks.is_empty() {
        return Err(AppError::invalid("path", "The file no longer has changes, reload it"));
    }
    match diff::build_patch(raw, sel, mode)? {
        Some(patch) => {
            git.write_stdin(args, patch)?;
            Ok(())
        }
        None => Err(AppError::invalid("lines", "No changed lines selected")),
    }
}

/// Sao lưu file vào thùng rác của app trước khi discard.
fn backup_file(workdir: &Path, rel: &str, trash: &Path) -> Result<()> {
    let src = workdir.join(rel);
    if !src.exists() {
        return Ok(());
    }
    let dst = trash.join(rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if src.is_dir() {
        copy_dir(&src, &dst)?;
    } else {
        std::fs::copy(&src, &dst)?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &dst.join(e.file_name()))?;
        } else {
            std::fs::copy(&p, dst.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// Bỏ thay đổi chưa stage của các file (file untracked bị xoá). Mọi file được sao lưu trước.
pub fn discard_files(git: &Git, git_dir: &Path, paths: &[String], trash: &Path) -> Result<()> {
    validate_paths(paths)?;
    let st = status(git, git_dir)?;
    let mut tracked = Vec::new();
    for p in paths {
        backup_file(&git.cwd, p, trash)?;
        let untracked = st.entries.iter().any(|e| &e.path == p && e.index == '?')
            || st.entries.iter().any(|e| e.index == '?' && e.path.ends_with('/') && p.starts_with(&e.path));
        if untracked {
            let full = git.cwd.join(p);
            if full.is_dir() {
                std::fs::remove_dir_all(&full)?;
            } else if full.exists() {
                std::fs::remove_file(&full)?;
            }
        } else {
            tracked.push(p.as_str());
        }
    }
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(tracked);
        git.write(&args)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- commit

pub fn commit(git: &Git, message: &str, amend: bool) -> Result<String> {
    let msg = message.trim();
    if msg.is_empty() && !amend {
        return Err(AppError::invalid("message", "Commit message cannot be empty"));
    }
    if msg.is_empty() {
        git.write(&["commit", "--amend", "--no-edit"])?;
    } else {
        let mut args = vec!["commit", "-F", "-", "--cleanup=strip"];
        if amend {
            args.push("--amend");
        }
        git.write_stdin(&args, msg.as_bytes().to_vec())?;
    }
    Ok(head_sha(git).unwrap_or_default())
}

pub fn head_message(git: &Git) -> Result<String> {
    if !head_exists(git) {
        return Ok(String::new());
    }
    Ok(git.read_str(&["log", "-1", "--format=%B"])?.trim_end().to_string())
}

pub fn undo_last_commit(git: &Git) -> Result<()> {
    let has_parent = git
        .run(&["rev-parse", "--verify", "-q", "HEAD~1"], RunOpts { allow_fail: true, ..RunOpts::read() })?
        .ok();
    if !has_parent {
        return Err(AppError::invalid("HEAD", "The first commit cannot be undone with reset"));
    }
    git.write(&["reset", "--soft", "HEAD~1"])?;
    Ok(())
}

// ---------------------------------------------------------------- branches / tags

pub fn checkout_branch(git: &Git, name: &str, remote: bool) -> Result<()> {
    validate_rev(name)?;
    if remote {
        let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
        let exists = git
            .run(
                &["show-ref", "--verify", "-q", &format!("refs/heads/{local}")],
                RunOpts { allow_fail: true, ..RunOpts::read() },
            )?
            .ok();
        if exists {
            git.write(&["switch", local])?;
        } else {
            git.write(&["switch", "--track", name])?;
        }
    } else {
        git.write(&["switch", name])?;
    }
    Ok(())
}

pub fn checkout_commit(git: &Git, sha: &str) -> Result<()> {
    validate_rev(sha)?;
    git.write(&["switch", "--detach", sha])?;
    Ok(())
}

pub fn create_branch(git: &Git, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
    validate_branch_name(git, name)?;
    let start = start.unwrap_or("HEAD");
    validate_rev(start)?;
    if checkout {
        git.write(&["switch", "-c", name, start])?;
    } else {
        git.write(&["branch", name, start])?;
    }
    Ok(())
}

pub fn rename_branch(git: &Git, old: &str, new: &str) -> Result<()> {
    validate_rev(old)?;
    validate_branch_name(git, new)?;
    git.write(&["branch", "-m", old, new])?;
    Ok(())
}

pub fn delete_branch(git: &Git, name: &str, force: bool) -> Result<()> {
    validate_rev(name)?;
    git.write(&["branch", if force { "-D" } else { "-d" }, name])?;
    Ok(())
}

pub fn create_tag(git: &Git, name: &str, target: &str, message: Option<&str>) -> Result<()> {
    validate_tag_name(git, name)?;
    validate_rev(target)?;
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => git.write(&["tag", "-a", name, "-m", m, target])?,
        None => git.write(&["tag", name, target])?,
    };
    Ok(())
}

pub fn delete_tag(git: &Git, name: &str) -> Result<()> {
    validate_rev(name)?;
    git.write(&["tag", "-d", name])?;
    Ok(())
}

// ---------------------------------------------------------------- stash

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

pub fn stash_push(git: &Git, message: Option<&str>, include_untracked: bool, paths: &[String]) -> Result<String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    let msg;
    if let Some(m) = message.map(str::trim).filter(|m| !m.is_empty()) {
        msg = m.to_string();
        args.push("-m");
        args.push(&msg);
    }
    if !paths.is_empty() {
        validate_paths(paths)?;
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    let out = git.write(&args)?;
    Ok(format!("{}{}", out.text(), out.stderr))
}

pub fn stash_apply(git: &Git, index: u32, pop: bool) -> Result<()> {
    let r = stash_ref(index);
    git.write(&["stash", if pop { "pop" } else { "apply" }, &r])?;
    Ok(())
}

pub fn stash_drop(git: &Git, index: u32) -> Result<()> {
    let r = stash_ref(index);
    git.write(&["stash", "drop", &r])?;
    Ok(())
}

// ---------------------------------------------------------------- remote (network)

pub struct NetOpts {
    pub cancel: Arc<AtomicBool>,
    pub on_progress: LineSink,
}

fn net(git: &Git, args: &[&str], o: NetOpts) -> Result<String> {
    let out = git.run(
        args,
        RunOpts { timeout: None, cancel: Some(o.cancel), on_stderr: Some(o.on_progress), ..Default::default() },
    )?;
    Ok(format!("{}{}", out.text(), out.stderr))
}

pub fn fetch(git: &Git, remote: Option<&str>, o: NetOpts) -> Result<String> {
    match remote {
        Some(r) => {
            validate_rev(r)?;
            net(git, &["fetch", "--prune", "--progress", r], o)
        }
        None => net(git, &["fetch", "--all", "--prune", "--progress"], o),
    }
}

/// mode: "ff-only" | "rebase" | "merge"
pub fn pull(git: &Git, mode: &str, o: NetOpts) -> Result<String> {
    let flag = match mode {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    net(git, &["pull", "--progress", flag], o)
}

pub fn push(git: &Git, git_dir: &Path, force: bool, o: NetOpts) -> Result<String> {
    let st = status(git, git_dir)?;
    let branch = st.branch.ok_or_else(|| AppError::invalid("HEAD", "Detached HEAD: there is no branch to push"))?;
    let mut args = vec!["push", "--progress"];
    if force {
        args.push("--force-with-lease");
    }
    let remote;
    if st.upstream.is_none() {
        let remotes = remote_names(git);
        remote = if remotes.iter().any(|r| r == "origin") {
            "origin".to_string()
        } else {
            remotes.first().cloned().ok_or_else(|| AppError::invalid("remote", "The repository has no remotes"))?
        };
        args.extend(["-u", remote.as_str(), branch.as_str()]);
    }
    net(git, &args, o)
}

pub fn push_tag(git: &Git, remote: &str, tag: &str, o: NetOpts) -> Result<String> {
    validate_rev(remote)?;
    validate_rev(tag)?;
    let r = format!("refs/tags/{tag}");
    net(git, &["push", "--progress", remote, &r], o)
}

pub fn delete_remote_branch(git: &Git, remote_branch: &str, o: NetOpts) -> Result<String> {
    validate_rev(remote_branch)?;
    let (remote, branch) = remote_branch
        .split_once('/')
        .ok_or_else(|| AppError::invalid("branch", "expected remote/branch"))?;
    net(git, &["push", "--progress", remote, "--delete", branch], o)
}

pub fn add_remote(git: &Git, name: &str, url: &str) -> Result<()> {
    validate_rev(name)?;
    if url.starts_with('-') || url.trim().is_empty() {
        return Err(AppError::invalid("url", "invalid URL"));
    }
    git.write(&["remote", "add", name, url.trim()])?;
    Ok(())
}

// ---------------------------------------------------------------- merge / rebase / history edit

pub fn merge(git: &Git, name: &str) -> Result<String> {
    validate_rev(name)?;
    let out = git.write(&["-c", "merge.conflictStyle=zdiff3", "merge", "--no-edit", name])?;
    Ok(format!("{}{}", out.text(), out.stderr))
}

pub fn rebase(git: &Git, onto: &str) -> Result<String> {
    validate_rev(onto)?;
    let out = git.write(&["-c", "merge.conflictStyle=zdiff3", "rebase", onto])?;
    Ok(format!("{}{}", out.text(), out.stderr))
}

pub fn cherry_pick(git: &Git, sha: &str) -> Result<()> {
    validate_rev(sha)?;
    git.write(&["-c", "merge.conflictStyle=zdiff3", "cherry-pick", sha])?;
    Ok(())
}

pub fn revert(git: &Git, sha: &str) -> Result<()> {
    validate_rev(sha)?;
    let parents = git.read_str(&["rev-list", "--parents", "-n", "1", sha])?;
    if parents.split_whitespace().count() > 2 {
        git.write(&["revert", "--no-edit", "-m", "1", sha])?;
    } else {
        git.write(&["revert", "--no-edit", sha])?;
    }
    Ok(())
}

/// action: continue | abort | skip
pub fn sequencer(git: &Git, git_dir: &Path, action: &str) -> Result<()> {
    let ip = in_progress(git_dir).ok_or_else(|| AppError::invalid("state", "No operation in progress"))?;
    let flag = match action {
        "continue" => "--continue",
        "abort" => "--abort",
        "skip" => "--skip",
        _ => return Err(AppError::invalid("action", action.to_string())),
    };
    match (ip.kind.as_str(), action) {
        ("merge", "continue") => git.write(&["commit", "--no-edit"])?,
        ("merge", "abort") => git.write(&["merge", "--abort"])?,
        ("merge", _) => return Err(AppError::invalid("action", "merge does not support skip")),
        (kind, _) => git.write(&[kind, flag])?,
    };
    Ok(())
}

/// mode: soft | mixed | hard. Với hard, tự stash nếu worktree bẩn để có đường lui.
pub fn reset(git: &Git, git_dir: &Path, target: &str, mode: &str) -> Result<Option<String>> {
    validate_rev(target)?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err(AppError::invalid("mode", mode.to_string())),
    };
    let mut autosave = None;
    if mode == "hard" {
        let st = status(git, git_dir)?;
        if !st.entries.is_empty() {
            let msg = format!("git-cyclone autosave before reset --hard {target}");
            git.write(&["stash", "push", "-u", "-m", &msg])?;
            autosave = Some(msg);
        }
    }
    git.write(&["reset", flag, target])?;
    Ok(autosave)
}

// ---------------------------------------------------------------- conflict

fn show_stage(git: &Git, stage: u8, path: &str) -> Option<Vec<u8>> {
    let spec = format!(":{stage}:{path}");
    git.run(&["show", &spec], RunOpts { allow_fail: true, ..RunOpts::read() }).ok().filter(|o| o.ok()).map(|o| o.stdout)
}

pub fn conflict_file(git: &Git, path: &str) -> Result<ConflictFile> {
    validate_path(path)?;
    let base = show_stage(git, 1, path);
    let ours = show_stage(git, 2, path);
    let theirs = show_stage(git, 3, path);
    let merged = std::fs::read(git.cwd.join(path)).ok();
    let binary = [&base, &ours, &theirs, &merged].iter().any(|b| b.as_ref().is_some_and(|b| b.contains(&0)));
    let s = |b: Option<Vec<u8>>| b.map(|b| String::from_utf8_lossy(&b).into_owned());
    Ok(ConflictFile { path: path.into(), base: s(base), ours: s(ours), theirs: s(theirs), merged: s(merged), binary })
}

pub fn resolve_with_content(git: &Git, path: &str, content: &str) -> Result<()> {
    validate_path(path)?;
    std::fs::write(git.cwd.join(path), content.as_bytes())?;
    git.write(&["add", "--", path])?;
    Ok(())
}

/// side: ours | theirs
pub fn resolve_take(git: &Git, path: &str, side: &str) -> Result<()> {
    validate_path(path)?;
    let stage = match side {
        "ours" => 2,
        "theirs" => 3,
        _ => return Err(AppError::invalid("side", side.to_string())),
    };
    if show_stage(git, stage, path).is_none() {
        // phía được chọn đã xoá file
        git.write(&["rm", "-q", "--", path])?;
    } else {
        let flag = format!("--{side}");
        git.write(&["checkout", &flag, "--", path])?;
        git.write(&["add", "--", path])?;
    }
    Ok(())
}

// ---------------------------------------------------------------- blame

pub fn blame(git: &Git, path: &str, rev: Option<&str>) -> Result<Vec<BlameLine>> {
    validate_path(path)?;
    let mut args = vec!["blame", "--porcelain", "-w"];
    if let Some(r) = rev {
        validate_rev(r)?;
        args.push(r);
    }
    args.push("--");
    args.push(path);
    Ok(parse::parse_blame(&git.read(&args)?))
}
