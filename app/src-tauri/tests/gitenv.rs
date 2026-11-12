//! Test môi trường git. Trỏ global config và thư mục home vào thư mục tạm
//! để KHÔNG đụng tới cấu hình git thật của máy.

use git_cyclone_lib::git::runner::Git;
use git_cyclone_lib::gitenv;

fn sh(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn identity_profiles_and_repo_account() {
    let home = tempfile::tempdir().unwrap();
    let global = home.path().join(".gitconfig");
    std::fs::write(&global, "").unwrap();
    // Một test duy nhất trong binary này → đặt biến môi trường an toàn.
    unsafe {
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOME", home.path());
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    }

    // danh tính toàn máy
    assert!(gitenv::set_global_identity("", "a@b.c").is_err());
    gitenv::set_global_identity("Tester", "tester@example.com").unwrap();
    let id = gitenv::global_identity();
    assert_eq!(id.name.as_deref(), Some("Tester"));
    assert_eq!(id.email.as_deref(), Some("tester@example.com"));

    // hồ sơ theo thư mục: repo trong D:\…\Work dùng email công ty
    let work = home.path().join("Work Projects");
    let repo = work.join("app");
    std::fs::create_dir_all(&repo).unwrap();
    sh(&repo, &["init", "-q"]);
    let p = gitenv::add_profile(&work.display().to_string(), "Tester Work", "tester@company.example").unwrap();
    assert!(p.condition.starts_with("gitdir/i:") && p.condition.ends_with('/'));
    assert!(std::path::Path::new(&p.path).exists(), "file hồ sơ phải được tạo trong home tạm");
    assert_eq!(gitenv::profiles().len(), 1);
    assert_eq!(sh(&repo, &["config", "user.email"]), "tester@company.example", "includeIf phải áp dụng cho repo trong thư mục");

    // repo ngoài thư mục vẫn dùng danh tính global
    let other = home.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    sh(&other, &["init", "-q"]);
    assert_eq!(sh(&other, &["config", "user.email"]), "tester@example.com");

    // gỡ hồ sơ: file do app tạo bị xoá, repo quay về global
    gitenv::remove_profile(&p.condition).unwrap();
    assert!(gitenv::profiles().is_empty());
    assert!(!std::path::Path::new(&p.path).exists());
    assert_eq!(sh(&repo, &["config", "user.email"]), "tester@example.com");

    // tài khoản GitHub riêng cho repo
    let g = Git::new(&repo);
    assert_eq!(gitenv::repo_github_account(&g), None);
    assert!(gitenv::set_repo_github_account(&g, Some("--evil")).is_err());
    gitenv::set_repo_github_account(&g, Some("octocat")).unwrap();
    assert_eq!(gitenv::repo_github_account(&g).as_deref(), Some("octocat"));
    assert_eq!(sh(&repo, &["config", "--local", gitenv::REPO_USER_KEY]), "octocat");
    gitenv::set_repo_github_account(&g, None).unwrap();
    assert_eq!(gitenv::repo_github_account(&g), None);

    // global config thật không bị đụng tới: mọi ghi đều nằm trong file tạm
    let content = std::fs::read_to_string(&global).unwrap();
    assert!(content.contains("tester@example.com"));
}
