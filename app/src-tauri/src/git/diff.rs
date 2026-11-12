//! Parse unified diff (giữ nguyên byte để dựng lại patch) + dựng patch theo dòng chọn.

use super::model::*;
use super::parse::unquote_path;
use crate::error::{AppError, Result};

/// Giới hạn hiển thị: diff lớn hơn mức này chỉ trả metadata.
pub const MAX_DISPLAY_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RawHunk {
    pub header: Vec<u8>,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// Mỗi phần tử là 1 dòng kể cả ký tự đầu (' ', '+', '-', '\\'), không có '\n'.
    pub lines: Vec<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct RawFile {
    pub header: Vec<Vec<u8>>,
    pub path: String,
    pub old_path: Option<String>,
    pub status: char,
    pub binary: bool,
    pub hunks: Vec<RawHunk>,
}

fn parse_hunk_header(h: &[u8]) -> Option<(u32, u32, u32, u32)> {
    let s = std::str::from_utf8(h).ok()?;
    let s = s.strip_prefix("@@ -")?;
    let end = s.find(" @@")?;
    let (old, new) = s[..end].split_once(" +")?;
    let pair = |p: &str| -> Option<(u32, u32)> {
        match p.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((p.parse().ok()?, 1)),
        }
    };
    let (a, b) = pair(old)?;
    let (c, d) = pair(new)?;
    Some((a, b, c, d))
}

fn path_after(line: &[u8], prefix: &str) -> Option<String> {
    let s = String::from_utf8_lossy(line);
    let rest = s.strip_prefix(prefix)?;
    // git thêm '\t' sau tên file chứa dấu cách ở dòng ---/+++
    let rest = rest.trim_end_matches(['\r', '\t']);
    let p = unquote_path(rest);
    if p == "/dev/null" {
        return None;
    }
    // "--- a/path" | "+++ b/path" ; với path có dấu ngoặc, unquote giữ prefix a/ b/
    let p = p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).map(String::from).unwrap_or(p);
    Some(p)
}

fn path_from_diff_git(line: &[u8]) -> Option<String> {
    // "diff --git a/P b/P" — chỉ tách được chắc chắn khi hai path giống nhau.
    let s = String::from_utf8_lossy(line);
    let rest = s.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        let end = rest[1..].find('"')? + 2;
        return Some(unquote_path(&rest[..end]).trim_start_matches("a/").to_string());
    }
    let len = rest.len();
    if len < 5 || (len - 5) % 2 != 0 {
        return None;
    }
    let plen = (len - 5) / 2;
    Some(rest.get(2..2 + plen)?.to_string())
}

