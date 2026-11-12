//! Phân bổ lane cho commit graph.
//!
//! Duyệt commit theo `--date-order` (con trước cha). `lanes[i]` = commit mà lane i đang chờ.
//! Mỗi hàng sinh ra các cạnh nối từ hàng đó xuống hàng kế tiếp.

use crate::git::model::{Commit, Edge, Graph, GraphRow};
use std::collections::HashMap;

pub const PALETTE_SIZE: u32 = 10;

pub fn hash_color(s: &str) -> u8 {
    let mut h: u32 = 0;
    for b in s.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    (h % PALETTE_SIZE) as u8
}

/// Tên nhánh "chủ" của commit (để chọn màu ổn định).
fn branch_owner(c: &Commit) -> Option<String> {
    let local = c.refs.iter().find(|r| r.kind == "branch").map(|r| r.name.clone());
    local.or_else(|| {
        c.refs
            .iter()
            .find(|r| r.kind == "remote")
            .map(|r| r.name.split_once('/').map(|(_, b)| b.to_string()).unwrap_or(r.name.clone()))
    })
}

/// Tên nhánh được merge vào, đoán từ subject ("Merge branch 'x'", "Merge pull request #1 from u/x").
fn merged_branch_name(subject: &str) -> Option<String> {
    if let Some(rest) = subject.strip_prefix("Merge branch '") {
        return rest.split('\'').next().map(String::from);
    }
    if let Some(rest) = subject.strip_prefix("Merge remote-tracking branch '") {
        let n = rest.split('\'').next()?;
        return Some(n.split_once('/').map(|(_, b)| b).unwrap_or(n).to_string());
    }
    if subject.starts_with("Merge pull request ") {
        let from = subject.split(" from ").nth(1)?;
        let n = from.split_whitespace().next()?;
        return Some(n.split_once('/').map(|(_, b)| b).unwrap_or(n).to_string());
    }
    None
}

#[derive(Clone)]
struct Lane {
    target: u32,
    color: u8,
    /// Cột bắt đầu của cạnh đi xuống từ hàng hiện tại (khác `i` nếu lane vừa được tạo từ node).
    start: u16,
}

pub fn layout(commits: Vec<Commit>, has_more: bool) -> Graph {
    let n = commits.len();
    // id cho mọi sha (kể cả parent nằm ngoài trang đã tải)
    let mut ids: HashMap<&str, u32> = HashMap::with_capacity(n * 2);
    for (i, c) in commits.iter().enumerate() {
        ids.insert(c.sha.as_str(), i as u32);
    }
    let mut next_id = n as u32;
    let parent_ids: Vec<Vec<u32>> = commits
        .iter()
        .map(|c| {
            c.parents
                .iter()
                .map(|p| {
                    *ids.entry(p.as_str()).or_insert_with(|| {
                        next_id += 1;
                        next_id - 1
                    })
                })
                .collect()
        })
        .collect();

    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut node_lane: Vec<u16> = Vec::with_capacity(n);
    let mut node_color: Vec<u8> = Vec::with_capacity(n);
    // trạng thái lane sau mỗi hàng + cạnh phụ (node → lane đã tồn tại)
    let mut after: Vec<Vec<Option<Lane>>> = Vec::with_capacity(n);
    let mut extras: Vec<Vec<(u16, usize, u8)>> = Vec::with_capacity(n);
    let mut max_lanes: u16 = 1;
    let mut fallback_color: u8 = 0;

    for (r, c) in commits.iter().enumerate() {
        let me = r as u32;
        let hits: Vec<usize> =
            lanes.iter().enumerate().filter(|(_, l)| l.as_ref().is_some_and(|l| l.target == me)).map(|(i, _)| i).collect();

        let lane_idx = match hits.first() {
            Some(&i) => i,
            None => free_lane(&mut lanes, 0),
        };
        let color = if let Some(&i) = hits.first() {
            lanes[i].as_ref().map(|l| l.color).unwrap_or(0)
        } else if let Some(owner) = branch_owner(c) {
            hash_color(&owner)
        } else {
            fallback_color = (fallback_color + 1) % PALETTE_SIZE as u8;
            fallback_color
        };
        for &i in &hits {
            lanes[i] = None;
        }
        // các lane khác bắt đầu cạnh từ chính cột của chúng
        for (i, l) in lanes.iter_mut().enumerate() {
            if let Some(l) = l {
                l.start = i as u16;
            }
        }

        let mut extra = Vec::new();
        let parents = &parent_ids[r];
        if let Some(&p0) = parents.first() {
            // Nếu parent đầu đã có lane chờ sẵn (nhánh khác cũng trỏ tới), nối vào lane đó
            // nhưng vẫn giữ lane của mình để đường thẳng liền mạch.
            lanes[lane_idx] = Some(Lane { target: p0, color, start: lane_idx as u16 });
        }
        for (k, &p) in parents.iter().enumerate().skip(1) {
            if let Some(j) = lanes.iter().position(|l| l.as_ref().is_some_and(|l| l.target == p)) {
                let col = lanes[j].as_ref().map(|l| l.color).unwrap_or(color);
                extra.push((lane_idx as u16, j, col));
            } else {
                let j = free_lane(&mut lanes, lane_idx + 1);
                let col = merged_branch_name(&c.subject)
                    .filter(|_| k == 1)
                    .map(|n| hash_color(&n))
                    .unwrap_or_else(|| ((color as u32 + k as u32 * 3) % PALETTE_SIZE) as u8);
                lanes[j] = Some(Lane { target: p, color: col, start: lane_idx as u16 });
            }
        }
        while lanes.last().is_some_and(|l| l.is_none()) {
            lanes.pop();
        }
        max_lanes = max_lanes.max(lanes.len() as u16).max(lane_idx as u16 + 1);
        node_lane.push(lane_idx as u16);
        node_color.push(color);
        after.push(lanes.clone());
        extras.push(extra);
    }

    let mut rows = Vec::with_capacity(n);
    for (r, c) in commits.into_iter().enumerate() {
        let next = if r + 1 < n { Some((r as u32 + 1, node_lane[r + 1])) } else { None };
        let end_col = |target: u32, i: u16| -> u16 {
            match next {
                Some((id, lane)) if id == target => lane,
                _ => i,
            }
        };
        let mut edges = Vec::new();
        for (i, l) in after[r].iter().enumerate() {
            if let Some(l) = l {
                edges.push(Edge { from: l.start, to: end_col(l.target, i as u16), color: l.color });
            }
        }
        for &(from, j, color) in &extras[r] {
            if let Some(Some(l)) = after[r].get(j) {
                edges.push(Edge { from, to: end_col(l.target, j as u16), color });
            }
        }
        rows.push(GraphRow { commit: c, lane: node_lane[r], color: node_color[r], edges });
    }
    Graph { rows, max_lanes, has_more }
}

