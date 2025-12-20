"use client"

import {useEffect, useRef} from "react"
import {useMeasure} from "@uidotdev/usehooks"
import {cx} from "class-variance-authority"

function annotate(
  ctx: any,
  x: number,
  y: number,
  radius: number,
  label: string,
  width: number,
  height: number,
) {
  console.log("annotate", label, {x, y, radius, width, height})
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, 2 * Math.PI)
  ctx.strokeStyle = 'green' // `rgb(128, 128, 255, 30)`
  ctx.stroke()

  // If near right edge, move label to the left...
  if (x + 75 > width) {
    x -= 75
  }
  if (y + radius + 25 > height) {
    y -= 2 * radius + 25
  }

  ctx.fillStyle = `rgb(128, 128, 255, 30)`
  ctx.font = "20px Arial"
  ctx.fillText(label, x, y + radius + 20)
}

function drawAnnotations(
  ctx: any,
  annotations: any[],
  width: number,
  height: number,
  scale: number,
) {
  for (const annotation of annotations) {
    // console.log("annotation", annotation, {scale, width, height})
    if (annotation.radius > 0) {
      // For now we just completely ignore point objects
      annotate(
        ctx,
        annotation.pixelx * scale,
        annotation.pixely * scale,
        annotation.radius * scale,
        annotation.names.join(' / '),
        width,
        height,
      )
    }
  }
}

export function Annotation({
                             annotations,
                             native_width,
                             native_height,
                             parent_width,
                             parent_height,
                             visible,
                           }: {
  annotations: any[];
  native_height: number;
  native_width: number;
  parent_height: number | null;
  parent_width: number | null;
  visible: boolean;
}) {
  const [ref, {width, height}] = useMeasure()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const redraw = (alpha: number) => {
    const canvas = canvasRef.current
    if (canvas) {
      console.log('canvas', canvas, {width, height})
      const ctx = canvas!.getContext("2d")

      if (ctx && width && height) {
        ctx.globalAlpha = alpha
        ctx.clearRect(0, 0, width, height)

        drawAnnotations(ctx, annotations, width, height, width / native_width)
      }
    }
  }

  useEffect(() => {
    // console.dir(canvasRef.current)
    console.log('effect', {width, height, parent_width, parent_height})
    if (annotations && width && height) {
      redraw(1.0)
    }
  }, [width, height, parent_width, parent_height])

  return (
    <canvas
      ref={(element) => {
        // We want to capture the ref, plus call useMeasure
        canvasRef.current = element
        ref(element)
      }}
      id={"overlay-canvas"}
      className={cx("absolute bg-amber-500/5 transition-all duration-1000", visible ? 'opacity-100' : 'opacity-0')}
      width={parent_width!}
      height={parent_height!}
    />
  )
}

/*
 function showOverlay() {
            const img = document.getElementById('target-image');
            const overlayCanvas = document.getElementById('overlay-canvas');
            const ctx = overlayCanvas.getContext('2d');
            const width = img.offsetWidth;
            const height = img.offsetHeight;
            const scale = img.offsetWidth / img.naturalWidth;

            overlayCanvas.width = width;
            overlayCanvas.height = height;

            {% for annotation in image.normalized_annotations %}
                annotate(ctx,
                    {{ annotation.pixelx }} * scale,
                    {{ annotation.pixely }} * scale,
                    {{ annotation.radius }} * scale,
                    "{{ annotation.names | join(" / ") }}",
                    width, height);
            {% endfor %}
            overlayCanvas.classList.remove('hidden');
        }

 */