pub fn parse_raw(raw: &[u8]) -> Vec<RawFile> {
    let mut files: Vec<RawFile> = Vec::new();
    let mut lines: Vec<&[u8]> = raw.split(|&b| b == b'\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut in_hunk = false;
    for line in lines {
        if line.starts_with(b"diff --git ") {
            files.push(RawFile {
                header: vec![line.to_vec()],
                path: path_from_diff_git(line).unwrap_or_default(),
                old_path: None,
                status: 'M',
                binary: false,
                hunks: Vec::new(),
            });
            in_hunk = false;
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if line.starts_with(b"@@ ") {
            if let Some((a, b, c, d)) = parse_hunk_header(line) {
                f.hunks.push(RawHunk {
                    header: line.to_vec(),
                    old_start: a,
                    old_count: b,
                    new_start: c,
                    new_count: d,
                    lines: Vec::new(),
                });
                in_hunk = true;
                continue;
            }
        }
        if in_hunk {
            if let Some(h) = f.hunks.last_mut() {
                if matches!(line.first(), Some(b' ' | b'+' | b'-' | b'\\')) || line.is_empty() {
                    // dòng trống (hiếm, do công cụ cắt khoảng trắng) coi như context rỗng
                    h.lines.push(if line.is_empty() { b" ".to_vec() } else { line.to_vec() });
                    continue;
                }
            }
        }
        f.header.push(line.to_vec());
        if line.starts_with(b"new file mode") {
            f.status = 'A';
        } else if line.starts_with(b"deleted file mode") {
            f.status = 'D';
        } else if let Some(p) = path_after(line, "rename from ") {
            f.status = 'R';
            f.old_path = Some(p);
        } else if let Some(p) = path_after(line, "rename to ") {
            f.path = p;
        } else if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
            f.binary = true;
        } else if line.starts_with(b"+++ ") {
            if let Some(p) = path_after(line, "+++ ") {
                f.path = p;
            }
        } else if line.starts_with(b"--- ") {
            if let Some(p) = path_after(line, "--- ") {
                if f.path.is_empty() {
                    f.path = p;
                }
            }
        }
    }
    files
}

impl RawFile {
    pub fn to_display(&self) -> FileDiff {
        let size: usize = self.hunks.iter().flat_map(|h| h.lines.iter()).map(|l| l.len() + 1).sum();
        let too_large = size > MAX_DISPLAY_BYTES;
        let hunks = if too_large {
            Vec::new()
        } else {
            self.hunks
                .iter()
                .map(|h| {
                    let mut o = h.old_start;
                    let mut n = h.new_start;
                    let lines = h
                        .lines
                        .iter()
                        .map(|l| {
                            let kind = l.first().copied().unwrap_or(b' ') as char;
                            let body = if l.is_empty() { &l[..] } else { &l[1..] };
                            let body = body.strip_suffix(b"\r").unwrap_or(body);
                            let (old_no, new_no) = match kind {
                                ' ' => {
                                    o += 1;
                                    n += 1;
                                    (Some(o - 1), Some(n - 1))
                                }
                                '-' => {
                                    o += 1;
                                    (Some(o - 1), None)
                                }
                                '+' => {
                                    n += 1;
                                    (None, Some(n - 1))
                                }
                                _ => (None, None),
                            };
                            DiffLine { kind, text: String::from_utf8_lossy(body).into_owned(), old_no, new_no }
                        })
                        .collect();
                    Hunk {
                        header: String::from_utf8_lossy(&h.header).trim_end().to_string(),
                        old_start: h.old_start,
                        old_lines: h.old_count,
                        new_start: h.new_start,
                        new_lines: h.new_count,
                        lines,
                    }
                })
                .collect()
        };
        FileDiff {
            path: self.path.clone(),
            old_path: self.old_path.clone(),
            status: self.status,
            binary: self.binary,
            too_large,
            hunks,
        }
    }
}

/// Hướng áp patch.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PatchMode {
    /// Áp xuôi lên phía "old" (stage từ diff unstaged): dòng không chọn: '+' bỏ, '-' thành context.
    Forward,
    /// Áp ngược lên phía "new" (unstage từ diff staged, hoặc discard từ diff unstaged):
    /// dòng không chọn: '+' thành context, '-' bỏ.
    Reverse,
}

