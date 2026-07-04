//! Long-running Astra daemon: axum HTTP service over the desktop backend
//! stack (SQLite + HoardFS). Foundation for the hosted astra.gallery service.
//!
//! # Usage
//!
//!   cargo run --release --bin astra_daemon
//!   cargo run --release --bin astra_daemon -- --data-dir /path/to/data --bind 0.0.0.0:27872
//!
//! Options:
//!   --data-dir <path>       App data dir (default: app_data_dir for
//!                           com.erewhon.astra; env: ASTRA_DATA_DIR)
//!   --bind <addr:port>      Bind address (default: 127.0.0.1:27872;
//!                           env: ASTRA_BIND)
//!   -h, --help              Show this help
//!
//! Shuts down gracefully on SIGINT (Ctrl-C) or SIGTERM, checkpointing the
//! SQLite WAL on the way out.

use astra_lib::daemon::{shutdown_signal, Daemon, DaemonConfig, DEFAULT_BIND};

fn print_help() {
    println!(
        "astra_daemon — Astra HTTP service over the desktop backend stack\n\n\
         USAGE:\n\
         \x20 astra_daemon [--data-dir <path>] [--bind <addr:port>]\n\n\
         OPTIONS:\n\
         \x20 --data-dir <path>    App data dir (default: app_data_dir for com.erewhon.astra; env: ASTRA_DATA_DIR)\n\
         \x20 --bind <addr:port>   Bind address (default: {DEFAULT_BIND}; env: ASTRA_BIND)\n\
         \x20 -h, --help           Show this help\n\n\
         Endpoints:\n\
         \x20 GET /healthz         Version plus DB and HoardFS status"
    );
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = std::env::args().collect();
    let mut data_dir: Option<std::path::PathBuf> = None;
    let mut bind: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--data-dir" => {
                i += 1;
                match args.get(i) {
                    Some(p) => data_dir = Some(std::path::PathBuf::from(p)),
                    None => {
                        eprintln!("--data-dir requires a path");
                        std::process::exit(2);
                    }
                }
            }
            "--bind" => {
                i += 1;
                match args.get(i) {
                    Some(b) => bind = Some(b.clone()),
                    None => {
                        eprintln!("--bind requires an address (e.g. 127.0.0.1:27872)");
                        std::process::exit(2);
                    }
                }
            }
            "-h" | "--help" => {
                print_help();
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                print_help();
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let config = match DaemonConfig::resolve(data_dir, bind) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("tokio runtime: {e}");
            std::process::exit(1);
        }
    };

    let result = rt.block_on(async {
        let daemon = Daemon::bind(&config).await?;
        println!(
            "astra_daemon {} listening on http://{}",
            env!("CARGO_PKG_VERSION"),
            daemon.local_addr()?
        );
        println!("  data dir: {}", config.data_dir.display());
        daemon.serve(shutdown_signal()).await
    });

    if let Err(e) = result {
        eprintln!("astra_daemon failed: {e}");
        std::process::exit(1);
    }
}
