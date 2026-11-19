//! Test tích hợp: chạy git thật trên repo tạm.

use git_cyclone_lib::git::model::HunkSelection;
use git_cyclone_lib::git::ops;
use git_cyclone_lib::git::runner::Git;
use std::path::Path;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().expect("git");
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn repo() -> (tempfile::TempDir, Git) {
    let d = tempfile::tempdir().unwrap();
    sh(d.path(), &["init", "-q", "-b", "main"]);
    sh(d.path(), &["config", "user.name", "Test"]);
    sh(d.path(), &["config", "user.email", "t@example.com"]);
    sh(d.path(), &["config", "core.autocrlf", "false"]);
    let (top, _) = ops::discover(d.path()).unwrap();
    (d, Git::new(top))
}

fn write(g: &Git, p: &str, s: &str) {
    std::fs::write(g.cwd.join(p), s).unwrap();
}

fn all_changes(d: &git_cyclone_lib::git::model::FileDiff, hunk: usize) -> HunkSelection {
    let h = &d.hunks[hunk];
    HunkSelection {
        hunk,
        header: h.header.clone(),
        lines: h.lines.iter().enumerate().filter(|(_, l)| l.kind == '+' || l.kind == '-').map(|(i, _)| i).collect(),
    }
}

#[test]
fn empty_repo_works() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    let st = ops::status(&g, &gd).unwrap();
    assert!(st.oid.is_none());
    assert_eq!(st.branch.as_deref(), Some("main"));
    let graph = ops::log_graph(&g, 100).unwrap();
    assert!(graph.rows.is_empty());
    write(&g, "a.txt", "hi\n");
    ops::stage_files(&g, &["a.txt".into()]).unwrap();
    ops::unstage_files(&g, &["a.txt".into()]).unwrap(); // repo chưa có HEAD
    ops::stage_files(&g, &["a.txt".into()]).unwrap();
    let sha = ops::commit(&g, "first", false).unwrap();
    assert_eq!(sha.len(), 40);
}

