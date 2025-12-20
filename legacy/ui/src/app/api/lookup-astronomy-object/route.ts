import { NextRequest, NextResponse } from "next/server";

function formatResult(result: any, objectName: string) {
  return {
    name: result[0] || objectName,
    ra: formatRA(result[1]),
    dec: formatDec(result[2]),
    magnitude: result[4] !== null ? result[4] : "N/A",
    size: "N/A",
    objectType: result[3] || "Unknown"
  };
}

function formatSimpleResult(result: any, objectName: string) {
  return {
    name: result.name || objectName,
    ra: formatRA(result.ra_deg),
    dec: formatDec(result.dec_deg),
    magnitude: "N/A",
    size: "N/A",
    objectType: "Unknown"
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const objectName = searchParams.get("name");

  if (!objectName) {
    return NextResponse.json(
      { error: "Object name is required" },
      { status: 400 }
    );
  }

  try {
    // Simbad TAP service endpoint
    const endpoint = "https://simbad.u-strasbg.fr/simbad/sim-tap/sync";

    // Corrected ADQL query for Simbad
    // Using proper table names and fields from the Simbad schema
    const query = `
      SELECT basic.main_id        AS name,
             ROUND(basic.ra, 6)   AS ra_deg,
             ROUND(basic.dec, 6)  AS dec_deg,
             ot.description       AS object_type,
             allfluxes.V,
             basic.otype
      FROM ident
      JOIN basic ON ident.oidref = basic.oid
      JOIN otypedef AS ot ON basic.otype = ot.otype
      LEFT JOIN allfluxes ON basic.oid = allfluxes.oidref
      WHERE ident.id LIKE '${objectName}%'
    `; // Changed to LIKE

    const params = new URLSearchParams({
      request: 'doQuery',
      lang: 'adql',
      format: 'json',
      query: query
    });

    const response = await fetch(`${endpoint}?${params}`);

    if (!response.ok) {
      const body = await response.text();
      console.log(body);
      throw new Error(`Simbad API request failed with status ${response.status}`);
    }

    const data = await response.json();
    console.log(data);

    if (data.data && data.data.length > 0) {
      return NextResponse.json(data.data.map((result: any) => formatResult(result, objectName)));
    }

    // If no results from complex query, try simple query
    const simpleQuery = `
      SELECT main_id AS name,
             ROUND(ra, 6) AS ra_deg,
             ROUND(dec, 6) AS dec_deg
        FROM basic
       WHERE main_id LIKE '%${objectName}%'
    `;

    const simpleParams = new URLSearchParams({
      request: 'doQuery',
      lang: 'adql',
      format: 'json',
      query: simpleQuery
    });

    const simpleResponse = await fetch(`${endpoint}?${simpleParams}`);

    if (!simpleResponse.ok) {
      return NextResponse.json(
        { error: "Object not found" },
        { status: 404 }
      );
    }

    const simpleData = await simpleResponse.json();

    if (!simpleData.data || simpleData.data.length === 0) {
      return NextResponse.json(
        { error: "Object not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(simpleData.data.map((result: any) => formatSimpleResult(result, objectName)));
  } catch (error) {
    console.error("Error fetching object data:", error);
    return NextResponse.json(
      { error: "Failed to fetch object data from Simbad" },
      { status: 500 }
    );
  }
}

// Helper functions to format RA and Dec
function formatRA(raDegrees: number | null): string {
  if (raDegrees === null) return "N/A";

  // Convert decimal degrees to hours, minutes, seconds
  const totalHours = raDegrees / 15; // 1 hour = 15 degrees
  const hours = Math.floor(totalHours);
  const totalMinutes = (totalHours - hours) * 60;
  const minutes = Math.floor(totalMinutes);
  const seconds = Math.round((totalMinutes - minutes) * 60);

  return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatDec(decDegrees: number | null): string {
  if (decDegrees === null) return "N/A";

  // Convert decimal degrees to degrees, arcminutes, arcseconds
  const sign = decDegrees < 0 ? "-" : "+";
  const absDec = Math.abs(decDegrees);
  const degrees = Math.floor(absDec);
  const totalArcMinutes = (absDec - degrees) * 60;
  const arcMinutes = Math.floor(totalArcMinutes);
  const arcSeconds = Math.round((totalArcMinutes - arcMinutes) * 60);

  return `${sign}${degrees.toString().padStart(2, '0')}° ${arcMinutes.toString().padStart(2, '0')}' ${arcSeconds.toString().padStart(2, '0')}"`;
}
