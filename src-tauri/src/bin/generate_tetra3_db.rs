//! Generate a tetra3 star pattern database for plate solving.
//!
//! This utility builds a `.rkyv` database file from a Gaia DR3 star catalog.
//! The database is used by Astra's built-in tetra3 plate solver.
//!
//! # Usage
//!
//! First, download the Gaia DR3 catalog (merged with Hipparcos):
//!   https://github.com/ssmichael1/tetra3rs/releases (look for gaia_merged.bin)
//!
//! Then generate the database:
//!
//!   cargo run --bin generate_tetra3_db -- --catalog gaia_merged.bin --output tetra3_db.rkyv
//!
//! Options:
//!   --catalog <path>     Path to Gaia catalog file (.bin or .csv)
//!   --output <path>      Output database file (default: tetra3_db.rkyv)
//!   --max-fov <degrees>  Maximum field of view in degrees (default: 12.0)
//!   --min-fov <degrees>  Minimum field of view in degrees (default: 0.5)
//!   --epoch <year>       Proper motion epoch year (default: 2026.0)
//!
//! # Presets
//!
//!   --preset seestar     Optimized for Seestar S50/S30 (FOV ~0.7-1.3°)
//!   --preset wide        Wide field (FOV 1-12°)
//!   --preset all         Full range (FOV 0.5-30°, larger database)

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = std::env::args().collect();

    let mut catalog_path: Option<String> = None;
    let mut output_path = "tetra3_db.rkyv".to_string();
    let mut max_fov: f32 = 12.0;
    let mut min_fov: f32 = 0.5;
    let mut epoch: f64 = 2026.0;
    let mut preset: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--catalog" | "-c" => {
                i += 1;
                catalog_path = Some(args[i].clone());
            }
            "--output" | "-o" => {
                i += 1;
                output_path = args[i].clone();
            }
            "--max-fov" => {
                i += 1;
                max_fov = args[i].parse().expect("Invalid max-fov value");
            }
            "--min-fov" => {
                i += 1;
                min_fov = args[i].parse().expect("Invalid min-fov value");
            }
            "--epoch" => {
                i += 1;
                epoch = args[i].parse().expect("Invalid epoch value");
            }
            "--preset" | "-p" => {
                i += 1;
                preset = Some(args[i].clone());
            }
            "--help" | "-h" => {
                print_usage();
                return;
            }
            _ => {
                // Positional: treat as catalog path if not set
                if catalog_path.is_none() {
                    catalog_path = Some(args[i].clone());
                } else {
                    eprintln!("Unknown argument: {}", args[i]);
                    print_usage();
                    std::process::exit(1);
                }
            }
        }
        i += 1;
    }

    // Apply presets
    if let Some(ref p) = preset {
        match p.as_str() {
            "seestar" => {
                min_fov = 0.5;
                max_fov = 2.0;
                log::info!("Using Seestar preset: FOV 0.5° - 2.0°");
            }
            "wide" => {
                min_fov = 1.0;
                max_fov = 12.0;
                log::info!("Using wide-field preset: FOV 1.0° - 12.0°");
            }
            "all" => {
                min_fov = 0.5;
                max_fov = 30.0;
                log::info!("Using full-range preset: FOV 0.5° - 30.0° (this will take a while)");
            }
            _ => {
                eprintln!("Unknown preset: {}. Use 'seestar', 'wide', or 'all'.", p);
                std::process::exit(1);
            }
        }
    }

    let catalog_path = match catalog_path {
        Some(p) => p,
        None => {
            eprintln!("Error: catalog path is required.\n");
            print_usage();
            std::process::exit(1);
        }
    };

    if !std::path::Path::new(&catalog_path).exists() {
        eprintln!("Error: catalog file not found: {}", catalog_path);
        eprintln!("\nDownload the Gaia DR3 catalog from:");
        eprintln!("  https://github.com/ssmichael1/tetra3rs/releases");
        std::process::exit(1);
    }

    log::info!("Generating tetra3 database:");
    log::info!("  Catalog:  {}", catalog_path);
    log::info!("  Output:   {}", output_path);
    log::info!("  FOV:      {}° - {}°", min_fov, max_fov);
    log::info!("  Epoch:    {}", epoch);

    let config = tetra3::GenerateDatabaseConfig {
        max_fov_deg: max_fov,
        min_fov_deg: Some(min_fov),
        epoch_proper_motion_year: Some(epoch),
        ..Default::default()
    };

    let start = std::time::Instant::now();

    let db = tetra3::SolverDatabase::generate_from_gaia(&catalog_path, &config)
        .expect("Failed to generate database");

    let gen_time = start.elapsed();
    log::info!("Database generated in {:.1}s", gen_time.as_secs_f64());

    let props = &db.props;
    log::info!("  Patterns:      {}", props.num_patterns);
    log::info!("  Stars:         {}", db.star_catalog.stars.len());
    log::info!(
        "  FOV range:     {:.2}° - {:.2}°",
        props.min_fov_rad.to_degrees(),
        props.max_fov_rad.to_degrees()
    );
    log::info!("  Max magnitude: {:.1}", props.star_max_magnitude);

    db.save_to_file(&output_path)
        .expect("Failed to save database");

    let file_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    log::info!(
        "Saved to {} ({:.1} MB)",
        output_path,
        file_size as f64 / 1_000_000.0
    );
}

fn print_usage() {
    eprintln!(
        "Usage: generate_tetra3_db [OPTIONS] --catalog <path>

Generate a tetra3 star pattern database for Astra's built-in plate solver.

OPTIONS:
  -c, --catalog <path>   Path to Gaia DR3 catalog (.bin or .csv) [required]
  -o, --output <path>    Output database file [default: tetra3_db.rkyv]
  --max-fov <degrees>    Maximum field of view [default: 12.0]
  --min-fov <degrees>    Minimum field of view [default: 0.5]
  --epoch <year>         Proper motion epoch [default: 2026.0]
  -p, --preset <name>    Use a preset configuration:
                           seestar  FOV 0.5-2° (Seestar smart scopes)
                           wide     FOV 1-12° (typical astrophotography)
                           all      FOV 0.5-30° (full range, large DB)
  -h, --help             Show this help

CATALOG DOWNLOAD:
  Download gaia_merged.bin from:
    https://github.com/ssmichael1/tetra3rs/releases"
    );
}
