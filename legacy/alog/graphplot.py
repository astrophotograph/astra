"""Starmap plotting"""
import math

import numpy as np
from starplot import MapPlot, Projection, _, PolygonStyle, ColorStr
from starplot.styles import PlotStyle, extensions

from alog.models import ImageRectangle


def plot_graph(rectangles: list[ImageRectangle]):
    style = PlotStyle().extend(
        # extensions.BLUE_LIGHT,
        extensions.BLUE_GOLD,
        extensions.MAP,
        {
            "legend": {
                "location": "lower right",  # show legend inside map
                "num_columns": 3,
                "background_alpha": 1,
            },
        },
    )

    # Track min/max coordinates to set proper axis limits
    min_ra, max_ra = float('inf'), float('-inf')
    min_dec, max_dec = float('inf'), float('-inf')

    grand_total_exposure = sum([rect.total_exposure_time for rect in rectangles])
    print(f'{grand_total_exposure=}')

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


        # if rect.total_exposure_time < 60:
        #     alpha = min(1.0, 20 / len(rectangles))
        # else:
        #     alpha = 0.5
        # polygon = patches.Polygon(final_points, closed=True,
        #                           edgecolor='blue', facecolor='blue', alpha=alpha, zorder=3)
        # ax.add_patch(polygon)

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


    print(min_ra, max_ra, min_dec, max_dec)
    padding = max(max_ra - min_ra, max_dec - min_dec) * 1.5 # Adjust this number to adjust padding
    p = MapPlot(
        projection=Projection.MERCATOR,  # specify a non-perspective projection
        ra_min=min_ra - padding,  # limit the map to a specific area
        ra_max=max_ra + padding,
        dec_min=min_dec - padding,
        dec_max=max_dec + padding,
        style=style,
        resolution=3600,
        autoscale=True,  # automatically adjust the scale based on the resolution
    )

    p.gridlines()  # add gridlines
    p.constellations()
    p.constellation_borders()

    for rect in rectangles:
        # alpha = 0.1
        # Draw the rectangle.  Make the alpha value of a subframe low,
        # unless exposure time is over a minute.
        if rect.height > 2.0:
            alpha = rect.total_exposure_time / grand_total_exposure
            color = ColorStr('#0f0')
        else:
            alpha = 0.1
            color = ColorStr('#00f')

        p.rectangle(
            center=(rect.x,rect.y),
            height_degrees=rect.height,
            width_degrees=rect.width,
            angle=rect.rotation,
            style=PolygonStyle(color=color, alpha=alpha),
        )

    p.stars(
        where=[_.magnitude < 8], bayer_labels=True, flamsteed_labels=True
    )  # include Bayer and Flamsteed labels with the stars

    p.galaxies(where=[_.magnitude < 12.5], true_size=True)
    p.nebula(where=[(_.magnitude < 10) | (_.magnitude.isnull())])
    p.open_clusters(
        where=[(_.magnitude < 9) | (_.magnitude.isnull())], where_labels=[False]
    )

    p.milky_way()
    p.ecliptic()

    p.legend()  # add a legend

    p.constellation_labels()  # Plot the constellation labels last for best placement

    p.export("tutorial_04.png", padding=0.2)

if __name__ == "__main__":
    plot_graph()