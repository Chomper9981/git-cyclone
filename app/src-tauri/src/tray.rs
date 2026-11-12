//! Icon khay hệ thống + hành vi khi đóng cửa sổ (hỏi / thu xuống khay / thoát hẳn).

use crate::commands::AppState;
use crate::error::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const TRAY_ID: &str = "main";

/// Icon khay có thực sự hiện với người dùng không. Khi không, "thu xuống khay" đổi thành thu nhỏ
/// cửa sổ — ẩn cửa sổ mà không có icon khay thì không còn cách nào gọi lại.
static TRAY_OK: AtomicBool = AtomicBool::new(false);

pub fn available() -> bool {
    TRAY_OK.load(Ordering::Relaxed)
}

/// Linux: icon khay chỉ hiện khi có StatusNotifierWatcher trên D-Bus (KDE, XFCE, GNOME có
/// extension AppIndicator…). GNOME mặc định không có. Không hỏi được thì coi như không có.
#[cfg(target_os = "linux")]
fn desktop_shows_tray() -> bool {
    std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            "org.kde.StatusNotifierWatcher",
        ])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("true"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn desktop_shows_tray() -> bool {
    true
}

/// Cất cửa sổ chính: ẩn xuống khay, hoặc thu nhỏ khi không có khay.
fn stow(window: &tauri::Window) {
    if available() {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
}

fn labels(lang: &str) -> (&'static str, &'static str) {
    match lang {
        "vi" => ("Mở Git Cyclone", "Thoát"),
        _ => ("Open Git Cyclone", "Quit"),
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let (open, quit) = labels(lang);
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Arc<AppState>>();
    let lang = state.store.settings().language;
    let menu = build_menu(app, &lang)?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("Git Cyclone").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, ev| match ev.id().as_ref() {
        "open" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    TRAY_OK.store(desktop_shows_tray(), Ordering::Relaxed);
    Ok(())
}

/// Đổi ngôn ngữ menu khay khi người dùng đổi ngôn ngữ.
pub fn refresh_language(app: &AppHandle, lang: &str) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app, lang)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Gắn vào `on_window_event`: chặn đóng cửa sổ chính theo cài đặt.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let action = app.state::<Arc<AppState>>().store.settings().close_action;
        match action.as_str() {
            "quit" => app.exit(0),
            "tray" => {
                api.prevent_close();
                stow(window);
            }
            _ => {
                api.prevent_close();
                let _ = window.emit("app:close-requested", ());
            }
        }
    }
}

/// Người dùng chọn trong hộp thoại đóng cửa sổ. action: tray | quit
#[tauri::command]
pub async fn app_close_choice(app: AppHandle, action: String, remember: bool) -> Result<()> {
    let state = app.state::<Arc<AppState>>();
    if remember && (action == "tray" || action == "quit") {
        let mut s = state.store.settings();
        s.close_action = action.clone();
        state.store.save_settings(&s)?;
    }
    match action.as_str() {
        "quit" => app.exit(0),
        _ => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = if available() { w.hide() } else { w.minimize() };
            }
        }
    }
    Ok(())
}
