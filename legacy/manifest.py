"""Manifest-related commands."""
import hashlib
import itertools
import re
import time
from pathlib import Path
from random import random

import humanize
import typer
from astropy.io import fits
from erewhon_astro import PlateSolve
from rich import print
from rich.progress import Progress, SpinnerColumn, TextColumn
from typing_extensions import Annotated

from alog.graph import display_rectangles_and_stars
from alog.graphplot import plot_graph
from alog.models import Manifest, ImageRectangle, FileDescription
from alog.settings import Settings
from alog.utils import is_hidden

app = typer.Typer(no_args_is_help=True)


def get_file_description(dir: Path, pathname: Path) -> FileDescription:
    msg = ''
    start = time.perf_counter()
    with open(pathname, 'rb') as f:
        # Calculate the SHA256 hash of the file
        sha256_hash = hashlib.sha256(f.read()).hexdigest()
    elapsed = time.perf_counter() - start
    msg += f' Hash elapsed: {elapsed:.2f}s. '
    start = time.perf_counter()
    with fits.open(pathname) as hdul:
        exposure_time = hdul[0].header.get('EXPTIME', 0)
        instrument = hdul[0].header.get('INSTRUME', '')
        stackcnt = hdul[0].header.get('STACKCNT', 0)
        ra = hdul[0].header.get('RA', 0)
        dec = hdul[0].header.get('DEC', 0)
        # gain = hdul[0].header.get('GAIN', 0)
        # target = hdul[0].header.get('OBJECT', '')
        total_exposure_time = hdul[0].header.get('TOTALEXP', 0)
        axis1 = hdul[0].header.get('NAXIS1', 0)
        axis2 = hdul[0].header.get('NAXIS2', 0)

        if total_exposure_time == 0:
            total_exposure_time = exposure_time * stackcnt

        # print(hdul[0].header)
    elapsed = time.perf_counter() - start
    msg += f'FITS header read: {elapsed:.2f}s. '

    start = time.perf_counter()
    settings = Settings()
    solver = PlateSolve()
    solution = solver.solve(pathname, local_solve=settings.local_solve, index_dir=settings.astrometry_index_dir)
    elapsed = time.perf_counter() - start
    msg += f'Plate solver: {elapsed:.2f}s. '
    print(msg)

    # We only store the relative pathname (for now)
    return FileDescription(pathname=str(pathname.relative_to(dir)),
                           hash=sha256_hash,
                           total_exposure_time=total_exposure_time,
                           dec=dec,
                           ra=ra,
                           instrument=instrument,
                           stackcnt=stackcnt,
                           exposure_time=exposure_time,
                           axis1=axis1,
                           axis2=axis2,
                           solution=solution)


def read_manifest(directory: str) -> Manifest | None:
    with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            transient=True,
            refresh_per_second=20
    ) as progress:
        progress.add_task(description="Reading manifest..", total=None)
        dir = Path(directory)
        manifest_file = dir / "manifest.json"
        if not manifest_file.exists():
            print("[bold red]Manifest not found.[/bold red]")
            return None

        manifest_content = manifest_file.read_text()
        progress.add_task(description="Parsing manifest..", total=None)
        response = Manifest.model_validate_json(manifest_content)

        print("Done!")

        return response



