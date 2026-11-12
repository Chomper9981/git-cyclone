//! Parser cho output máy-đọc của git.

use super::model::*;

pub const FS: char = '\x1f'; // tách field
pub const RS: char = '\x1e'; // tách record

/// Bỏ dấu ngoặc kép kiểu C mà git dùng cho path đặc biệt (`"a\tb"`, `"\303\241"`).
pub fn unquote_path(s: &str) -> String {
    let s = s.trim_end_matches(['\r', '\n']);
    if !(s.len() >= 2 && s.starts_with('"') && s.ends_with('"')) {
        return s.to_string();
    }
    let inner = &s.as_bytes()[1..s.len() - 1];
    let mut out = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        let b = inner[i];
        if b == b'\\' && i + 1 < inner.len() {
            let n = inner[i + 1];
            match n {
                b'n' => { out.push(b'\n'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'r' => { out.push(b'\r'); i += 2; }
                b'"' => { out.push(b'"'); i += 2; }
                b'\\' => { out.push(b'\\'); i += 2; }
                b'a' => { out.push(7); i += 2; }
                b'b' => { out.push(8); i += 2; }
                b'f' => { out.push(12); i += 2; }
                b'v' => { out.push(11); i += 2; }
                b'0'..=b'7' if i + 4 <= inner.len() => {
                    let oct = std::str::from_utf8(&inner[i + 1..i + 4]).unwrap_or("0");
                    out.push(u8::from_str_radix(oct, 8).unwrap_or(b'?'));
                    i += 4;
                }
                _ => { out.push(n); i += 2; }
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------- status

/// Parse `git status --porcelain=v2 --branch --show-stash -z`.
pub fn parse_status(raw: &[u8]) -> RepoStatus {
    let mut st = RepoStatus::default();
    let text = String::from_utf8_lossy(raw);
    let mut recs = text.split('\0').peekable();
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let (key, val) = h.split_once(' ').unwrap_or((h, ""));
            match key {
                "branch.oid" => st.oid = (val != "(initial)").then(|| val.to_string()),
                "branch.head" => {
                    if val == "(detached)" {
                        st.detached = true;
                    } else {
                        st.branch = Some(val.to_string());
                    }
                }
                "branch.upstream" => st.upstream = Some(val.to_string()),
                "branch.ab" => {
                    for part in val.split(' ') {
                        if let Some(a) = part.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = part.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                "stash" => st.stash_count = val.parse().unwrap_or(0),
                _ => {}
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.entries.push(entry_from_xy(f[1], f[2], f[8], None, None));
                }
            }
            b'2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                if f.len() == 10 {
                    let orig = recs.next().map(|s| s.to_string());
                    st.entries.push(entry_from_xy(f[1], f[2], f[9], orig, None));
                }
            }
            b'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.entries.push(entry_from_xy(f[1], f[2], f[10], None, Some(f[1].to_string())));
                }
            }
            b'?' => st.entries.push(StatusEntry {
                path: rec[2..].to_string(),
                index: '?',
                worktree: '?',
                ..Default::default()
            }),
            _ => {} // '!' ignored
        }
    }
    st
}

fn entry_from_xy(xy: &str, sub: &str, path: &str, orig: Option<String>, conflict: Option<String>) -> StatusEntry {
    let mut c = xy.chars();
    StatusEntry {
        path: path.to_string(),
        orig_path: orig,
        index: c.next().unwrap_or('.'),
        worktree: c.next().unwrap_or('.'),
        conflict,
        submodule: sub.starts_with('S'),
    }
}

// ---------------------------------------------------------------- log

pub const LOG_FORMAT: &str = "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

/// Parse output của `git log` với [`LOG_FORMAT`].
pub fn parse_log(raw: &[u8], remotes: &[String]) -> Vec<Commit> {
    let text = String::from_utf8_lossy(raw);
    text.split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.splitn(7, FS).collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author_name: f[2].to_string(),
                author_email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                refs: parse_decorations(f[5], remotes),
                subject: f[6].to_string(),
            })
        })
        .collect()
}

