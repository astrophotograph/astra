//! Outbound email: the one channel the daemon uses to reach a person who
//! has no credentials yet (magic-link sign-in, `daemon::magic_link`).
//!
//! [`Mailer`] is the seam. [`LogMailer`] is the default — it logs the
//! message and keeps a copy in memory — and is what every test and every
//! unconfigured daemon uses, so nothing here can send real mail by
//! accident. [`ResendMailer`] talks to Resend's HTTPS API
//! (`POST https://api.resend.com/emails`), the homelab's sanctioned sender;
//! it exists only when [`from_env`] finds an API key.
//!
//! Configuration (see `docs/hosting.md`):
//! - `ASTRA_RESEND_API_KEY` — the key itself, or
//! - `ASTRA_MAIL_RESEND_KEY_SOURCE` — where to read it, in the same
//!   `ho:<name>|file:<path>|env:<VAR>` form as `ASTRA_SIGNING_KEY_SOURCE`
//!   (`ho:resend/smtp-key` is the homelab's key).
//! - `ASTRA_MAIL_FROM` — the sender, default `Astra <noreply@byrnes.org>`.
//!   The address must stay on a domain whose SPF/DKIM authorizes Resend.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kenning::keystore::KeySource;

pub const RESEND_API_KEY_ENV: &str = "ASTRA_RESEND_API_KEY";
pub const RESEND_KEY_SOURCE_ENV: &str = "ASTRA_MAIL_RESEND_KEY_SOURCE";
pub const MAIL_FROM_ENV: &str = "ASTRA_MAIL_FROM";
pub const DEFAULT_FROM: &str = "Astra <noreply@byrnes.org>";
const RESEND_ENDPOINT: &str = "https://api.resend.com/emails";

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("mail transport: {0}")]
    Transport(String),
    #[error("mail provider rejected the message ({status}): {body}")]
    Rejected { status: u16, body: String },
}

#[async_trait]
pub trait Mailer: Send + Sync {
    /// Send one plain-text message. `to` is a bare address or
    /// `Name <addr>`; the sender is the mailer's.
    async fn send(&self, to: &str, subject: &str, text: &str) -> Result<(), MailError>;
}

/// A message [`LogMailer`] captured instead of sending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMail {
    pub to: String,
    pub subject: String,
    pub text: String,
}

/// Logs each message at `info` (recipient and subject only — the body
/// holds a credential) and keeps the full message in memory for tests.
#[derive(Debug, Default)]
pub struct LogMailer {
    sent: Mutex<Vec<SentMail>>,
}

impl LogMailer {
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Everything "sent" so far, oldest first.
    pub fn sent(&self) -> Vec<SentMail> {
        self.sent.lock().map(|v| v.clone()).unwrap_or_default()
    }
}

#[async_trait]
impl Mailer for LogMailer {
    async fn send(&self, to: &str, subject: &str, text: &str) -> Result<(), MailError> {
        log::info!("mail not configured — would send to {to}: {subject}");
        if let Ok(mut sent) = self.sent.lock() {
            sent.push(SentMail {
                to: to.to_string(),
                subject: subject.to_string(),
                text: text.to_string(),
            });
        }
        Ok(())
    }
}

/// Resend over HTTPS. The key is read once at startup and never logged.
pub struct ResendMailer {
    client: reqwest::Client,
    api_key: String,
    from: String,
    endpoint: String,
}

impl std::fmt::Debug for ResendMailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResendMailer")
            .field("from", &self.from)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl ResendMailer {
    pub fn new(api_key: impl Into<String>, from: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                // Cloudflare fronts api.resend.com and 403s unfamiliar
                // user agents; name ourselves like any other client.
                .user_agent(concat!("astra-daemon/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
            api_key: api_key.into(),
            from: from.into(),
            endpoint: RESEND_ENDPOINT.to_string(),
        }
    }

    /// Point at a different endpoint (tests against a local stub).
    #[cfg(test)]
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    pub fn from(&self) -> &str {
        &self.from
    }
}

#[async_trait]
impl Mailer for ResendMailer {
    async fn send(&self, to: &str, subject: &str, text: &str) -> Result<(), MailError> {
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "from": self.from,
                "to": [to],
                "subject": subject,
                "text": text,
            }))
            .send()
            .await
            .map_err(|e| MailError::Transport(e.to_string()))?;
        let status = response.status();
        if status.is_success() {
            log::info!("mail sent via Resend to {to}: {subject}");
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(MailError::Rejected {
            status: status.as_u16(),
            body: body.chars().take(500).collect(),
        })
    }
}