def _extract_common_name(name_list):
    """Extract the common name of an astronomical object from its identifiers."""
    # Dictionary of common name patterns with priority (lower number = higher priority)
    name_patterns = [
        # Direct named objects like "Orion Nebula", "Andromeda Galaxy", etc.
        (r'((?:[A-Z][a-z]+\s?)+(?:Nebula|Galaxy|Cluster|Cloud|Star|Pulsar|Quasar|Supernova|Remnant|Void|Group))', 1),

        # "NAME [Object Name]" pattern used in SIMBAD
        (r'NAME\s+(.*)', 2),

        # Popular asterisms and unofficial names
        (r'ASTERISM\s+(.*)', 3),

        # Common names like "Sirius", "Betelgeuse", "Polaris", etc.
        (r'((?:[A-Z][a-z]+){1,2})\s*$', 4),

        # Colloquial names like "Horsehead Nebula", etc.
        (r'((?:[A-Z][a-z]+\s?)+)', 5)
    ]

    # List to store potential common names with their priority
    potential_names = []

    for name in name_list:
        if name is None:
            continue

        name = name.strip()

        # Check against each pattern
        for pattern, priority in name_patterns:
            match = re.search(pattern, name)
            if match:
                common_name = match.group(1).strip()

                # Filter out catalog IDs that might match our patterns
                # Skip if the name is just a catalog designation
                if re.match(r'^(M|NGC|IC|HD|HIP|Sh2|B|C|HCG|UGC|Abell|PGC|ESO|LBN|SAO|HR|2MASS)\s*\d+', common_name,
                            re.IGNORECASE):
                    continue

                # Skip very short names (likely abbreviations, not common names)
                if len(common_name) < 3:
                    continue

                # Skip names that are just numbers
                if re.match(r'^\d+$', common_name):
                    continue

                potential_names.append((common_name, priority))

    # Sort by priority and return the best match
    potential_names.sort(key=lambda x: x[1])

    if potential_names:
        return potential_names[0][0]

    return None


def _extract_catalog_references(name_list):
    """Extract catalog references from a list of object names."""
    # Dictionary to store catalog information
    catalogs = {}

    # Regular expressions for common catalogs
    catalog_patterns = {
        'Messier': r'^M\s*(\d+)',  # Matches: M1, M 1, M31, etc.
        'NGC': r'^NGC\s*(\d+)',  # Matches: NGC1976, NGC 1976, etc.
        'IC': r'^IC\s*(\d+)',  # Matches: IC434, IC 434, etc.
        'HD': r'^HD\s*(\d+)',  # Matches: HD1234, HD 1234, etc.
        'HIP': r'^HIP\s*(\d+)',  # Matches: HIP1234, HIP 1234, etc.
        'Sh2': r'^Sh\s*2-(\d+)',  # Matches: Sh2-155, Sh 2-155, etc.
        'Barnard': r'^B\s*(\d+)',  # Matches: B33, B 33, etc. TODO: tighten this up!
        # 'Caldwell': r'^C\s*(\d+)', # Matches: C14, C 14, etc.
        'HCG': r'^HCG\s*(\d+)',  # Matches: HCG92, HCG 92, etc.
        'UGC': r'^UGC\s*(\d+)',  # Matches: UGC12158, UGC 12158, etc.
        'Abell': r'^Abell\s*(\d+)',  # Matches: Abell2151, Abell 2151, etc.
        'PGC': r'^PGC\s*(\d+)',  # Matches: PGC3589, PGC 3589, etc.
        'ESO': r'^ESO\s*(\d+)-(\d+)',  # Matches: ESO123-16, ESO 123-16, etc.
        'LBN': r'^LBN\s*(\d+)',  # Matches: LBN123, LBN 123, etc.
        'SAO': r'^SAO\s*(\d+)',  # Matches: SAO123456, SAO 123456, etc.
        'HR': r'^HR\s*(\d+)',  # Matches: HR1234, HR 1234, etc.
        '2MASS': r'^2MASS\s*J(\d+)'  # Matches: 2MASS J12345678+1234567
    }

    # Process each name
    for name in name_list:
        # Skip if None
        if name is None:
            continue

        name = name.strip()

        # Check against each catalog pattern
        for catalog, pattern in catalog_patterns.items():
            matches = re.search(pattern, name, re.IGNORECASE)
            if matches:
                if catalog not in catalogs:
                    catalogs[catalog] = []

                # Determine the catalog ID based on the regex match
                if catalog == 'ESO':  # Special case for ESO which has two capture groups
                    catalog_id = f"{matches.group(1)}-{matches.group(2)}"
                else:
                    catalog_id = matches.group(1)

                if catalog_id not in catalogs[catalog]:
                    catalogs[catalog].append(catalog_id)

    # Convert to expected JSON structure
    result = []
    for catalog, ids in catalogs.items():
        for id_value in ids:
            result.append({
                "catalog": catalog,
                "id": id_value,
                "designation": f"{catalog} {id_value}"
            })

    return result


