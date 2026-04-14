//! One-shot: migrate the legacy Astra image library into HoardFS.
//!
//! Registers every not-yet-migrated image (`blob_id` NULL, with a `url`/`fits_url`)
//! as a HoardFS external reference, generating thumbnail/preview variants. The
//! originals are left untouched on disk. Idempotent — re-running only picks up
//! images that were previously unreachable (e.g. a NAS mount that was offline).
//!
//! Operates directly on the desktop app's data directory, so the GUI app should
//! not be running while this executes (SQLite / HoardFS locking).
//!
//! # Usage
//!
//!   cargo run --release --bin migrate_library
//!   cargo run --release --bin migrate_library -- --data-dir /path/to/data
//!
//! Options:
//!   --data-dir <path>   Override the app data dir (default: the Tauri
//!                       `app_data_dir` for com.erewhon.astra)
//!   -h, --help          Show this help

use std::io::Write;

fn print_help() {
    println!(
        "migrate_library — migrate the legacy Astra image library into HoardFS\n\n\
         USAGE:\n\
         \x20 migrate_library [--data-dir <path>]\n\n\
         OPTIONS:\n\
         \x20 --data-dir <path>   Override the app data dir (default: app_data_dir for com.erewhon.astra)\n\
         \x20 -h, --help          Show this help\n\n\
         The migration is idempotent; re-run it to pick up previously-unreachable sources."
    );
}

/// Truncate to `n` characters (not bytes) so non-ASCII paths don't panic.
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let args: Vec<String> = std::env::args().collect();
    let mut data_dir: Option<std::path::PathBuf> = None;

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

    println!("Migrating Astra library → HoardFS (originals stay in place)…\n");

    let started = std::time::Instant::now();
    let result = astra_lib::run_standalone_migration(data_dir, |current, total, filename| {
        // Throttle the progress line: first, last, and every 25th image.
        if current == 1 || current == total || current % 25 == 0 {
            print!("\r  [{current:>5}/{total}] {:<62}", truncate(filename, 62));
            let _ = std::io::stdout().flush();
        }
    });
    println!();

    match result {
        Ok(report) => {
            println!("\nDone in {:.1}s", started.elapsed().as_secs_f64());
            println!("  total to migrate: {}", report.total);
            println!("  migrated:         {}", report.migrated);
            println!("  unreachable:      {}", report.unreachable);
            println!("  skipped:          {}", report.skipped);
            println!("  errors:           {}", report.errors.len());
            if !report.errors.is_empty() {
                println!("\n  first errors:");
                for e in report.errors.iter().take(20) {
                    println!("    - {e}");
                }
                if report.errors.len() > 20 {
                    println!("    … and {} more", report.errors.len() - 20);
                }
            }
            if report.unreachable > 0 {
                println!(
                    "\n  {} source(s) were unreachable — bring those mounts online and re-run \
                     to migrate them.",
                    report.unreachable
                );
            }
        }
        Err(e) => {
            eprintln!("\nMigration failed: {e}");
            std::process::exit(1);
        }
    }
}
