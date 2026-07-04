//! Integration test: boot the daemon against a temp data dir (empty-DB init
//! path), assert /healthz reports healthy, and shut down cleanly.

use astra_lib::daemon::{Daemon, DaemonConfig};

#[tokio::test(flavor = "multi_thread")]
async fn daemon_boots_serves_healthz_and_shuts_down() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config = DaemonConfig {
        data_dir: tmp.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
    };

    // Fresh dir: exercises DB creation + migrations and HoardFS init.
    let daemon = Daemon::bind(&config).await.expect("daemon bind");
    let addr = daemon.local_addr().expect("local addr");

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(daemon.serve(async {
        let _ = shutdown_rx.await;
    }));

    let resp = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .expect("GET /healthz");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("healthz json");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["db"], "ok");
    assert_eq!(body["hoardfs"], "ok");
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));

    shutdown_tx.send(()).expect("send shutdown");
    tokio::time::timeout(std::time::Duration::from_secs(15), server)
        .await
        .expect("shutdown timed out")
        .expect("server task panicked")
        .expect("serve returned error");

    // Clean shutdown checkpoints the WAL: the sidecar is gone or truncated.
    let wal = tmp.path().join("astra.db-wal");
    if wal.exists() {
        assert_eq!(
            std::fs::metadata(&wal).expect("wal metadata").len(),
            0,
            "WAL sidecar not checkpointed on shutdown"
        );
    }
}
