//! Library maintenance CLI: migrate the legacy Astra image library into
//! HoardFS, and re-link sources that moved on disk.
//!
//! Operates directly on the desktop app's data directory, so the GUI app
//! should not be running while this executes (SQLite / HoardFS locking).
//!
//! # Usage
//!
//!   # Migration (default): register unmigrated images as HoardFS external refs
//!   cargo run --release --bin migrate_library
//!
//!   # Re-link: fix images whose source files moved, then migrate
//!   cargo run --release --bin migrate_library -- --remap /mnt/asiair=/mnt/mouseion/astronomy/ASIAir
//!   cargo run --release --bin migrate_library -- --relink-search /mnt/mouseion/astronomy --dry-run
//!
//! Relink mode runs when any of --remap / --relink-search / --relink /
//! --dry-run is given. Candidates are always verified before rewriting:
//! prefix-remapped paths must exist (and match recorded size), auto-search
//! matches are disambiguated by recorded size and blake3 content hash —
//! same-named stacks for different targets are never confused. Ambiguous or
//! unfound sources are reported, not guessed. After a non-dry relink, the
//! normal migration pass runs so newly-reachable images get blob_id+variants.

use std::io::Write;

fn print_help() {
    println!(
        "migrate_library — Astra library maintenance (HoardFS migration + source re-linking)\n\n\
         USAGE:\n\
         \x20 migrate_library [--data-dir <path>]                          # migration\n\
         \x20 migrate_library [--data-dir <path>] [RELINK OPTIONS]         # re-link, then migrate\n\n\
         OPTIONS:\n\
         \x20 --data-dir <path>       Override the app data dir (default: app_data_dir for com.erewhon.astra)\n\
         \x20 --remap OLD=NEW         Prefix remap for moved mounts (repeatable)\n\
         \x20 --relink-search <root>  Auto-search root for moved files (repeatable;\n\
         \x20                         default: the persisted scan roots from Settings)\n\
         \x20 --relink                Force relink mode without remaps (search-only)\n\
         \x20 --dry-run               Report proposed relinks without writing anything\n\
         \x20 -h, --help              Show this help\n\n\
         Both passes are idempotent; re-run to pick up previously-unreachable sources."
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

fn progress_line(current: u32, total: u32, filename: &str) {
    if current == 1 || current == total || current % 25 == 0 {
        print!("\r  [{current:>5}/{total}] {:<62}", truncate(filename, 62));
        let _ = std::io::stdout().flush();
    }
}

fn run_migration(data_dir: Option<std::path::PathBuf>) {
    println!("Migrating Astra library → HoardFS (originals stay in place)…\n");

    let started = std::time::Instant::now();
    let result = astra_lib::run_standalone_migration(data_dir, progress_line);
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
                    "\n  {} source(s) were unreachable — bring those mounts online and re-run, \
                     or use --remap/--relink-search if they moved.",
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

fn run_relink(data_dir: Option<std::path::PathBuf>, options: astra_lib::relink::RelinkOptions) {
    let dry_run = options.dry_run;
    println!(
        "Re-linking relocated sources{}…\n",
        if dry_run { " (dry run — nothing will be written)" } else { "" }
    );

    let started = std::time::Instant::now();
    let result = astra_lib::run_standalone_relink(data_dir.clone(), options, progress_line);
    println!();

    let report = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("\nRelink failed: {e}");
            std::process::exit(1);
        }
    };

    println!("\nDone in {:.1}s", started.elapsed().as_secs_f64());
    println!("  images checked:      {}", report.images_checked);
    println!("  unreachable images:  {}", report.unreachable_images);
    println!("  proposed relinks:    {}", report.proposed.len());
    println!("  ambiguous:           {}", report.ambiguous.len());
    println!("  lost:                {}", report.lost.len());
    if !dry_run {
        println!("  applied:             {}", report.applied);
        println!("  hoardfs refs moved:  {}", report.hoardfs_updated);
    }
    println!("  errors:              {}", report.errors.len());

    if !report.proposed.is_empty() {
        println!(
            "\n  {} relinks:",
            if dry_run { "proposed" } else { "applied" }
        );
        for p in &report.proposed {
            println!("    {} [{}]", p.filename, p.field);
            println!("      {} →", p.old_path);
            println!("      {}   ({}, {})", p.new_path, p.method, p.verification);
        }
    }
    if !report.ambiguous.is_empty() {
        println!("\n  ambiguous — multiple verified candidates, left for manual action:");
        for a in &report.ambiguous {
            println!("    {} [{}] was {}", a.filename, a.field, a.old_path);
            for c in &a.candidates {
                println!("      candidate: {c}");
            }
        }
    }
    if !report.lost.is_empty() {
        println!("\n  lost — no verified candidate found:");
        for l in &report.lost {
            println!("    {} [{}] was {}", l.filename, l.field, l.old_path);
        }
    }
    if !report.errors.is_empty() {
        println!("\n  errors:");
        for e in &report.errors {
            println!("    - {e}");
        }
    }

    if dry_run {
        println!("\nDry run — re-run without --dry-run to apply.");
    } else if report.applied > 0 {
        // Newly-reachable images may still lack blob_id/variants — the
        // migration pass picks them up in the same invocation.
        println!();
        run_migration(data_dir);
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let args: Vec<String> = std::env::args().collect();
    let mut data_dir: Option<std::path::PathBuf> = None;
    let mut options = astra_lib::relink::RelinkOptions::default();
    let mut relink_mode = false;

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
            "--remap" => {
                i += 1;
                let Some(spec) = args.get(i) else {
                    eprintln!("--remap requires OLD=NEW");
                    std::process::exit(2);
                };
                match astra_lib::relink::RemapRule::parse(spec) {
                    Ok(rule) => options.remaps.push(rule),
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(2);
                    }
                }
                relink_mode = true;
            }
            "--relink-search" => {
                i += 1;
                match args.get(i) {
                    Some(p) => options.search_roots.push(std::path::PathBuf::from(p)),
                    None => {
                        eprintln!("--relink-search requires a path");
                        std::process::exit(2);
                    }
                }
                relink_mode = true;
            }
            "--relink" => relink_mode = true,
            "--dry-run" => {
                options.dry_run = true;
                relink_mode = true;
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

    if relink_mode {
        run_relink(data_dir, options);
    } else {
        run_migration(data_dir);
    }
}