#[test]
fn line_level_staging() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    write(&g, "f.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    ops::stage_files(&g, &["f.txt".into()]).unwrap();
    ops::commit(&g, "init", false).unwrap();

    write(&g, "f.txt", "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n");
    let d = ops::worktree_diff(&g, "f.txt", None, false, false).unwrap();
    assert_eq!(d.hunks.len(), 1, "{:?}", d.hunks);
    let h = &d.hunks[0];
    // chỉ chọn cặp dòng 2 -> TWO
    let idx: Vec<usize> = h
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| (l.kind == '-' && l.text == "2") || (l.kind == '+' && l.text == "TWO"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(idx.len(), 2);
    ops::stage_lines(&g, "f.txt", &[HunkSelection { hunk: 0, header: h.header.clone(), lines: idx }]).unwrap();

    let index = sh(&g.cwd, &["show", ":f.txt"]);
    assert_eq!(index, "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
    let st = ops::status(&g, &gd).unwrap();
    assert_eq!(st.entries[0].index, 'M');
    assert_eq!(st.entries[0].worktree, 'M');

    // unstage lại đúng dòng đó
    let sd = ops::worktree_diff(&g, "f.txt", None, true, false).unwrap();
    ops::unstage_lines(&g, "f.txt", &[all_changes(&sd, 0)]).unwrap();
    assert_eq!(sh(&g.cwd, &["show", ":f.txt"]), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");

    // discard chỉ dòng NINE trong worktree
    let d = ops::worktree_diff(&g, "f.txt", None, false, false).unwrap();
    let h = &d.hunks[0];
    let idx: Vec<usize> = h
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| (l.kind == '-' && l.text == "9") || (l.kind == '+' && l.text == "NINE"))
        .map(|(i, _)| i)
        .collect();
    let trash = tempfile::tempdir().unwrap();
    ops::discard_lines(&g, "f.txt", &[HunkSelection { hunk: 0, header: h.header.clone(), lines: idx }], trash.path())
        .unwrap();
    assert_eq!(std::fs::read_to_string(g.cwd.join("f.txt")).unwrap(), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
    assert!(trash.path().join("f.txt").exists(), "file phải được sao lưu");
}

#[test]
fn crlf_and_unicode_paths() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    let name = "thư mục/tệp có dấu.txt";
    std::fs::create_dir_all(g.cwd.join("thư mục")).unwrap();
    write(&g, name, "a\r\nb\r\nc\r\n");
    ops::stage_files(&g, &[name.into()]).unwrap();
    ops::commit(&g, "crlf", false).unwrap();
    write(&g, name, "a\r\nB\r\nc\r\nd\r\n");
    let st = ops::status(&g, &gd).unwrap();
    assert_eq!(st.entries[0].path, name);
    let d = ops::worktree_diff(&g, name, None, false, false).unwrap();
    assert_eq!(d.path, name);
    // stage riêng dòng "d" được thêm
    let h = &d.hunks[0];
    let idx: Vec<usize> =
        h.lines.iter().enumerate().filter(|(_, l)| l.kind == '+' && l.text == "d").map(|(i, _)| i).collect();
    ops::stage_lines(&g, name, &[HunkSelection { hunk: 0, header: h.header.clone(), lines: idx }]).unwrap();
    let spec = format!(":{name}");
    assert_eq!(sh(&g.cwd, &["show", &spec]), "a\r\nb\r\nc\r\nd\r\n");
}

#[test]
fn untracked_diff_and_discard() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    write(&g, "keep.txt", "x\n");
    ops::stage_files(&g, &["keep.txt".into()]).unwrap();
    ops::commit(&g, "c", false).unwrap();
    write(&g, "new.txt", "hello\nworld\n");
    let d = ops::worktree_diff(&g, "new.txt", None, false, true).unwrap();
    assert_eq!(d.status, 'A');
    assert_eq!(d.hunks[0].lines.len(), 2);
    write(&g, "keep.txt", "changed\n");
    let trash = tempfile::tempdir().unwrap();
    ops::discard_files(&g, &gd, &["new.txt".into(), "keep.txt".into()], trash.path()).unwrap();
    assert!(!g.cwd.join("new.txt").exists());
    assert_eq!(std::fs::read_to_string(g.cwd.join("keep.txt")).unwrap(), "x\n");
    assert!(trash.path().join("new.txt").exists());
}

#[test]
fn branches_merge_graph_and_conflict() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    write(&g, "f.txt", "base\n");
    ops::stage_files(&g, &["f.txt".into()]).unwrap();
    ops::commit(&g, "base", false).unwrap();

    ops::create_branch(&g, "feat/x", None, true).unwrap();
    write(&g, "f.txt", "feature\n");
    ops::stage_files(&g, &["f.txt".into()]).unwrap();
    ops::commit(&g, "feature change", false).unwrap();

    ops::checkout_branch(&g, "main", false).unwrap();
    write(&g, "f.txt", "main\n");
    ops::stage_files(&g, &["f.txt".into()]).unwrap();
    ops::commit(&g, "main change", false).unwrap();

    let err = ops::merge(&g, "feat/x").unwrap_err();
    assert_eq!(err.kind(), "mergeConflict", "{err:?}");
    let st = ops::status(&g, &gd).unwrap();
    assert_eq!(st.in_progress.as_ref().map(|p| p.kind.as_str()), Some("merge"));
    assert!(st.entries[0].conflict.is_some());

    let c = ops::conflict_file(&g, "f.txt").unwrap();
    assert_eq!(c.ours.as_deref(), Some("main\n"));
    assert_eq!(c.theirs.as_deref(), Some("feature\n"));
    assert_eq!(c.base.as_deref(), Some("base\n"));
    ops::resolve_with_content(&g, "f.txt", "main+feature\n").unwrap();
    ops::sequencer(&g, &gd, "continue").unwrap();
    assert!(ops::status(&g, &gd).unwrap().in_progress.is_none());

    let graph = ops::log_graph(&g, 100).unwrap();
    assert_eq!(graph.rows.len(), 4);
    assert_eq!(graph.rows[0].commit.parents.len(), 2);
    assert_eq!(graph.max_lanes, 2);
    assert!(graph.rows[0].commit.refs.iter().any(|r| r.kind == "branch" && r.name == "main" && r.current));

    let refs = ops::refs(&g).unwrap();
    assert_eq!(refs.branches.len(), 2);
    assert!(refs.branches.iter().any(|b| b.name == "main" && b.current));

    // xoá nhánh đã merge, tag, stash
    ops::delete_branch(&g, "feat/x", false).unwrap();
    ops::create_tag(&g, "v1.0", "HEAD", Some("release")).unwrap();
    assert!(ops::refs(&g).unwrap().tags.iter().any(|t| t.name == "v1.0" && t.annotated));
    write(&g, "f.txt", "dirty\n");
    ops::stash_push(&g, Some("wip"), true, &[]).unwrap();
    let refs = ops::refs(&g).unwrap();
    assert_eq!(refs.stashes.len(), 1);
    assert!(refs.stashes[0].message.contains("wip"));
    ops::stash_apply(&g, 0, true).unwrap();
    assert_eq!(std::fs::read_to_string(g.cwd.join("f.txt")).unwrap(), "dirty\n");

    // reset --hard có autosave
    let saved = ops::reset(&g, &gd, "HEAD", "hard").unwrap();
    assert!(saved.is_some());
    assert_eq!(ops::refs(&g).unwrap().stashes.len(), 1);
}

