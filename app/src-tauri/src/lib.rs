//! Git Cyclone — app quản lý Git local (Tauri 2).

pub mod commands;
pub mod gitenv;
pub mod commands_gitenv;
pub mod error;
pub mod git;
pub mod graph;
pub mod repo;
pub mod store;
pub mod tray;
pub mod watcher;
pub mod workspace;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = Arc::new(commands::AppState::new(data_dir));
            let s2 = state.clone();
            std::thread::spawn(move || s2.store.prune_trash(7));
            app.manage(state);
            // Không có khay (thiếu thư viện appindicator…) thì app vẫn chạy, chỉ mất tính năng khay.
            if let Err(e) = tray::setup(app.handle()) {
                eprintln!("tray unavailable: {e}");
            }
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::reveal_path,
            commands::repo_open,
            commands::repo_close,
            commands::session_set_active,
            commands::status_get,
            commands::graph_get,
            commands::commit_detail,
            commands::commit_file_diff,
            commands::worktree_diff,
            commands::refs_get,
            commands::file_history,
            commands::blame_get,
            commands::head_message,
            commands::conflict_get,
            commands::stage_files,
            commands::unstage_files,
            commands::stage_lines,
            commands::unstage_lines,
            commands::discard_lines,
            commands::discard_files,
            commands::commit_create,
            commands::commit_undo_last,
            commands::branch_checkout,
            commands::commit_checkout,
            commands::branch_create,
            commands::branch_rename,
            commands::branch_delete,
            commands::tag_create,
            commands::tag_delete,
            commands::stash_push,
            commands::stash_apply,
            commands::stash_drop,
            commands::remote_add,
            commands::merge_branch,
            commands::rebase_onto,
            commands::cherry_pick,
            commands::revert_commit,
            commands::sequencer,
            commands::reset_to,
            commands::conflict_resolve,
            commands::conflict_take,
            commands::op_cancel,
            commands::remote_fetch,
            commands::remote_pull,
            commands::remote_push,
            commands::tag_push,
            commands::branch_delete_remote,
            commands::settings_get,
            commands::settings_set,
            commands::workspace_get,
            commands::workspace_add_root,
            commands::workspace_rescan,
            commands::workspace_remove_root,
            commands::workspace_add_repo,
            commands::workspace_remove_repo,
            commands::workspace_set_repo,
            commands::workspace_summaries,
            commands::workspace_fetch_all,
            commands_gitenv::gitenv_status,
            commands_gitenv::identity_set_global,
            commands_gitenv::identity_profile_add,
            commands_gitenv::identity_profile_remove,
            commands_gitenv::gcm_login,
            commands_gitenv::gcm_logout,
            commands_gitenv::github_user,
            commands_gitenv::repo_auth,
            commands_gitenv::repo_set_github_account,
            commands_gitenv::repo_set_identity,
            commands_gitenv::repo_clear_identity,
            commands_gitenv::ssh_generate,
            commands_gitenv::ssh_public_key,
            commands_gitenv::ssh_test,
            tray::app_close_choice,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Git Cyclone");
}