/// Parse `%D`: "HEAD -> main, origin/main, tag: v1.0, origin/HEAD".
pub fn parse_decorations(d: &str, remotes: &[String]) -> Vec<RefLabel> {
    let mut out = Vec::new();
    for part in d.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(b) = part.strip_prefix("HEAD -> ") {
            out.push(RefLabel { kind: "head".into(), name: "HEAD".into(), current: true });
            out.push(RefLabel { kind: "branch".into(), name: b.into(), current: true });
        } else if part == "HEAD" {
            out.push(RefLabel { kind: "head".into(), name: "HEAD".into(), current: true });
        } else if let Some(t) = part.strip_prefix("tag: ") {
            out.push(RefLabel { kind: "tag".into(), name: t.into(), current: false });
        } else if part.ends_with("/HEAD") && remotes.iter().any(|r| part == format!("{r}/HEAD")) {
            continue;
        } else if remotes.iter().any(|r| part.starts_with(&format!("{r}/"))) {
            out.push(RefLabel { kind: "remote".into(), name: part.into(), current: false });
        } else {
            out.push(RefLabel { kind: "branch".into(), name: part.into(), current: false });
        }
    }
    out
}

// ---------------------------------------------------------------- refs

pub const REF_FORMAT: &str =
    "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)";

pub fn parse_refs(raw: &[u8]) -> (Vec<Branch>, Vec<Tag>) {
    let text = String::from_utf8_lossy(raw);
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(FS).collect();
        if f.len() < 6 {
            continue;
        }
        let refname = f[0];
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(f[4]);
            branches.push(Branch {
                name: name.into(),
                full_name: refname.into(),
                sha: f[1].into(),
                remote: false,
                current: f[5] == "*",
                upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
                ahead,
                behind,
                upstream_gone: gone,
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            branches.push(Branch {
                name: name.into(),
                full_name: refname.into(),
                sha: f[1].into(),
                remote: true,
                ..Default::default()
            });
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            let annotated = !f[2].is_empty();
            tags.push(Tag {
                name: name.into(),
                sha: if annotated { f[2].into() } else { f[1].into() },
                annotated,
            });
        }
    }
    (branches, tags)
}

/// "ahead 2, behind 1" | "gone" | ""
fn parse_track(s: &str) -> (u32, u32, bool) {
    if s == "gone" {
        return (0, 0, true);
    }
    let mut a = 0;
    let mut b = 0;
    for part in s.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            a = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            b = n.parse().unwrap_or(0);
        }
    }
    (a, b, false)
}

pub fn parse_remotes(text: &str) -> Vec<Remote> {
    let mut out: Vec<Remote> = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (it.next(), it.next(), it.next()) else { continue };
        let r = match out.iter_mut().find(|r| r.name == name) {
            Some(r) => r,
            None => {
                out.push(Remote { name: name.into(), fetch_url: String::new(), push_url: String::new() });
                out.last_mut().unwrap()
            }
        };
        if kind == "(fetch)" {
            r.fetch_url = url.into();
        } else {
            r.push_url = url.into();
        }
    }
    out
}

pub const STASH_FORMAT: &str = "--format=%gd%x1f%H%x1f%at%x1f%gs";

pub fn parse_stashes(text: &str) -> Vec<Stash> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, FS).collect();
            if f.len() < 4 {
                return None;
            }
            let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
            Some(Stash {
                index,
                name: f[0].into(),
                sha: f[1].into(),
                time: f[2].parse().unwrap_or(0),
                message: f[3].into(),
            })
        })
        .collect()
}

