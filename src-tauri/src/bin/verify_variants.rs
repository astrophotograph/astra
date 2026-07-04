//! One-shot: verify HoardFS variants for every migrated image.
//!
//! Read-only pass over all images with a `blob_id`: confirms each has at least
//! a thumbnail variant in HoardFS. Catches images where the source went offline
//! mid-migration (variants silently not generated) and metadata rows missing
//! their `hfs_path`. Exits non-zero if any image fails verification, so it can
//! gate follow-up work (e.g. dropping the legacy thumbnail fallback).
//!
//! # Usage
//!
//!   cargo run --release --bin verify_variants
//!   cargo run --release --bin verify_variants -- --data-dir /path/to/data
//!
//! Options:
//!   --data-dir <path>   Override the app data dir (default: the Tauri
//!                       `app_data_dir` for com.erewhon.astra)
//!   -h, --help          Show this help

use std::io::Write;

fn print_help() {
    println!(
        "verify_variants — verify HoardFS thumbnail/preview variants for migrated images\n\n\
         USAGE:\n\
         \x20 verify_variants [--data-dir <path>]\n\n\
         OPTIONS:\n\
         \x20 --data-dir <path>   Override the app data dir (default: app_data_dir for com.erewhon.astra)\n\
         \x20 -h, --help          Show this help\n\n\
         Read-only. Exits 1 if any migrated image is missing its thumbnail variant."
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

    println!("Verifying HoardFS variants for migrated images…\n");

    let started = std::time::Instant::now();
    let result = astra_lib::run_standalone_verification(data_dir, |current, total, filename| {
        // Throttle the progress line: first, last, and every 100th image.
        if current == 1 || current == total || current % 100 == 0 {
            print!("\r  [{current:>5}/{total}] {:<62}", truncate(filename, 62));
            let _ = std::io::stdout().flush();
        }
    });
    println!();

    match result {
        Ok(report) => {
            println!("\nDone in {:.1}s", started.elapsed().as_secs_f64());
            println!("  images with blob_id: {}", report.total_with_blob_id);
            println!("  variants ok:         {}", report.variants_ok);
            println!("  variants missing:    {}", report.variants_missing.len());
            if !report.variants_missing.is_empty() {
                println!("\n  missing:");
                for m in report.variants_missing.iter().take(50) {
                    println!(
                        "    - {} ({}): {} [found: {}]",
                        m.filename,
                        m.image_id,
                        m.reason,
                        if m.found.is_empty() { "none".to_string() } else { m.found.join(", ") },
                    );
                }
                if report.variants_missing.len() > 50 {
                    println!("    … and {} more", report.variants_missing.len() - 50);
                }
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("\nVerification failed: {e}");
            std::process::exit(1);
        }
    }
}