fn free_lane(lanes: &mut Vec<Option<Lane>>, preferred: usize) -> usize {
    if let Some(i) = (preferred..lanes.len()).find(|&i| lanes[i].is_none()) {
        return i;
    }
    lanes.push(None);
    lanes.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> Commit {
        Commit {
            sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            author_name: String::new(),
            author_email: String::new(),
            time: 0,
            subject: String::new(),
            refs: vec![],
        }
    }

    #[test]
    fn linear() {
        let g = layout(vec![c("c", &["b"]), c("b", &["a"]), c("a", &[])], false);
        assert!(g.rows.iter().all(|r| r.lane == 0));
        assert_eq!(g.rows[0].edges, vec![Edge { from: 0, to: 0, color: g.rows[0].color }]);
        assert!(g.rows[2].edges.is_empty());
    }

    #[test]
    fn merge_and_fork() {
        // m = merge(b, x); x -> a ; b -> a
        let g = layout(vec![c("m", &["b", "x"]), c("x", &["a"]), c("b", &["a"]), c("a", &[])], false);
        assert_eq!(g.rows[0].lane, 0);
        assert_eq!(g.rows[1].lane, 1); // x ở lane 1
        assert_eq!(g.rows[2].lane, 0); // b ở lane 0
        assert_eq!(g.rows[3].lane, 0); // a hội tụ về lane 0
        // từ m: một cạnh thẳng 0→0 (chờ b) và một cạnh 0→1 (tới x)
        let e: Vec<_> = g.rows[0].edges.iter().map(|e| (e.from, e.to)).collect();
        assert!(e.contains(&(0, 0)) && e.contains(&(0, 1)));
        // từ b: lane 1 (x→a) và lane 0 (b→a) đều hội tụ vào a ở lane 0
        let e: Vec<_> = g.rows[2].edges.iter().map(|e| (e.from, e.to)).collect();
        assert!(e.contains(&(0, 0)) && e.contains(&(1, 0)), "{e:?}");
        assert_eq!(g.max_lanes, 2);
    }

    #[test]
    fn two_tips() {
        let g = layout(vec![c("t1", &["a"]), c("t2", &["a"]), c("a", &[])], false);
        assert_eq!(g.rows[0].lane, 0);
        assert_eq!(g.rows[1].lane, 1);
        assert_eq!(g.rows[2].lane, 0);
    }
}
