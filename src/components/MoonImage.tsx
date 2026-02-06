/**
 * MoonImage - Renders a realistic moon phase visualization
 *
 * Based on https://codebox.net/pages/html-moon-planet-phases
 * Uses the drawPlanetPhase algorithm with a moon texture overlay
 */

import { useEffect, useRef, useCallback } from "react";

interface MoonImageConfig {
  shadowColour: string;
  lightColour: string;
  diameter: number;
  earthshine: number;
  blur: number;
}

interface MoonImageProps {
  illumination: number; // 0-1, where 0 = new moon, 1 = full moon
  waxing: boolean; // true = shadow on left, false = shadow on right
  showImage?: boolean; // whether to overlay the moon texture
  diameter?: number; // size in pixels
}

function calcInner(outerDiameter: number, semiPhase: number) {
  const absPhase = Math.abs(semiPhase);
  const n = ((1 - absPhase) * outerDiameter / 2) || 0.01;
  const innerRadius = n / 2 + (outerDiameter * outerDiameter) / (8 * n);

  return {
    d: innerRadius * 2,
    o: semiPhase > 0
      ? (outerDiameter / 2 - n)
      : (-2 * innerRadius + outerDiameter / 2 + n)
  };
}

function setCss(el: HTMLElement, props: Record<string, string>) {
  for (const p in props) {
    el.style.setProperty(
      p.replace(/([A-Z])/g, "-$1").toLowerCase(),
      props[p]
    );
  }
}

function drawDiscs(
  outer: { box: HTMLElement; diameter: number; colour: string; innerTop: boolean },
  inner: { box: HTMLElement; diameter: number; colour: string; offset: number; opacity: number; innerTop: boolean },
  blurSize: number
) {
  const blurredDiameter = inner.diameter - blurSize;
  const blurredOffset = inner.offset + blurSize / 2;

  // Draw outer box
  setCss(outer.box, {
    position: "absolute",
    height: outer.diameter + "px",
    width: outer.diameter + "px",
    backgroundColor: outer.colour,
    borderRadius: (outer.diameter / 2) + "px",
    overflow: "hidden",
    zIndex: outer.innerTop ? "10" : "20"
  });

  // Draw inner box
  setCss(inner.box, {
    position: "absolute",
    backgroundColor: inner.colour,
    borderRadius: (blurredDiameter / 2) + "px",
    height: blurredDiameter + "px",
    width: blurredDiameter + "px",
    left: blurredOffset + "px",
    top: ((outer.diameter - blurredDiameter) / 2) + "px",
    boxShadow: `0px 0px ${blurSize}px ${blurSize}px ${inner.colour}`,
    zIndex: inner.innerTop ? "20" : "10"
  });
}

function drawPlanetPhase(
  containerEl: HTMLElement,
  phase: number,
  isWaxing: boolean,
  config: MoonImageConfig
) {
  // Clear any existing content
  containerEl.innerHTML = "";

  // Nudge phase if around 0.5 due to algorithm edge case
  if (phase >= 0.49 && phase <= 0.51) {
    phase = 0.49;
  }

  const outerBox = document.createElement("div");
  containerEl.appendChild(outerBox);

  const innerBox = document.createElement("div");
  outerBox.appendChild(innerBox);

  let outerColour: string;
  let innerColour: string;
  let innerTop: boolean;

  if (phase < 0.5) {
    outerColour = config.lightColour;
    innerColour = config.shadowColour;
    innerTop = true;
    if (isWaxing) {
      phase *= -1;
    }
  } else {
    outerColour = config.shadowColour;
    innerColour = config.lightColour;
    innerTop = false;
    phase = 1 - phase;
    if (!isWaxing) {
      phase *= -1;
    }
  }

  const innerVals = calcInner(config.diameter, phase * 2);

  drawDiscs(
    {
      box: outerBox,
      diameter: config.diameter,
      colour: outerColour,
      innerTop: innerTop
    },
    {
      box: innerBox,
      diameter: innerVals.d,
      colour: innerColour,
      offset: innerVals.o,
      opacity: 1 - config.earthshine,
      innerTop: innerTop
    },
    config.blur
  );
}

export function MoonImage({
  illumination,
  waxing,
  showImage = true,
  diameter = 100
}: MoonImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    if (!containerRef.current) return;

    drawPlanetPhase(containerRef.current, illumination, waxing, {
      shadowColour: "black",
      lightColour: "#606060",
      diameter: diameter,
      earthshine: 0,
      blur: 3
    });
  }, [illumination, waxing, diameter]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div
      className="relative grid place-items-center"
      style={{ height: diameter, minWidth: diameter * 1.5 }}
    >
      {showImage && (
        <img
          src="/images/moon-small.jpg"
          alt="Moon texture"
          className="absolute z-30 opacity-30 object-contain"
          style={{ height: diameter }}
        />
      )}
      <div style={{ height: diameter, width: diameter, position: "relative" }}>
        <div ref={containerRef} />
      </div>
    </div>
  );
}
