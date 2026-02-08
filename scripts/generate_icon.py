#!/usr/bin/env python3
"""Generate an astronomy-themed icon for Astra.

Creates a 1024x1024 PNG with a stylized diffraction star
on a deep navy background, suitable for Tauri icon generation.
"""

import math

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
CENTER = SIZE // 2
RADIUS = SIZE // 2


def draw_diffraction_star(
    img: Image.Image,
    cx: int,
    cy: int,
    length: int,
    width: int,
    color: tuple[int, ...],
    rotation: float = 0,
) -> None:
    """Draw a 4-pointed diffraction spike star."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for i in range(4):
        angle = math.radians(rotation + i * 90)
        # Tip of spike
        tx = cx + math.cos(angle) * length
        ty = cy + math.sin(angle) * length
        # Perpendicular for width
        perp = angle + math.pi / 2
        half_w = width / 2
        # Base points (at center)
        bx1 = cx + math.cos(perp) * half_w
        by1 = cy + math.sin(perp) * half_w
        bx2 = cx - math.cos(perp) * half_w
        by2 = cy - math.sin(perp) * half_w

        draw.polygon([(bx1, by1), (tx, ty), (bx2, by2)], fill=color)

    img.paste(Image.alpha_composite(Image.new("RGBA", img.size, (0, 0, 0, 0)), overlay), mask=overlay)
    return overlay


def create_icon() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- Circular background ---
    # Deep navy base
    draw.ellipse([0, 0, SIZE - 1, SIZE - 1], fill=(8, 12, 32, 255))

    # Subtle radial gradient (lighter center)
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gradient)
    for r in range(RADIUS, 0, -3):
        t = r / RADIUS  # 1.0 at edge, 0.0 at center
        alpha = int(25 * (1 - t * t))
        gdraw.ellipse(
            [CENTER - r, CENTER - r, CENTER + r, CENTER + r],
            fill=(30, 50, 100, alpha),
        )
    img = Image.alpha_composite(img, gradient)

    # --- Glow around center star ---
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for r in range(240, 0, -2):
        t = r / 240
        alpha = int(80 * (1 - t) * (1 - t))
        gdraw.ellipse(
            [CENTER - r, CENTER - r, CENTER + r, CENTER + r],
            fill=(160, 190, 255, alpha),
        )
    img = Image.alpha_composite(img, glow)

    # --- Main diffraction star (4-pointed, rotated 45 degrees) ---
    # Outer glow spikes
    spike_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_diffraction_star(spike_glow, CENTER, CENTER, 380, 14, (120, 160, 255, 60), rotation=45)
    spike_glow = spike_glow.filter(ImageFilter.GaussianBlur(radius=8))
    img = Image.alpha_composite(img, spike_glow)

    # Main spikes
    spike_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_diffraction_star(spike_layer, CENTER, CENTER, 350, 8, (200, 220, 255, 220), rotation=45)
    img = Image.alpha_composite(img, spike_layer)

    # Bright inner spikes
    spike_bright = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_diffraction_star(spike_bright, CENTER, CENTER, 280, 4, (240, 245, 255, 255), rotation=45)
    img = Image.alpha_composite(img, spike_bright)

    # Secondary shorter spikes (0 degrees)
    spike2 = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_diffraction_star(spike2, CENTER, CENTER, 160, 5, (180, 200, 255, 140), rotation=0)
    img = Image.alpha_composite(img, spike2)

    # --- Center bright point ---
    center_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(center_glow)
    for r in range(60, 0, -1):
        t = r / 60
        alpha = int(255 * (1 - t))
        cdraw.ellipse(
            [CENTER - r, CENTER - r, CENTER + r, CENTER + r],
            fill=(255, 255, 255, alpha),
        )
    img = Image.alpha_composite(img, center_glow)

    draw = ImageDraw.Draw(img)
    draw.ellipse(
        [CENTER - 22, CENTER - 22, CENTER + 22, CENTER + 22],
        fill=(255, 255, 255, 255),
    )

    # --- Small accent stars ---
    small_stars = [
        (220, 260, 55, 0.7),
        (730, 220, 42, 0.5),
        (280, 720, 48, 0.6),
        (720, 680, 38, 0.5),
        (160, 480, 28, 0.4),
        (810, 420, 32, 0.4),
        (420, 180, 25, 0.3),
        (600, 800, 30, 0.35),
    ]

    for sx, sy, ssize, brightness in small_stars:
        # Only draw if within the circle
        dist = math.sqrt((sx - CENTER) ** 2 + (sy - CENTER) ** 2)
        if dist + ssize < RADIUS - 20:
            alpha = int(255 * brightness)
            # Small glow
            star_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
            sgdraw = ImageDraw.Draw(star_glow)
            for r in range(ssize, 0, -2):
                t = r / ssize
                a = int(alpha * 0.3 * (1 - t))
                sgdraw.ellipse(
                    [sx - r, sy - r, sx + r, sy + r],
                    fill=(160, 190, 255, a),
                )
            img = Image.alpha_composite(img, star_glow)

            # Small diffraction spikes
            small_spike = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
            draw_diffraction_star(
                small_spike, sx, sy, ssize, 2, (200, 220, 255, alpha), rotation=45
            )
            img = Image.alpha_composite(img, small_spike)

            # Center dot
            draw = ImageDraw.Draw(img)
            dot_r = max(3, ssize // 8)
            draw.ellipse(
                [sx - dot_r, sy - dot_r, sx + dot_r, sy + dot_r],
                fill=(255, 255, 255, alpha),
            )

    # --- Clip to circle ---
    mask = Image.new("L", (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse([0, 0, SIZE - 1, SIZE - 1], fill=255)
    img.putalpha(mask)

    return img


if __name__ == "__main__":
    import os

    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    output = os.path.join(root_dir, "src-tauri", "icons", "icon_source.png")

    icon = create_icon()
    icon.save(output, "PNG")
    print(f"Icon saved to {output}")
    print("Run 'npx tauri icon src-tauri/icons/icon_source.png' to generate all sizes")