/// Read a secret named by a kenning-style source spec (`ho:<name>`,
/// `file:<path>`, `env:<VAR>`).
fn read_secret(spec: &str) -> Result<String, String> {
    let source = KeySource::parse(spec).map_err(|e| e.to_string())?;
    let value = match &source {
        KeySource::Env(var) => std::env::var(var).map_err(|e| format!("env {var}: {e}"))?,
        KeySource::File(path) => {
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?
        }
        KeySource::HoSecret(name) => {
            let bin = std::env::var_os("KENNING_HO_BIN").unwrap_or_else(|| "ho".into());
            let output = std::process::Command::new(&bin)
                .args(["secret", "get", name])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("spawn {}: {e}", bin.to_string_lossy()))?;
            if !output.status.success() {
                return Err(format!(
                    "`ho secret get {name}` exited with {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{source} holds an empty secret"));
    }
    Ok(value)
}

/// The mailer the environment asks for. `Ok(LogMailer)` when no key is
/// configured; `Err` when a key is configured but cannot be read — a
/// daemon told to send mail must not come up silently logging instead.
pub fn from_env() -> Result<Arc<dyn Mailer>, String> {
    let direct = std::env::var(RESEND_API_KEY_ENV)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let via_source = std::env::var(RESEND_KEY_SOURCE_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty());
    let api_key = match (direct, via_source) {
        (Some(key), _) => key,
        (None, Some(spec)) => {
            read_secret(&spec).map_err(|e| format!("{RESEND_KEY_SOURCE_ENV}={spec:?}: {e}"))?
        }
        (None, None) => {
            log::info!(
                "mail not configured ({RESEND_API_KEY_ENV} / {RESEND_KEY_SOURCE_ENV} unset) — \
                 magic-link emails are logged, not sent"
            );
            return Ok(Arc::new(LogMailer::default()));
        }
    };
    let from = std::env::var(MAIL_FROM_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FROM.to_string());
    log::info!("mail enabled via Resend, sender {from}");
    Ok(Arc::new(ResendMailer::new(api_key, from)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn log_mailer_captures_without_sending() {
        let mailer = LogMailer::default();
        mailer.send("a@example.org", "hi", "body").await.unwrap();
        assert_eq!(
            mailer.sent(),
            vec![SentMail {
                to: "a@example.org".into(),
                subject: "hi".into(),
                text: "body".into(),
            }]
        );
    }

    #[test]
    fn read_secret_from_file_and_env() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("key");
        std::fs::write(&path, "re_test\n").unwrap();
        assert_eq!(
            read_secret(&format!("file:{}", path.display())).unwrap(),
            "re_test"
        );
        assert!(read_secret("file:/nonexistent/astra-mail-key").is_err());
        assert!(read_secret("garbage").is_err());
        std::fs::write(&path, "  \n").unwrap();
        assert!(read_secret(&format!("file:{}", path.display()))
            .unwrap_err()
            .contains("empty"));
    }

    /// The Resend client speaks to a local stub, never the real API.
    #[tokio::test]
    async fn resend_mailer_posts_bearer_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut n = 0;
            loop {
                let read = sock.read(&mut buf[n..]).await.unwrap();
                n += read;
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                if read == 0 || text.contains("\"text\"") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"id\":\"x\"}",
            )
            .await
            .unwrap();
            request
        });
        let mailer = ResendMailer::new("re_secret", "Astra <noreply@byrnes.org>")
            .with_endpoint(format!("http://{addr}/emails"));
        mailer
            .send("kid@example.org", "Sign in", "link")
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /emails"), "{request}");
        assert!(
            request.contains("authorization: Bearer re_secret"),
            "{request}"
        );
        assert!(
            request.contains("\"from\":\"Astra <noreply@byrnes.org>\""),
            "{request}"
        );
        assert!(
            request.contains("\"to\":[\"kid@example.org\"]"),
            "{request}"
        );
    }

    #[test]
    fn from_env_without_config_is_the_log_mailer() {
        // Env vars are process-global: this only asserts the unset case,
        // which is also the state the whole suite runs in.
        if std::env::var_os(RESEND_API_KEY_ENV).is_none()
            && std::env::var_os(RESEND_KEY_SOURCE_ENV).is_none()
        {
            assert!(from_env().is_ok());
        }
    }
}
