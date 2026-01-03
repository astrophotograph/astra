/**
 * Altitude Chart - D3-based visualization of object altitude over time
 */

import { useEffect, useRef } from "react";
import * as d3 from "d3";

export interface AltitudeDataPoint {
  time: Date;
  altitude: number;
  azimuth?: number;
  isIdeal?: boolean;
}

export interface HorizonDataPoint {
  time: Date;
  altitude: number;
}

interface AltitudeChartProps {
  data: AltitudeDataPoint[];
  horizonData?: HorizonDataPoint[];  // Local horizon line data
  width?: number;
  height?: number;
  showCurrentTime?: boolean;
  idealThreshold?: number;
}

export function AltitudeChart({
  data,
  horizonData,
  width = 400,
  height = 200,
  showCurrentTime = true,
  idealThreshold = 20,
}: AltitudeChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !data.length) return;

    // Clear any existing chart
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current);
    const margin = { top: 20, right: 30, bottom: 40, left: 45 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    // Create the container group
    const g = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Create scales
    const xScale = d3
      .scaleTime()
      .domain(d3.extent(data, (d) => d.time) as [Date, Date])
      .range([0, innerWidth]);

    const yScale = d3
      .scaleLinear()
      .domain([0, Math.max(90, d3.max(data, (d) => d.altitude) as number)])
      .range([innerHeight, 0]);

    // Create axes
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => d3.timeFormat("%H:%M")(d as Date));

    const yAxis = d3
      .axisLeft(yScale)
      .ticks(5)
      .tickFormat((d) => `${d}°`);

    // Add grid lines
    g.append("g")
      .attr("class", "grid")
      .attr("opacity", 0.1)
      .call(
        d3
          .axisLeft(yScale)
          .ticks(5)
          .tickSize(-innerWidth)
          .tickFormat(() => "")
      );

    // X axis
    g.append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(xAxis)
      .selectAll("text")
      .attr("fill", "currentColor")
      .attr("font-size", "10px");

    // Y axis
    g.append("g")
      .attr("class", "y-axis")
      .call(yAxis)
      .selectAll("text")
      .attr("fill", "currentColor")
      .attr("font-size", "10px");

    // Style axis lines
    g.selectAll(".domain, .tick line").attr("stroke", "currentColor").attr("opacity", 0.3);

    // Add X axis label
    g.append("text")
      .attr("class", "x-axis-label")
      .attr("x", innerWidth / 2)
      .attr("y", innerHeight + margin.bottom - 5)
      .attr("text-anchor", "middle")
      .attr("fill", "currentColor")
      .attr("font-size", "11px")
      .text("Time");

    // Add Y axis label
    g.append("text")
      .attr("class", "y-axis-label")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -margin.left + 12)
      .attr("text-anchor", "middle")
      .attr("fill", "currentColor")
      .attr("font-size", "11px")
      .text("Altitude (°)");

    // Add ideal observation region (above threshold)
    const idealPoints = data.filter((d) => d.altitude >= idealThreshold);
    if (idealPoints.length > 0) {
      // Find continuous ranges above threshold
      const ranges: { start: Date; end: Date }[] = [];
      let rangeStart: Date | null = null;

      for (let i = 0; i < data.length; i++) {
        if (data[i].altitude >= idealThreshold && rangeStart === null) {
          rangeStart = data[i].time;
        } else if (data[i].altitude < idealThreshold && rangeStart !== null) {
          ranges.push({ start: rangeStart, end: data[i - 1].time });
          rangeStart = null;
        }
      }
      if (rangeStart !== null) {
        ranges.push({ start: rangeStart, end: data[data.length - 1].time });
      }

      // Draw ideal regions
      ranges.forEach((range) => {
        g.append("rect")
          .attr("x", xScale(range.start))
          .attr("y", 0)
          .attr("width", xScale(range.end) - xScale(range.start))
          .attr("height", innerHeight)
          .attr("fill", "rgba(34, 197, 94, 0.1)")
          .attr("stroke", "none");
      });
    }

    // Add threshold horizontal reference line
    g.append("line")
      .attr("x1", 0)
      .attr("y1", yScale(idealThreshold))
      .attr("x2", innerWidth)
      .attr("y2", yScale(idealThreshold))
      .attr("stroke", "rgba(34, 197, 94, 0.5)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4");

    g.append("text")
      .attr("x", 5)
      .attr("y", yScale(idealThreshold) - 5)
      .attr("fill", "rgba(34, 197, 94, 0.8)")
      .attr("font-size", "10px")
      .text(`Ideal (${idealThreshold}°)`);

    // Draw horizon line if provided
    if (horizonData && horizonData.length > 0) {
      // Create horizon line generator
      const horizonLine = d3
        .line<HorizonDataPoint>()
        .x((d) => xScale(d.time))
        .y((d) => yScale(d.altitude))
        .curve(d3.curveMonotoneX);

      // Draw filled area under horizon (obstructed region)
      const horizonArea = d3
        .area<HorizonDataPoint>()
        .x((d) => xScale(d.time))
        .y0(innerHeight)
        .y1((d) => yScale(d.altitude))
        .curve(d3.curveMonotoneX);

      g.append("path")
        .datum(horizonData)
        .attr("fill", "rgba(239, 68, 68, 0.1)")
        .attr("d", horizonArea);

      // Draw horizon line
      g.append("path")
        .datum(horizonData)
        .attr("fill", "none")
        .attr("stroke", "rgba(239, 68, 68, 0.6)")
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "6,3")
        .attr("d", horizonLine);

      // Add horizon label
      const lastHorizonPoint = horizonData[horizonData.length - 1];
      g.append("text")
        .attr("x", innerWidth - 5)
        .attr("y", yScale(lastHorizonPoint.altitude) - 5)
        .attr("text-anchor", "end")
        .attr("fill", "rgba(239, 68, 68, 0.8)")
        .attr("font-size", "10px")
        .text("Horizon");
    }

    // Create gradient for the area under the curve
    const gradient = svg
      .append("defs")
      .append("linearGradient")
      .attr("id", "altitude-gradient")
      .attr("x1", "0%")
      .attr("y1", "0%")
      .attr("x2", "0%")
      .attr("y2", "100%");

    gradient.append("stop").attr("offset", "0%").attr("stop-color", "rgb(99, 102, 241)").attr("stop-opacity", 0.3);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", "rgb(99, 102, 241)").attr("stop-opacity", 0.05);

    // Create the area generator
    const area = d3
      .area<AltitudeDataPoint>()
      .x((d) => xScale(d.time))
      .y0(innerHeight)
      .y1((d) => yScale(d.altitude))
      .curve(d3.curveMonotoneX);

    // Draw the area
    g.append("path")
      .datum(data)
      .attr("fill", "url(#altitude-gradient)")
      .attr("d", area);

    // Create the line generator
    const line = d3
      .line<AltitudeDataPoint>()
      .x((d) => xScale(d.time))
      .y((d) => yScale(d.altitude))
      .curve(d3.curveMonotoneX);

    // Draw the line
    g.append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", "rgb(99, 102, 241)")
      .attr("stroke-width", 2)
      .attr("d", line);

    // Add current time marker
    if (showCurrentTime) {
      const now = new Date();
      if (now >= data[0].time && now <= data[data.length - 1].time) {
        // Current time line
        g.append("line")
          .attr("x1", xScale(now))
          .attr("y1", 0)
          .attr("x2", xScale(now))
          .attr("y2", innerHeight)
          .attr("stroke", "rgb(239, 68, 68)")
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "5,5");

        // Find the current altitude (interpolate)
        const currentAltitude = data.reduce((closest, point) => {
          const currentDiff = Math.abs(point.time.getTime() - now.getTime());
          const closestDiff = Math.abs(closest.time.getTime() - now.getTime());
          return currentDiff < closestDiff ? point : closest;
        }, data[0]);

        // Current position dot
        g.append("circle")
          .attr("cx", xScale(now))
          .attr("cy", yScale(currentAltitude.altitude))
          .attr("r", 5)
          .attr("fill", "rgb(239, 68, 68)");

        // Current altitude label
        g.append("text")
          .attr("x", xScale(now) + 8)
          .attr("y", yScale(currentAltitude.altitude) + 4)
          .attr("fill", "rgb(239, 68, 68)")
          .attr("font-size", "11px")
          .attr("font-weight", "bold")
          .text(`${currentAltitude.altitude.toFixed(1)}°`);
      }
    }
  }, [data, horizonData, width, height, showCurrentTime, idealThreshold]);

  if (!data.length) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ width, height }}
      >
        No altitude data available
      </div>
    );
  }

  return (
    <div className="w-full h-full flex justify-center items-center">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="overflow-visible"
      />
    </div>
  );
}

/**
 * Helper function to get max altitude time from data
 */
export function getMaxAltitudeTime(data: AltitudeDataPoint[]): Date | null {
  if (data.length === 0) return null;

  let maxPoint = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i].altitude > maxPoint.altitude) {
      maxPoint = data[i];
    }
  }
  return maxPoint.time;
}

/**
 * Helper function to get ideal observation time range
 */
export function getIdealObservationTimeRange(
  data: AltitudeDataPoint[],
  threshold = 20
): { start: Date | null; end: Date | null } {
  const idealPoints = data.filter((point) => point.altitude >= threshold);

  if (idealPoints.length === 0) {
    return { start: null, end: null };
  }

  return {
    start: idealPoints[0].time,
    end: idealPoints[idealPoints.length - 1].time,
  };
}