def _display_object_info(obj):
    """Helper function to display object information in a formatted way."""
    # For debugging
    # pprint(obj)

    print(f"\nObject: {obj['name']}")

    # Display common name if available
    if "common_name" in obj:
        print(f"Common Name: {obj['common_name']}")

    print(f"Type: {obj['type']}")

    # Coordinates
    ra_deg = obj['coordinates']['ra']
    dec_deg = obj['coordinates']['dec']
    print(f"RA: {ra_deg:.6f}° ({obj['coordinates']['ra_str']})")
    print(f"DEC: {dec_deg:.6f}° ({obj['coordinates']['dec_str']})")

    # Size information
    if "size" in obj:
        size = obj["size"]
        if "dimensions" in size:
            print(f"Size: {size['dimensions']}")
        elif "formatted" in size:
            print(f"Size: {size['formatted']}")
        elif "type" in size:
            if size["type"] == "point_source":
                print("Size: Point source")
            else:
                print("Size: No size information available")

    # Catalog information
    if "catalogs" in obj and obj["catalogs"]:
        print("\nCatalog Designations:")
        catalogs_by_name = {}

        # Group by catalog name
        for cat_entry in obj["catalogs"]:
            catalog = cat_entry["catalog"]
            if catalog not in catalogs_by_name:
                catalogs_by_name[catalog] = []
            catalogs_by_name[catalog].append(cat_entry["id"])

        # Display in a nice format
        for catalog, ids in sorted(catalogs_by_name.items()):
            id_str = ", ".join(ids)
            print(f"  • {catalog}: {id_str}")

    # Distance
    if "distance" in obj:
        print(
            f"Distance: {obj['distance']['parsecs']:.2f} parsecs ({obj['distance']['light_years']:.2f} light years)")

    # Spectral type
    if "spectral_type" in obj:
        print(f"Spectral Type: {obj['spectral_type']}")

    # Visual magnitude
    if "visual_magnitude" in obj:
        print(f"Visual Magnitude: {obj['visual_magnitude']:.2f}")

    # Proper motion
    if "proper_motion" in obj:
        print(
            f"Proper Motion: RA {obj['proper_motion']['ra']:.2f} mas/yr, DEC {obj['proper_motion']['dec']:.2f} mas/yr")

    # Radial velocity
    if "radial_velocity" in obj:
        print(f"Radial Velocity: {obj['radial_velocity']:.2f} km/s")

    # Alternative names
    if "alternative_names" in obj and len(obj["alternative_names"]) > 1:
        print("\nAlternative designations:")
        # Show up to 5 alternative names
        for i, name in enumerate(obj["alternative_names"][:5]):
            print(f"  • {name}")
        if len(obj["alternative_names"]) > 5:
            print(f"  ... and {len(obj['alternative_names']) - 5} more identifiers")


@app.command()
def update(directory: Annotated[str, typer.Option(default=".", help="The directory to operate in.")]):
    """Create or update the manifest."""
    print(f"Updating the manifest in directory {directory}")
    dir = Path(directory)
    count = 0
    manifest_file = dir / "manifest.json"
    # todo : exclude hidden files, add "fits" extension
    if manifest_file.exists():
        manifest_content = manifest_file.read_text()
        manifest = Manifest.model_validate_json(manifest_content)
    else:
        manifest = Manifest(files=[])

    def save_manifest():
        manifest_file.write_text(manifest.model_dump_json(indent=2))

    files = list(dir.rglob("*.fit"))
    random.shuffle(files)
    for file in files:
        if is_hidden(file):
            continue

        if "/lights/" in str(file):
            # Skip lights frames for now!
            continue

        relative_path = file.relative_to(dir)

        if any([desc for desc in manifest.files if desc.pathname == str(relative_path)]):
            # print(f"Skipping '{relative_path}' - already in manifest.")
            continue

        print(f"Adding '{relative_path}' to manifest.")
        try:
            start = time.perf_counter()
            desc = get_file_description(dir, file)
            elapsed = time.perf_counter() - start
            print(f' Elapsed time: {elapsed:.2f}s plate solving {relative_path}')
        except Exception as e:
            print(f' Exception while processing {relative_path}: {e}')
            continue

        manifest.files.append(desc)
        count += 1

        # Save manifest every 20 files...
        if count % 10 == 0:
            start = time.perf_counter()
            save_manifest()
            elapsed = time.perf_counter() - start
            print(
                f"Processed {count} files.  Checkpointing manifest. {len(manifest.files)} files in total. ({elapsed:.2f}s)")

    print(f"Found {count} FITS files.")

    save_manifest()