/// Dựng patch chỉ chứa các dòng được chọn. Trả None nếu không có thay đổi nào được chọn.
pub fn build_patch(file: &RawFile, selections: &[HunkSelection], mode: PatchMode) -> Result<Option<Vec<u8>>> {
    if file.binary {
        return Err(AppError::invalid("lines", "Lines cannot be selected in a binary file"));
    }
    if file.status == 'A' || file.status == 'D' {
        return Err(AppError::invalid("lines", "New or deleted files can only be staged as a whole"));
    }
    let mut sel_sorted: Vec<&HunkSelection> = selections.iter().collect();
    sel_sorted.sort_by_key(|s| s.hunk);

    let mut out: Vec<u8> = Vec::new();
    for h in &file.header {
        out.extend_from_slice(h);
        out.push(b'\n');
    }
    let mut cum_delta: i64 = 0;
    let mut any = false;

    for sel in sel_sorted {
        let hunk = file
            .hunks
            .get(sel.hunk)
            .ok_or_else(|| AppError::invalid("hunk", "The diff changed, reload it"))?;
        if String::from_utf8_lossy(&hunk.header).trim_end() != sel.header.trim_end() {
            return Err(AppError::invalid("hunk", "The diff changed, reload it"));
        }
        let chosen: std::collections::HashSet<usize> = sel.lines.iter().copied().collect();
        let mut body: Vec<Vec<u8>> = Vec::new();
        let mut prev_kept = false;
        let mut changes = 0;
        let (mut old_n, mut new_n) = (0u32, 0u32);
        for (i, line) in hunk.lines.iter().enumerate() {
            let k = line.first().copied().unwrap_or(b' ');
            let picked = chosen.contains(&i);
            let emit: Option<Vec<u8>> = match (k, picked, mode) {
                (b' ', _, _) => Some(line.clone()),
                (b'+', true, _) | (b'-', true, _) => {
                    changes += 1;
                    Some(line.clone())
                }
                (b'+', false, PatchMode::Forward) | (b'-', false, PatchMode::Reverse) => None,
                (b'+', false, PatchMode::Reverse) | (b'-', false, PatchMode::Forward) => {
                    let mut l = line.clone();
                    l[0] = b' ';
                    Some(l)
                }
                (b'\\', _, _) => {
                    if prev_kept {
                        body.push(line.clone());
                    }
                    continue;
                }
                _ => Some(line.clone()),
            };
            prev_kept = emit.is_some();
            if let Some(l) = emit {
                match l[0] {
                    b' ' => {
                        old_n += 1;
                        new_n += 1;
                    }
                    b'-' => old_n += 1,
                    b'+' => new_n += 1,
                    _ => {}
                }
                body.push(l);
            }
        }
        if changes == 0 {
            continue;
        }
        any = true;
        let (old_start, new_start) = match mode {
            PatchMode::Forward => (hunk.old_start as i64, hunk.old_start as i64 + cum_delta),
            PatchMode::Reverse => (hunk.new_start as i64 - cum_delta, hunk.new_start as i64),
        };
        cum_delta += new_n as i64 - old_n as i64;
        out.extend_from_slice(
            format!("@@ -{},{} +{},{} @@\n", old_start.max(0), old_n, new_start.max(0), new_n).as_bytes(),
        );
        for l in body {
            out.extend_from_slice(&l);
            out.push(b'\n');
        }
    }
    Ok(any.then_some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n";

    #[test]
    fn parses() {
        let f = parse_raw(SAMPLE.as_bytes());
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].path, "f.txt");
        assert_eq!(f[0].hunks[0].lines.len(), 6);
        let d = f[0].to_display();
        assert_eq!(d.hunks[0].lines[2].new_no, Some(2));
    }

    #[test]
    fn forward_partial() {
        let f = &parse_raw(SAMPLE.as_bytes())[0];
        let sel = HunkSelection { hunk: 0, header: "@@ -1,4 +1,4 @@".into(), lines: vec![1, 2] };
        let p = String::from_utf8(build_patch(f, &[sel], PatchMode::Forward).unwrap().unwrap()).unwrap();
        assert!(p.ends_with("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n"), "{p}");
    }

    #[test]
    fn reverse_partial() {
        let f = &parse_raw(SAMPLE.as_bytes())[0];
        let sel = HunkSelection { hunk: 0, header: "@@ -1,4 +1,4 @@".into(), lines: vec![4, 5] };
        let p = String::from_utf8(build_patch(f, &[sel], PatchMode::Reverse).unwrap().unwrap()).unwrap();
        assert!(p.ends_with("@@ -1,4 +1,4 @@\n a\n B\n c\n-d\n+D\n"), "{p}");
    }

    #[test]
    fn stale_header_rejected() {
        let f = &parse_raw(SAMPLE.as_bytes())[0];
        let sel = HunkSelection { hunk: 0, header: "@@ -9,4 +9,4 @@".into(), lines: vec![1] };
        assert!(build_patch(f, &[sel], PatchMode::Forward).is_err());
    }
}