/// Parse `--name-status -z` (có -M): "M\0path\0R100\0old\0new\0".
pub fn parse_name_status(raw: &[u8]) -> Vec<ChangedFile> {
    let text = String::from_utf8_lossy(raw);
    let mut it = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(code) = it.next() {
        let status = code.chars().next().unwrap_or('M');
        if status == 'R' || status == 'C' {
            let (Some(old), Some(new)) = (it.next(), it.next()) else { break };
            out.push(ChangedFile { status, path: new.into(), orig_path: Some(old.into()) });
        } else {
            let Some(p) = it.next() else { break };
            out.push(ChangedFile { status, path: p.into(), orig_path: None });
        }
    }
    out
}

/// Parse `git blame --porcelain`.
pub fn parse_blame(raw: &[u8]) -> Vec<BlameLine> {
    use std::collections::HashMap;
    #[derive(Default, Clone)]
    struct Info {
        author: String,
        time: i64,
        summary: String,
    }
    let text = String::from_utf8_lossy(raw);
    let mut infos: HashMap<String, Info> = HashMap::new();
    let mut out = Vec::new();
    let mut cur_sha = String::new();
    let mut cur_line = 0u32;
    for line in text.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            let info = infos.get(&cur_sha).cloned().unwrap_or_default();
            out.push(BlameLine {
                sha: cur_sha.clone(),
                author: info.author,
                time: info.time,
                summary: info.summary,
                line_no: cur_line,
                text: content.trim_end_matches('\r').to_string(),
            });
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let first = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            cur_sha = first.to_string();
            cur_line = rest.split(' ').nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            infos.entry(cur_sha.clone()).or_default();
        } else if let Some(info) = infos.get_mut(&cur_sha) {
            match first {
                "author" => info.author = rest.to_string(),
                "author-time" => info.time = rest.parse().unwrap_or(0),
                "summary" => info.summary = rest.to_string(),
                _ => {}
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0# stash 3\0\
1 .M N... 100644 100644 100644 aaa aaa src/a b.rs\0\
2 R. N... 100644 100644 100644 aaa aaa R100 new name.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conf.txt\0? t\xc3\xa1p.txt\0";
        let st = parse_status(raw);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind, st.stash_count), (2, 1, 3));
        assert_eq!(st.entries.len(), 4);
        assert_eq!(st.entries[0].path, "src/a b.rs");
        assert_eq!(st.entries[0].worktree, 'M');
        assert_eq!(st.entries[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(st.entries[1].path, "new name.rs");
        assert_eq!(st.entries[2].conflict.as_deref(), Some("UU"));
        assert_eq!(st.entries[3].path, "táp.txt");
    }

    #[test]
    fn decorations() {
        let r = parse_decorations("HEAD -> main, origin/main, tag: v1, origin/HEAD, feat/x", &["origin".into()]);
        let names: Vec<_> = r.iter().map(|r| (r.kind.as_str(), r.name.as_str())).collect();
        assert_eq!(
            names,
            vec![("head", "HEAD"), ("branch", "main"), ("remote", "origin/main"), ("tag", "v1"), ("branch", "feat/x")]
        );
    }

    #[test]
    fn log_parse() {
        let raw = "a1\x1fp1 p2\x1fAn\x1fa@x\x1f100\x1f\x1fsubject with \x1f weird\x1e\nb2\x1f\x1fB\x1fb@x\x1f50\x1ftag: v1\x1froot\x1e";
        let c = parse_log(raw.as_bytes(), &[]);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["p1", "p2"]);
        assert_eq!(c[0].subject, "subject with \x1f weird");
        assert!(c[1].parents.is_empty());
        assert_eq!(c[1].refs[0].kind, "tag");
    }

    #[test]
    fn unquote() {
        assert_eq!(unquote_path("\"a\\tb\""), "a\tb");
        assert_eq!(unquote_path("\"\\303\\241\""), "á");
        assert_eq!(unquote_path("plain"), "plain");
    }

    #[test]
    fn name_status() {
        let v = parse_name_status(b"M\0a.txt\0R090\0old\0new\0A\0b\0");
        assert_eq!(v.len(), 3);
        assert_eq!(v[1].orig_path.as_deref(), Some("old"));
    }
}
