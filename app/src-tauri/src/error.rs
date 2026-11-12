use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, AppError>;

/// Lỗi trả về frontend. Được serialize thành `{ kind, message, stderr?, args? }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not a git repository: {0}")]
    NotARepo(String),
    #[error("git was not found in PATH. Install Git for Windows.")]
    GitNotFound,
    #[error("git command failed")]
    GitFailed { code: Option<i32>, stderr: String, args: Vec<String> },
    #[error("The remote requires authentication. Sign in to GitHub or check your SSH key.")]
    AuthRequired { stderr: String, args: Vec<String> },
    #[error("The remote has newer commits (non-fast-forward). Pull first, then push again.")]
    NonFastForward { stderr: String, args: Vec<String> },
    #[error("There are conflicts. Resolve the conflicted files, then continue.")]
    MergeConflict { stderr: String, args: Vec<String> },
    #[error("Uncommitted changes would be overwritten. Commit or stash them first.")]
    DirtyWorktree { stderr: String, args: Vec<String> },
    #[error("The repository is locked (index.lock). Another git process may be running.")]
    LockHeld { stderr: String, args: Vec<String> },
    #[error("Operation cancelled")]
    Cancelled,
    #[error("git command timed out")]
    Timeout,
    #[error("Invalid {field}: {reason}")]
    InvalidInput { field: String, reason: String },
    #[error("Repository is not open: {0}")]
    RepoNotOpen(String),
    #[error("{0}")]
    Io(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotARepo(_) => "notARepo",
            AppError::GitNotFound => "gitNotFound",
            AppError::GitFailed { .. } => "gitFailed",
            AppError::AuthRequired { .. } => "authRequired",
            AppError::NonFastForward { .. } => "nonFastForward",
            AppError::MergeConflict { .. } => "mergeConflict",
            AppError::DirtyWorktree { .. } => "dirtyWorktree",
            AppError::LockHeld { .. } => "lockHeld",
            AppError::Cancelled => "cancelled",
            AppError::Timeout => "timeout",
            AppError::InvalidInput { .. } => "invalidInput",
            AppError::RepoNotOpen(_) => "repoNotOpen",
            AppError::Io(_) => "io",
        }
    }

    fn details(&self) -> (Option<&str>, Option<&[String]>) {
        match self {
            AppError::GitFailed { stderr, args, .. }
            | AppError::AuthRequired { stderr, args }
            | AppError::NonFastForward { stderr, args }
            | AppError::MergeConflict { stderr, args }
            | AppError::DirtyWorktree { stderr, args }
            | AppError::LockHeld { stderr, args } => (Some(stderr), Some(args)),
            _ => (None, None),
        }
    }

    pub fn invalid(field: &str, reason: impl Into<String>) -> Self {
        AppError::InvalidInput { field: field.into(), reason: reason.into() }
    }

    /// Phân loại lỗi git dựa trên stderr (git chạy với LC_ALL=C nên thông điệp ổn định).
    pub fn classify(code: Option<i32>, stderr: String, args: Vec<String>) -> Self {
        let s = stderr.as_str();
        let has = |p: &str| s.contains(p);
        if has("not a git repository") {
            return AppError::NotARepo(stderr.trim().to_string());
        }
        if has("Authentication failed")
            || has("could not read Username")
            || has("could not read Password")
            || has("terminal prompts disabled")
            || has("Permission denied (publickey")
            || has("Host key verification failed")
        {
            return AppError::AuthRequired { stderr, args };
        }
        if has("[rejected]") && (has("non-fast-forward") || has("fetch first"))
            || has("stale info")
            || has("Not possible to fast-forward")
            || has("Diverging branches can't be fast-forwarded")
        {
            return AppError::NonFastForward { stderr, args };
        }
        if has("CONFLICT") || has("Automatic merge failed") || has("could not apply") || has("after resolving the conflicts") {
            return AppError::MergeConflict { stderr, args };
        }
        if has("would be overwritten") || has("Please commit your changes or stash them") {
            return AppError::DirtyWorktree { stderr, args };
        }
        if has("index.lock") && has("File exists") {
            return AppError::LockHeld { stderr, args };
        }
        AppError::GitFailed { code, stderr, args }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let (stderr, args) = self.details();
        let mut st = serializer.serialize_struct("AppError", 4)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("stderr", &stderr)?;
        st.serialize_field("args", &args)?;
        st.end()
    }
}
