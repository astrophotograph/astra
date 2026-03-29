#!/usr/bin/env python3
"""Test plate solving with different solvers.

Usage:
    cd python && uv run python ../scripts/test_plate_solve.py <fits_file> [--solver nova|local|astap|tetra3]

If no solver is specified, tries all available solvers.
"""

import sys
import time
from pathlib import Path

# Add parent python dir to path
sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

from astra_astro.plate_solve import (
    detect_solvers,
    extract_solve_hints,
    solve_image,
)


def main():
    if len(sys.argv) < 2:
        print("Usage: test_plate_solve.py <fits_file> [--solver name] [--tetra3-db path]")
        sys.exit(1)

    fits_path = sys.argv[1]
    solver_filter = None
    tetra3_db = None

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--solver" and i + 1 < len(sys.argv):
            solver_filter = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--tetra3-db" and i + 1 < len(sys.argv):
            tetra3_db = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    if not Path(fits_path).exists():
        print(f"File not found: {fits_path}")
        sys.exit(1)

    # Extract hints
    print(f"Image: {fits_path}")
    print()
    hints = extract_solve_hints(fits_path)
    if hints:
        print("FITS Hints:")
        for k, v in hints.items():
            if v is not None:
                print(f"  {k}: {v}")
        print()

    # Detect solvers
    solvers = detect_solvers()
    print("Available solvers:")
    for name, info in solvers.items():
        status = "OK" if info["available"] else "not found"
        print(f"  {name}: {status} — {info['details']}")
    print()

    # Determine which solvers to test
    if solver_filter:
        test_solvers = [solver_filter]
    else:
        # Test all available non-remote solvers
        test_solvers = [
            name for name, info in solvers.items()
            if info["available"] and name != "nova"  # skip nova (needs API key, slow)
        ]

    if not test_solvers:
        print("No solvers available to test.")
        sys.exit(1)

    # Run solvers
    for solver_name in test_solvers:
        print(f"{'=' * 60}")
        print(f"Solver: {solver_name}")
        print(f"{'=' * 60}")

        kwargs = {
            "image_path": fits_path,
            "solver": solver_name,
        }

        # Add scale hints if available
        if hints.get("scale_lower"):
            kwargs["scale_lower"] = hints["scale_lower"]
            kwargs["scale_upper"] = hints["scale_upper"]

        if solver_name == "nova":
            import os
            api_key = os.environ.get("ASTROMETRY_API_KEY", "")
            if not api_key:
                print("  Skipping (set ASTROMETRY_API_KEY env var)")
                print()
                continue
            kwargs["api_key"] = api_key

        t0 = time.time()
        result = solve_image(**kwargs)
        elapsed = time.time() - t0

        if result["success"]:
            print(f"  SUCCESS in {result.get('solveTime', elapsed):.1f}s")
            print(f"  RA:          {result['centerRa']:.4f}°")
            print(f"  Dec:         {result['centerDec']:.4f}°")
            print(f"  Pixel scale: {result['pixelScale']:.3f}\"/px")
            print(f"  Rotation:    {result['rotation']:.1f}°")
            print(f"  FOV:         {result['widthDeg'] * 60:.1f}' x {result['heightDeg'] * 60:.1f}'")
        else:
            print(f"  FAILED in {elapsed:.1f}s")
            print(f"  Error: {result.get('errorMessage', 'unknown')}")
        print()


if __name__ == "__main__":
    main()
