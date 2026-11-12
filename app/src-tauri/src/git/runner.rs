//! Điểm duy nhất gọi binary `git`. Không bao giờ chạy qua shell.

use crate::error::{AppError, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type LineSink = Box<dyn FnMut(&str) + Send>;

#[derive(Default)]
pub struct RunOpts {
    pub stdin: Option<Vec<u8>>,
    /// Lệnh chỉ đọc: thêm `--no-optional-locks` để không giành index.lock.
    pub read_only: bool,
    /// Không coi exit code khác 0 là lỗi.
    pub allow_fail: bool,
    /// None = không giới hạn (dùng cho lệnh mạng; huỷ bằng `cancel`).
    pub timeout: Option<Duration>,
    pub cancel: Option<Arc<AtomicBool>>,
    /// Nhận từng dòng stderr (tách theo \r hoặc \n) — dùng cho `--progress`.
    pub on_stderr: Option<LineSink>,
}

impl RunOpts {
    pub fn read() -> Self {
        RunOpts { read_only: true, timeout: Some(Duration::from_secs(60)), ..Default::default() }
    }
    pub fn write() -> Self {
        RunOpts { timeout: Some(Duration::from_secs(300)), ..Default::default() }
    }
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: Option<i32>,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

#[derive(Clone, Debug)]
pub struct Git {
    pub cwd: PathBuf,
}

impl Git {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Git { cwd: cwd.into() }
    }


    pub fn base_command(cwd: &Path, read_only: bool) -> Command {
        let mut cmd = Command::new("git");
        cmd.current_dir(cwd);
        if read_only {
            cmd.arg("--no-optional-locks");
        }
        cmd.args([
            "-c", "core.quotepath=false",
            "-c", "color.ui=never",
            "-c", "core.pager=cat",
            "-c", "core.editor=true",
            "-c", "advice.detachedHead=false",
        ]);
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE");
        if read_only {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// Chạy lệnh đọc, trả stdout dạng bytes. Lỗi nếu exit code != 0.
    pub fn read(&self, args: &[&str]) -> Result<Vec<u8>> {
        Ok(self.run(args, RunOpts::read())?.stdout)
    }

    pub fn read_str(&self, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.read(args)?).into_owned())
    }

    pub fn write(&self, args: &[&str]) -> Result<Output> {
        self.run(args, RunOpts::write())
    }

    pub fn write_stdin(&self, args: &[&str], stdin: Vec<u8>) -> Result<Output> {
        self.run(args, RunOpts { stdin: Some(stdin), ..RunOpts::write() })
    }

    pub fn run(&self, args: &[&str], mut opts: RunOpts) -> Result<Output> {
        let mut cmd = Self::base_command(&self.cwd, opts.read_only);
        cmd.args(args)
            .stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { AppError::GitNotFound } else { AppError::from(e) }
        })?;

        let stdin_thread = match (opts.stdin.take(), child.stdin.take()) {
            (Some(data), Some(mut pipe)) => Some(std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            })),
            _ => None,
        };

        let mut out_pipe = child.stdout.take().expect("stdout piped");
        let out_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out_pipe.read_to_end(&mut buf);
            buf
        });

        let mut err_pipe = child.stderr.take().expect("stderr piped");
        let mut sink = opts.on_stderr.take();
        let err_thread = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut line = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = match err_pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                all.extend_from_slice(&chunk[..n]);
                if let Some(cb) = sink.as_mut() {
                    for &b in &chunk[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !line.is_empty() {
                                cb(&String::from_utf8_lossy(&line));
                                line.clear();
                            }
                        } else {
                            line.push(b);
                        }
                    }
                }
            }
            if let Some(cb) = sink.as_mut() {
                if !line.is_empty() {
                    cb(&String::from_utf8_lossy(&line));
                }
            }
            all
        });

        let started = Instant::now();
        let status = loop {
            if let Some(st) = child.try_wait()? {
                break st;
            }
            if opts.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Cancelled);
            }
            if opts.timeout.is_some_and(|t| started.elapsed() > t) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(5));
        };

        if let Some(t) = stdin_thread {
            let _ = t.join();
        }
        let stdout = out_thread.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).into_owned();
        let out = Output { stdout, stderr, code: status.code() };

        if !out.ok() && !opts.allow_fail {
            let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            // Một số lệnh (merge, rebase, commit) in lỗi ra stdout → gộp cả hai.
            let stdout_text = out.text();
            let mut msg = out.stderr.trim_end().to_string();
            if !stdout_text.trim().is_empty() {
                if !msg.is_empty() {
                    msg.push('\n');
                }
                msg.push_str(stdout_text.trim_end());
            }
            return Err(AppError::classify(out.code, msg, args));
        }
        Ok(out)
    }
}

/// `git --version`, dùng để kiểm tra git có sẵn khi khởi động.
pub fn git_version() -> Result<String> {
    let cwd = std::env::temp_dir();
    let out = Git::new(cwd).read_str(&["--version"])?;
    Ok(out.trim().to_string())
}
