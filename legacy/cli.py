"""CLI commands."""

import typer
from astroquery.simbad import Simbad
from typing_extensions import Annotated

from manifest import _extract_catalog_references, _extract_common_name, _display_object_info

app = typer.Typer(no_args_is_help=True)


@app.command()
def lookup(object_name: str, 
           output_json: Annotated[bool, typer.Option(help="Output as JSON instead of formatted text")] = False, # alias of --json?
           cache: Annotated[bool, typer.Option(help="Cache lookup results in a local SQLite database")] = False):
    """Look up an astronomical object in Simbad database."""
    import json
    import sqlite3
    from datetime import datetime

    print(f"Looking up {object_name} in Simbad database...")

    # Initialize cache if requested
    if cache:
        conn = None
        try:
            conn = sqlite3.connect('alog_cache.db')
            cursor = conn.cursor()
            # Create cache table if it doesn't exist
            cursor.execute('''
                           CREATE TABLE IF NOT EXISTS object_cache
                           (
                               object_name
                               TEXT
                               PRIMARY
                               KEY,
                               data
                               TEXT,
                               timestamp
                               TEXT
                           )
                           ''')

            # Check if object is in cache
            cursor.execute("SELECT data FROM object_cache WHERE object_name = ?", (object_name,))
            cached_data = cursor.fetchone()

            if cached_data:
                print("Using cached data...")
                if output_json:
                    print(cached_data[0])
                    return
                else:
                    cached_obj = json.loads(cached_data[0])
                    _display_object_info(cached_obj)
                    return

        except sqlite3.Error as e:
            print(f"SQLite error: {e}")
            # Continue with regular lookup if cache fails
            pass

    # Customize Simbad query to include more fields
    simbad = Simbad()

    try:
        # Change the normal query_object to an ADQL query to work around
        #   "allfluxes" not existing for certain objects.
        result_table = simbad.query_tap(
            f"""SELECT basic."main_id", basic."ra", basic."dec", basic."coo_err_maj", 
                       basic."coo_err_min", basic."coo_err_angle", basic."coo_wavelength", 
                       basic."coo_bibcode", 
                       allfluxes."V", 
                       basic."galdim_minaxis", basic."otype", basic."oid", basic."pmdec", 
                       basic."galdim_angle", basic."pmra", basic."galdim_majaxis", basic."sp_type", 
                       basic."plx_value", basic."galdim_minaxis_prec", basic."galdim_wavelength", 
                       basic."galdim_bibcode", basic."galdim_majaxis_prec", basic."galdim_qual", 
                       ident."id" AS "matched_id" 
                  FROM basic 
                  LEFT JOIN allfluxes ON basic."oid" = allfluxes."oidref" 
                  JOIN ident ON basic."oid" = ident."oidref" 
                 WHERE id = '{object_name}'
              """)

        if result_table is None or len(result_table) == 0:
            print(f"No results found for '{object_name}'")
            return

        # Get the main object information
        obj = result_table[0]

        # Create a structured object with all the data
        object_data = {"name": obj['main_id'].decode() if isinstance(obj['main_id'], bytes) else obj['main_id'],
                       "type": obj['otype'].decode() if isinstance(obj['otype'], bytes) else obj['otype'],
                       "coordinates": {
                           "ra": float(obj['ra']),
                           "dec": float(obj['dec']),
                           "ra_str": str(obj['ra']),
                           "dec_str": str(obj['dec'])
                       }, "size": {}}

        # Size information
        has_size = False

        # Check for dimensions string first
        if 'dimensions' in obj.colnames and obj['dimensions'] is not None:
            dim_str = obj['dimensions'].decode() if isinstance(obj['dimensions'], bytes) else obj['dimensions']
            if dim_str and dim_str.strip():
                object_data["size"]["dimensions"] = dim_str
                has_size = True

        # If no dimensions string, check for major/minor axis values
        if not has_size and 'galdim_majaxis' in obj.colnames and obj['galdim_majaxis'] is not None:
            major_axis = obj['galdim_majaxis']
            if major_axis > 0:
                minor_axis = obj['galdim_minaxis'] if 'galdim_minaxis' in obj.colnames and obj[
                    'galdim_minaxis'] is not None else major_axis
                pa = obj['galdim_angle'] if 'galdim_angle' in obj.colnames and obj['galdim_angle'] is not None else 0

                object_data["size"]["major_axis"] = float(major_axis)
                object_data["size"]["minor_axis"] = float(minor_axis)
                object_data["size"]["position_angle"] = float(pa)

                # Also add formatted display values
                if major_axis >= 60:
                    major_arcmin = major_axis / 60
                    minor_arcmin = minor_axis / 60
                    object_data["size"]["formatted"] = f"{major_arcmin:.1f}′ × {minor_arcmin:.1f}′ (PA: {pa}°)"
                else:
                    object_data["size"]["formatted"] = f"{major_axis:.1f}″ × {minor_axis:.1f}″ (PA: {pa}°)"
                has_size = True

        # If no size information was found
        if not has_size:
            # For stars and point sources, we typically don't have size
            if 'otype' in obj.colnames and obj['otype'] is not None:
                otype = obj['otype'].decode() if isinstance(obj['otype'], bytes) else obj['otype']
                if 'Star' in otype or '*' in otype:
                    object_data["size"]["type"] = "point_source"
                else:
                    object_data["size"]["type"] = "unknown"
            else:
                object_data["size"]["type"] = "unknown"

        # Optional information
        if obj['plx_value'] is not None and obj['plx_value'] != 0:
            dist_pc = 1000.0 / obj['plx_value']
            dist_ly = dist_pc * 3.26156
            object_data["distance"] = {
                "parsecs": float(dist_pc),
                "light_years": float(dist_ly)
            }

        if obj['sp_type'] is not None:
            object_data["spectral_type"] = obj['sp_type'].decode() if isinstance(obj['sp_type'], bytes) else obj[
                'sp_type']

        if obj['V'] is not None:
            object_data["visual_magnitude"] = float(obj['V'])

        # Proper motion if available
        if obj['pmra'] is not None and obj['pmdec'] is not None and obj['pmra'] != '--' and obj['pmdec'] != '--':
            object_data["proper_motion"] = {
                "ra": float(obj['pmra']),
                "dec": float(obj['pmdec'])
            }

        if 'RV_VALUE' in obj.colnames and obj['RV_VALUE'] is not None:
            object_data["radial_velocity"] = float(obj['RV_VALUE'])

        # Get alternative identifiers
        other_names = simbad.query_objectids(object_name)
        alt_names = []
        if other_names is not None and len(other_names) > 0:
            alt_names = [
                name['id'].decode() if isinstance(name['id'], bytes) else name['id']
                for name in other_names
            ]
            object_data["alternative_names"] = alt_names

        # Extract catalog information from main ID and alternative names
        catalogs = _extract_catalog_references([object_data["name"]] + alt_names)
        if catalogs:
            object_data["catalogs"] = catalogs

        # Extract common name from the list of names
        common_name = _extract_common_name([object_data["name"]] + alt_names)
        if common_name:
            object_data["common_name"] = common_name

        # Cache the data if requested
        if cache and conn:
            try:
                json_data = json.dumps(object_data)
                timestamp = datetime.now().isoformat()
                cursor.execute(
                    "INSERT OR REPLACE INTO object_cache (object_name, data, timestamp) VALUES (?, ?, ?)",
                    (object_name, json_data, timestamp)
                )
                conn.commit()
            except sqlite3.Error as e:
                print(f"Error caching data: {e}")

        # Output results based on format choice
        if output_json:
            print(json.dumps(object_data, indent=2))
        else:
            _display_object_info(object_data)

    except Exception as e:
        print(f"Error querying Simbad: {e}")
    finally:
        if cache and conn:
            conn.close()


if __name__ == "__main__":
    app()