@app.command()
def show(directory: Annotated[str, typer.Option(help="The directory to operate in.")] = "."):
    """Show the manifest."""
    # print("Reading the manifest.")
    manifest = read_manifest(directory)
    if not manifest:
        return

    total_exposure_time = sum([desc.total_exposure_time for desc in manifest.files])

    print(f"  Contains {humanize.intcomma(len(manifest.files))} files.")
    print(
        f"  Total exposure time: {humanize.precisedelta(total_exposure_time, minimum_unit='seconds')} ({total_exposure_time:.2f} seconds)")

    keyfunc = lambda desc: desc.instrument
    files = sorted(manifest.files, key=keyfunc)
    for instrument, group in itertools.groupby(files, keyfunc):
        group = list(group)
        total_exposure_time = sum([desc.total_exposure_time for desc in group])
        total_pixel_time = sum([desc.total_exposure_time * desc.axis1 * desc.axis2 for desc in group])
        mpel_hours = total_pixel_time / 3600 / 1_000_000
        print(f"  Instrument: [bold]{instrument}[/bold]")
        print(f"    Contains {humanize.intcomma(len(group))} files.")
        print(
            f"    Total exposure time: {humanize.precisedelta(total_exposure_time, minimum_unit='seconds')} ({total_exposure_time:.2f} seconds)")
        print(f"    Megapixel hours: {mpel_hours:.2f}")


@app.command()
def summary():
    """Show a summary of the manifest."""
    print("Showing a summary of the manifest.")


@app.command()
def validate():
    """Validate the manifest."""
    print("Validating the manifest.")


@app.command()
def graph(directory: Annotated[str, typer.Option(help="The directory to operate in.")] = "."):
    """Show a graph of the manifest."""
    manifest = read_manifest(directory)
    if not manifest:
        return

    print(f"Showing a graph of the manifest.  {len(manifest.files)} files in total.")
    rectangles = [
        ImageRectangle(x=file.solution.calibration.ra, y=file.solution.calibration.dec,
                       width=file.solution.calibration.width_arcsec / 3600.0,
                       height=file.solution.calibration.height_arcsec / 3600.0,
                       rotation=file.solution.calibration.orientation, total_exposure_time=file.total_exposure_time) for
        file in manifest.files]

    display_rectangles_and_stars(rectangles)

    # plt.show()

    # rectangles = [{
    #     "x": file.solution.calibration.ra,
    #     "y": file.solution.calibration.dec,
    #     "width": file.solution.calibration.width_arcsec / 3600.0,
    #     "height": file.solution.calibration.height_arcsec / 3600.0,
    #     "rotation": file.solution.calibration.orientation,
    #     "total_exposure_time": file.total_exposure_time,
    # } for file in manifest.files]
    #
    # display_rectangles(rectangles)
    # plt.show()

    # location = 'Houston, Texas'
    # when = '2025-04-04 21:00'
    # fig, ax = build_star_chart(location, when)


@app.command()
def graph2(directory: Annotated[str, typer.Option(help="The directory to operate in.")] = "."):
    """Show a graph of the manifest."""
    manifest = read_manifest(directory)
    if not manifest:
        return

    print(f"Showing a graph of the manifest.  {len(manifest.files)} files in total.")
    rectangles = [
        ImageRectangle(x=file.solution.calibration.ra,
                       y=file.solution.calibration.dec,
                       # centerx=file.solution.calibration.centerx,
                       width=file.solution.calibration.width_arcsec / 3600.0,
                       height=file.solution.calibration.height_arcsec / 3600.0,
                       rotation=file.solution.calibration.orientation, total_exposure_time=file.total_exposure_time) for
        file in manifest.files]

    plot_graph(rectangles)


if __name__ == "__main__":
    app()
