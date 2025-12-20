import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np
import math
from skyfield.api import load
from skyfield.data import hipparcos
from skyfield.named_stars import named_star_dict

from alog.models import ImageRectangle


def display_rectangles_and_stars(rectangles: list[ImageRectangle], facecolor='blue', magnitude_limit=10.0):
    """
    Display rectangles and visible stars on a celestial chart.
    
    Args:
        rectangles: List of dictionaries, each containing:
            - x, y: coordinates (x = right ascension in hours, y = declination in degrees)
            - width, height: dimensions of the rectangle
            - rotation: rotation angle in degrees
        magnitude_limit: Stars brighter than this magnitude will be displayed (default: 5.0)
    """
    # Create figure and axis
    fig, ax = plt.subplots(figsize=(12, 10))

    # Track min/max coordinates to set proper axis limits
    min_ra, max_ra = float('inf'), float('-inf')
    min_dec, max_dec = float('inf'), float('-inf')

    grand_total_exposure = sum([rect.total_exposure_time for rect in rectangles])

    # Plot each rectangle
    for rect in rectangles:
        # Convert RA to degrees for consistency (RA is usually in hours, 1 hour = 15 degrees)
        ra_deg = rect.x * 15 if rect.x < 24 else rect.x
        dec_deg = rect.y

        width_deg = rect.width
        height_deg = rect.height
        angle_deg = rect.rotation
        angle_rad = math.radians(angle_deg)

        # Create a rectangle centered at origin
        rect_points = np.array([
            [-width_deg / 2, -height_deg / 2],
            [width_deg / 2, -height_deg / 2],
            [width_deg / 2, height_deg / 2],
            [-width_deg / 2, height_deg / 2]
        ])

        # Rotation matrix
        rotation_matrix = np.array([
            [math.cos(angle_rad), -math.sin(angle_rad)],
            [math.sin(angle_rad), math.cos(angle_rad)]
        ])

        # Rotate rectangle points
        rotated_points = np.dot(rect_points, rotation_matrix.T)

        # Translate rectangle to center position
        final_points = rotated_points + np.array([ra_deg, dec_deg])

        # Draw the rectangle.  Make the alpha value of a subframe low,
        # unless exposure time is over a minute.
        # alpha = min(0.5, 50 * rect['total_exposure_time'] / grand_total_exposure)

        if rect.total_exposure_time < 60:
            alpha = min(1.0, 20 / len(rectangles))
        else:
            alpha = 0.5
        polygon = patches.Polygon(final_points, closed=True,
                                  edgecolor='blue', facecolor='blue', alpha=alpha, zorder=3)
        ax.add_patch(polygon)

        # Mark the center point
        # ax.plot(ra_deg, dec_deg, 'ro', markersize=4)

        # Update min/max coordinates
        rect_min_ra = final_points[:, 0].min()
        rect_max_ra = final_points[:, 0].max()
        rect_min_dec = final_points[:, 1].min()
        rect_max_dec = final_points[:, 1].max()

        min_ra = min(min_ra, rect_min_ra)
        max_ra = max(max_ra, rect_max_ra)
        min_dec = min(min_dec, rect_min_dec)
        max_dec = max(max_dec, rect_max_dec)

    # Add some padding to the plot
    padding = max(max_ra - min_ra, max_dec - min_dec) * 0.5 # Adjust this number to adjust padding
    plot_min_ra = min_ra - padding
    plot_max_ra = max_ra + padding
    plot_min_dec = min_dec - padding
    plot_max_dec = max_dec + padding

    star_names = {v: k for k, v in named_star_dict.items()}
    # Load Hipparcos catalog
    with load.open(hipparcos.URL) as f:
        df = hipparcos.load_dataframe(f)

    # Filter stars by magnitude
    bright_stars = df[df['magnitude'] <= magnitude_limit]
    plotted_stars = 0

    # Plot stars
    for idx, star in bright_stars.iterrows():
        ra_hours = star['ra_hours']
        dec_degrees = star['dec_degrees']
        magnitude = star['magnitude']

        # Convert RA to degrees
        ra_degrees = ra_hours * 15

        # Check if star is within our viewing area
        if (plot_min_ra <= ra_degrees <= plot_max_ra and
                plot_min_dec <= dec_degrees <= plot_max_dec):

            # Size of star marker based on magnitude (brighter stars = bigger)
            # Magnitude scale is reversed (smaller = brighter)
            # marker_size = max(1, ((magnitude_limit + 1) - magnitude) * 2)
            # max_marker_size = 100
            # marker_size = max_marker_size * 10 ** (magnitude / -2.5)
            # marker_size = (0.5 + magnitude_limit - magnitude) ** 2.0
            marker_size = min(7.5, 50 * 10 ** ((-1.44 - magnitude) / 4))

            # Color based on spectral type (simplified)
            spec_type = str(star['spectrum']).strip()[0] if 'spectrum' in star else ''
            color = 'white'
            if spec_type == 'O' or spec_type == 'B':
                color = 'lightskyblue'  # Blue-white
            elif spec_type == 'A':
                color = 'white'  # White
            elif spec_type == 'F':
                color = 'ivory'  # Yellowish-white
            elif spec_type == 'G':
                color = 'yellow'  # Yellow
            elif spec_type == 'K':
                color = 'orange'  # Orange
            elif spec_type == 'M':
                color = 'red'  # Red

            # Plot the star
            ax.plot(ra_degrees, dec_degrees, 'o', markersize=marker_size,
                    color=color, markeredgecolor='none', alpha=1.0, zorder=3)

            # Add label for very bright stars (magnitude < 2)
            if magnitude < 3.0 and star.name in star_names:
                ax.text(ra_degrees, dec_degrees, f" {star_names[star.name]}",
                        fontsize=8, color='white', alpha=0.7,
                        bbox=dict(facecolor='black', alpha=0.3, edgecolor='none', pad=1))
            plotted_stars += 1

    print(f"Number of stars brighter than {magnitude_limit}: {len(bright_stars)}.  Plotted: {plotted_stars} stars.")

    # Load constellations
    # url = ('https://raw.githubusercontent.com/Stellarium/stellarium/master'
    #       '/skycultures/modern_st/constellationship.fab')

    # with load.open(url) as f:
    #    constellations = stellarium.parse_constellations(f)

    # edges = [edge for name, edges in constellations for edge in edges]
    # edges_star1 = [star1 for star1, star2 in edges]
    # edges_star2 = [star2 for star1, star2 in edges]

    # The constellation lines will each begin at the x,y of one star and end
    # at the x,y of another.  We have to "rollaxis" the resulting coordinate
    # array into the shape that matplotlib expects.

    # xy1 = stars[['x', 'y']].loc[edges_star1].values
    # xy2 = stars[['x', 'y']].loc[edges_star2].values
    # lines_xy = np.rollaxis(np.array([xy1, xy2]), 1)

    # Draw the constellation lines.
    # ax.add_collection(LineCollection(lines_xy, colors='#00f2'))

    # Customize the plot
    ax.set_xlim(plot_max_ra, plot_min_ra)  # Flip RA
    ax.set_ylim(plot_min_dec, plot_max_dec)
    ax.set_facecolor('black')  # Night sky background

    # Set aspect ratio to be approximately equal at the declination being plotted
    mid_dec = (min_dec + max_dec) / 2
    # Approximate cos(dec) for aspect ratio
    aspect_ratio = 1.0 / max(0.05, abs(math.cos(math.radians(mid_dec))))
    ax.set_aspect(aspect_ratio)

    # Add grid and labels
    ax.grid(True, linestyle='--', alpha=0.3, color='gray')
    ax.set_xlabel('Right Ascension (degrees)')
    ax.set_ylabel('Declination (degrees)')
    ax.set_title('Star Chart with Field of View')

    # Add legend or explanation
    plt.figtext(0.02, 0.02, f'Stars brighter than magnitude {magnitude_limit}\nBlue rectangles: Fields of view',
                fontsize=8, color='white', bbox=dict(facecolor='black', alpha=0.7))

    plt.tight_layout()
    plt.show()

    return fig, ax


# Example usage
if __name__ == "__main__":
    # Example list of rectangles representing fields of view
    # x = RA in hours (0-24), y = Dec in degrees (-90 to +90)
    rectangles = [
        {'x': 5.5, 'y': 20, 'width': 5, 'height': 5, 'rotation': 0},  # Near Orion/Taurus
        {'x': 12.5, 'y': 12, 'width': 4, 'height': 4, 'rotation': 15},  # Near Virgo
        {'x': 20.7, 'y': -30, 'width': 6, 'height': 3, 'rotation': 30},  # Southern sky near Fomalhaut
        {'x': 2.5, 'y': 42, 'width': 3.5, 'height': 3.5, 'rotation': 0}  # Near Andromeda
    ]

    display_rectangles_and_stars(rectangles, magnitude_limit=4.5)
