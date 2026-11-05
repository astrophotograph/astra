//! `astra-cli` — push stacked images into an Astra server from wherever
//! they land (a laptop next to the mount, an SMB share off an ASI Air, a
//! Seestar's MyWorks folder), one file at a time or by watching a folder.
//!
//! Authentication is a personal access token minted in the web app
//! (Settings → Account → Personal access tokens) or with
//! `astra_daemon --mint-token`. `astra-cli login` stores it (0600) under
//! the user's config dir; `ASTRA_SERVER` / `ASTRA_TOKEN` override it.
//!
//! Uploads are idempotent at both ends: a local ledger remembers which
//! (path, size, mtime) has gone where, and the server reuses an existing
//! image when it already holds the same bytes.

mod client;
mod config;
mod ledger;
mod select;
mod upload;
mod watch;

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "astra-cli", version, about, long_about = None)]
struct Cli {
    /// Server base URL (overrides the saved login).
    #[arg(long, global = true, env = "ASTRA_SERVER")]
    server: Option<String>,

    /// Personal access token (overrides the saved login).
    #[arg(long, global = true, env = "ASTRA_TOKEN", hide_env_values = true)]
    token: Option<String>,

    /// Config file (default: $XDG_CONFIG_HOME/astra-cli/config.toml).
    #[arg(long, global = true, env = "ASTRA_CLI_CONFIG")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Save a server + token after checking they work.
    Login {
        /// Server base URL, e.g. https://astra.gallery
        #[arg(long)]
        server: String,
        /// Token (prompted for when omitted; `-` reads stdin).
        #[arg(long, hide_env_values = true)]
        token: Option<String>,
    },
    /// Forget the saved login.
    Logout,
    /// Show who the saved (or given) credentials authenticate as.
    Whoami,
    /// List your collections.
    Collections,
    /// Upload files, or the stacked images found under directories.
    Upload {
        /// Files or directories.
        #[arg(required = true)]
        paths: Vec<PathBuf>,
        #[command(flatten)]
        opts: UploadOpts,
        /// Descend into subdirectories.
        #[arg(short, long)]
        recursive: bool,
    },
    /// Watch a directory and upload stacked images as they appear.
    Watch {
        /// Directory to watch (recursively).
        dir: PathBuf,
        #[command(flatten)]
        opts: UploadOpts,
        /// Seconds a file must stay unchanged before it is uploaded —
        /// stacking software writes in place for a while.
        #[arg(long, default_value_t = 15)]
        settle: u64,
        /// Skip the initial sweep of files already in the directory.
        #[arg(long)]
        no_initial: bool,
        /// Poll every N seconds instead of relying on filesystem events
        /// (needed on SMB/NFS mounts, where inotify never fires).
        #[arg(long, value_name = "SECS")]
        poll: Option<u64>,
    },
}

#[derive(Args, Clone, Debug, Default)]
pub struct UploadOpts {
    /// Collection to file images under, by name (created on first use).
    #[arg(short, long, conflicts_with = "collection_id")]
    collection: Option<String>,
    /// Collection by id.
    #[arg(long)]
    collection_id: Option<String>,
    /// Comma-separated tags.
    #[arg(short, long)]
    tags: Option<String>,
    /// Summary (title) for every uploaded image. Left blank, FITS
    /// uploads get the OBJECT header / source directory name.
    #[arg(long)]
    summary: Option<String>,
    /// Description for every uploaded image.
    #[arg(long)]
    description: Option<String>,
    /// Visibility: private (default), unlisted or public.
    #[arg(long)]
    visibility: Option<String>,
    /// In directories, accept every image file rather than only stacked
    /// frames (calibration frames and raw subframes are still skipped).
    #[arg(long)]
    all: bool,
    /// Show what would be uploaded without sending anything.
    #[arg(short = 'n', long)]
    dry_run: bool,
    /// Re-send files the local ledger says were already uploaded (the
    /// server still dedups identical bytes).
    #[arg(long)]
    force: bool,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let config_path = cli.config.clone().unwrap_or_else(config::default_path);

    match cli.command {
        Command::Login { server, token } => {
            let token = match token.as_deref() {
                Some("-") => read_line("")?,
                Some(t) => t.to_string(),
                None => read_line("Personal access token: ")?,
            };
            let token = token.trim().to_string();
            if token.is_empty() {
                bail!("a token is required");
            }
            let creds = config::Credentials::new(&server, &token);
            let me = client::Client::new(&creds).me().context("login check")?;
            config::save(&config_path, &creds)?;
            println!(
                "Signed in to {} as {} ({})",
                creds.server,
                me.handle(),
                config_path.display()
            );
            Ok(())
        }
        Command::Logout => {
            if config::remove(&config_path)? {
                println!("Removed {}", config_path.display());
            } else {
                println!("No saved login at {}", config_path.display());
            }
            Ok(())
        }
        Command::Whoami => {
            let creds = config::resolve(&config_path, cli.server, cli.token)?;
            let me = client::Client::new(&creds).me()?;
            println!("{} on {}", me.handle(), creds.server);
            println!("  user id: {}", me.user_id);
            println!("  role:    {}", me.role);
            println!("  status:  {}", me.status);
            Ok(())
        }
        Command::Collections => {
            let creds = config::resolve(&config_path, cli.server, cli.token)?;
            let mut collections = client::Client::new(&creds).collections()?;
            collections.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            if collections.is_empty() {
                println!("No collections yet — `astra-cli upload -c <name> …` creates one.");
            }
            for c in collections {
                println!("{:<40} {:<9} {}", c.name, c.visibility, c.id);
            }
            Ok(())
        }
        Command::Upload {
            paths,
            opts,
            recursive,
        } => {
            let creds = config::resolve(&config_path, cli.server, cli.token)?;
            let client = client::Client::new(&creds);
            let files = select::expand(&paths, recursive, opts.all)?;
            if files.is_empty() {
                bail!("nothing to upload (directories are filtered to stacked images; try --all)");
            }
            let mut ledger = ledger::Ledger::open(&creds.server)?;
            let outcome = upload::upload_all(&client, &mut ledger, &files, &opts);
            outcome.print_summary();
            if outcome.failed > 0 {
                bail!("{} upload(s) failed", outcome.failed);
            }
            Ok(())
        }
        Command::Watch {
            dir,
            opts,
            settle,
            no_initial,
            poll,
        } => {
            let creds = config::resolve(&config_path, cli.server, cli.token)?;
            let client = client::Client::new(&creds);
            let ledger = ledger::Ledger::open(&creds.server)?;
            watch::run(
                &client,
                ledger,
                &dir,
                &opts,
                watch::Settings {
                    settle_secs: settle,
                    initial_sweep: !no_initial,
                    poll_secs: poll,
                },
            )
        }
    }
}

fn read_line(prompt: &str) -> Result<String> {
    use std::io::{BufRead, Write};
    if !prompt.is_empty() {
        eprint!("{prompt}");
        std::io::stderr().flush().ok();
    }
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("reading token from stdin")?;
    Ok(line)
}