#[test]
fn rejects_injection() {
    let (_d, g) = repo();
    assert!(ops::create_branch(&g, "--force", None, false).is_err());
    assert!(ops::checkout_commit(&g, "-x").is_err());
    assert!(ops::stage_files(&g, &["../outside".into()]).is_err());
    assert!(ops::stage_files(&g, &["C:/Windows".into()]).is_err());
}

#[test]
fn push_pull_with_local_bare_remote() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    let bare = tempfile::tempdir().unwrap();
    sh(bare.path(), &["init", "-q", "--bare", "-b", "main"]);
    write(&g, "a.txt", "1\n");
    ops::stage_files(&g, &["a.txt".into()]).unwrap();
    ops::commit(&g, "c1", false).unwrap();
    ops::add_remote(&g, "origin", &bare.path().display().to_string()).unwrap();
    let net = || ops::NetOpts { cancel: Default::default(), on_progress: Box::new(|_| {}) };
    ops::push(&g, &gd, false, net()).unwrap();
    let st = ops::status(&g, &gd).unwrap();
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    ops::fetch(&g, None, net()).unwrap();
    ops::pull(&g, "ff-only", net()).unwrap();
}

#[test]
fn status_hides_line_ending_only_changes() {
    let (_d, g) = repo();
    let gd = ops::discover(&g.cwd).unwrap().1;
    sh(&g.cwd, &["config", "core.autocrlf", "true"]);
    write(&g, "eol.txt", "a\r\nb\r\nc\r\n");
    write(&g, "real.txt", "x\r\ny\r\n");
    write(&g, "both.txt", "one\r\n");
    ops::stage_files(&g, &["eol.txt".into(), "real.txt".into(), "both.txt".into()]).unwrap();
    ops::commit(&g, "init", false).unwrap();

    write(&g, "eol.txt", "a\nb\nc\n"); // cùng nội dung, chỉ khác kiểu xuống dòng (kích thước đổi)
    write(&g, "real.txt", "x\ny\nz\n"); // sửa thật
    write(&g, "both.txt", "two\r\n");
    ops::stage_files(&g, &["both.txt".into()]).unwrap();
    write(&g, "both.txt", "two\n"); // đã stage + worktree chỉ khác kiểu xuống dòng

    let st = ops::status(&g, &gd).unwrap();
    let find = |p: &str| st.entries.iter().find(|e| e.path == p);
    assert!(find("eol.txt").is_none(), "phantom change must be hidden: {:?}", st.entries);
    assert_eq!(find("real.txt").map(|e| (e.index, e.worktree)), Some(('.', 'M')));
    assert_eq!(find("both.txt").map(|e| (e.index, e.worktree)), Some(('M', '.')));
}
