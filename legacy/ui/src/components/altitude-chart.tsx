"use client";

import {useEffect, useRef} from "react"
import * as d3 from "d3"
import {AltitudePoint} from "@/lib/astronomy-utils"

interface AltitudeChartProps {
  data: AltitudePoint[];
  width?: number;
  height?: number;
}

export function AltitudeChart({ data, width = 400, height = 200 }: AltitudeChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !data.length) return;

    // Clear any existing chart
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current);
    const margin = { top: 20, right: 30, bottom: 40, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    // Create the container group
    const g = svg.append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Create scales
    const xScale = d3.scaleTime()
      .domain(d3.extent(data, d => d.time) as [Date, Date])
      .range([0, innerWidth]);

    const yScale = d3.scaleLinear()
      .domain([0, Math.max(90, d3.max(data, d => d.altitude) as number)])
      .range([innerHeight, 0]);

    // Create axes
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat(d => d3.timeFormat("%H:%M")(d as Date));

    const yAxis = d3.axisLeft(yScale)
      .ticks(5)
      .tickFormat(d => `${d}°`);

    g.append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(xAxis)
      .selectAll("text")
      .attr("fill", "currentColor")
      .attr("font-size", "10px");

    g.append("g")
      .attr("class", "y-axis")
      .call(yAxis)
      .selectAll("text")
      .attr("fill", "currentColor")
      .attr("font-size", "10px");

    // Add X axis label
    g.append("text")
      .attr("class", "x-axis-label")
      .attr("x", innerWidth / 2)
      .attr("y", innerHeight + margin.bottom - 5)
      .attr("text-anchor", "middle")
      .attr("fill", "currentColor")
      .attr("font-size", "12px")
      .text("Time");

    // Add Y axis label
    g.append("text")
      .attr("class", "y-axis-label")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -margin.left + 15)
      .attr("text-anchor", "middle")
      .attr("fill", "currentColor")
      .attr("font-size", "12px")
      .text("Altitude (°)");

    // Create the line generator
    const line = d3.line<AltitudePoint>()
      .x(d => xScale(d.time))
      .y(d => yScale(d.altitude))
      .curve(d3.curveMonotoneX);

    // Add ideal observation region
    const idealPoints = data.filter(d => d.isIdeal);
    if (idealPoints.length > 0) {
      const idealRanges: [number, number][] = [];
      let start = -1;

      for (let i = 0; i < data.length; i++) {
        if (data[i].isIdeal && start === -1) {
          start = i;
        } else if (!data[i].isIdeal && start !== -1) {
          idealRanges.push([start, i - 1]);
          start = -1;
        }
      }

      if (start !== -1) {
        idealRanges.push([start, data.length - 1]);
      }

      idealRanges.forEach(([startIdx, endIdx]) => {
        g.append("rect")
          .attr("x", xScale(data[startIdx].time))
          .attr("y", 0)
          .attr("width", xScale(data[endIdx].time) - xScale(data[startIdx].time))
          .attr("height", innerHeight)
          .attr("fill", "rgba(0, 255, 0, 0.1)")
          .attr("stroke", "none");
      });
    }

    // Add 20° horizontal reference line
    g.append("line")
      .attr("x1", 0)
      .attr("y1", yScale(20))
      .attr("x2", innerWidth)
      .attr("y2", yScale(20))
      .attr("stroke", "rgba(255, 255, 255, 0.3)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4");

    g.append("text")
      .attr("x", 5)
      .attr("y", yScale(20) - 5)
      .attr("fill", "rgba(255, 255, 255, 0.6)")
      .attr("font-size", "10px")
      .text("Ideal (20°)");

    // Draw the line
    g.append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", "rgb(99, 102, 241)")
      .attr("stroke-width", 2)
      .attr("d", line);

    // Add current time marker
    const now = new Date();
    if (now >= data[0].time && now <= data[data.length - 1].time) {
      g.append("line")
        .attr("x1", xScale(now))
        .attr("y1", 0)
        .attr("x2", xScale(now))
        .attr("y2", innerHeight)
        .attr("stroke", "red")
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5");

      // Find the current altitude
      const currentAltitude = data.reduce((closest, point) => {
        const currentDiff = Math.abs(point.time.getTime() - now.getTime());
        const closestDiff = Math.abs(closest.time.getTime() - now.getTime());
        return currentDiff < closestDiff ? point : closest;
      }, data[0]);

      g.append("circle")
        .attr("cx", xScale(now))
        .attr("cy", yScale(currentAltitude.altitude))
        .attr("r", 4)
        .attr("fill", "red");
    }

  }, [data, width, height]);

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
