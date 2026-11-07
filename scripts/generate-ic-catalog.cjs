#!/usr/bin/env node
/**
 * Generate the IC catalog TypeScript file (src/lib/ic-catalog-data.ts) from
 * the OpenNGC database — the IC rows of
 * https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv
 * (CC-BY-SA-4.0, Mattia Verga). The CSV is not checked in; download it and run:
 *
 *   node scripts/generate-ic-catalog.cjs path/to/NGC.csv
 *
 * Same row shape as ngc-catalog-data.ts (generate-ngc-catalog.cjs). Rows for
 * object components ("IC2873 NED01"), duplicates ("Dup"), non-existent
 * entries ("NonEx") and plain/double stars are dropped: they are not things a
 * plate-solve overlay should label.
 */

const fs = require("fs");
const path = require("path");

const OBJECT_TYPE_MAP = {
  G: "Galaxy",
  GPair: "Galaxy Pair",
  GTrpl: "Galaxy Triplet",
  GGroup: "Galaxy Group",
  PN: "Planetary Nebula",
  HII: "HII Region",
  DrkN: "Dark Nebula",
  EmN: "Emission Nebula",
  Neb: "Nebula",
  RfN: "Reflection Nebula",
  SNR: "Supernova Remnant",
  OCl: "Open Cluster",
  GCl: "Globular Cluster",
  "Cl+N": "Cluster+Nebula",
  "*Ass": "Stellar Association",
  Nova: "Nova",
  Other: "Other",
};
const SKIP_TYPES = new Set(["*", "**", "Dup", "NonEx"]);

const CONSTELLATION_MAP = {
  And: "Andromeda",
  Ant: "Antlia",
  Aps: "Apus",
  Aqr: "Aquarius",
  Aql: "Aquila",
  Ara: "Ara",
  Ari: "Aries",
  Aur: "Auriga",
  Boo: "Bootes",
  Cae: "Caelum",
  Cam: "Camelopardalis",
  Cnc: "Cancer",
  CVn: "Canes Venatici",
  CMa: "Canis Major",
  CMi: "Canis Minor",
  Cap: "Capricornus",
  Car: "Carina",
  Cas: "Cassiopeia",
  Cen: "Centaurus",
  Cep: "Cepheus",
  Cet: "Cetus",
  Cha: "Chamaeleon",
  Cir: "Circinus",
  Col: "Columba",
  Com: "Coma Berenices",
  CrA: "Corona Australis",
  CrB: "Corona Borealis",
  Crv: "Corvus",
  Crt: "Crater",
  Cru: "Crux",
  Cyg: "Cygnus",
  Del: "Delphinus",
  Dor: "Dorado",
  Dra: "Draco",
  Equ: "Equuleus",
  Eri: "Eridanus",
  For: "Fornax",
  Gem: "Gemini",
  Gru: "Grus",
  Her: "Hercules",
  Hor: "Horologium",
  Hya: "Hydra",
  Hyi: "Hydrus",
  Ind: "Indus",
  Lac: "Lacerta",
  Leo: "Leo",
  LMi: "Leo Minor",
  Lep: "Lepus",
  Lib: "Libra",
  Lup: "Lupus",
  Lyn: "Lynx",
  Lyr: "Lyra",
  Men: "Mensa",
  Mic: "Microscopium",
  Mon: "Monoceros",
  Mus: "Musca",
  Nor: "Norma",
  Oct: "Octans",
  Oph: "Ophiuchus",
  Ori: "Orion",
  Pav: "Pavo",
  Peg: "Pegasus",
  Per: "Perseus",
  Phe: "Phoenix",
  Pic: "Pictor",
  Psc: "Pisces",
  PsA: "Piscis Austrinus",
  Pup: "Puppis",
  Pyx: "Pyxis",
  Ret: "Reticulum",
  Sge: "Sagitta",
  Sgr: "Sagittarius",
  Sco: "Scorpius",
  Scl: "Sculptor",
  Sct: "Scutum",
  Ser: "Serpens",
  Sex: "Sextans",
  Tau: "Taurus",
  Tel: "Telescopium",
  Tri: "Triangulum",
  TrA: "Triangulum Australe",
  Tuc: "Tucana",
  UMa: "Ursa Major",
  UMi: "Ursa Minor",
  Vel: "Vela",
  Vir: "Virgo",
  Vol: "Volans",
  Vul: "Vulpecula",
};

/** "05:41:00.88" → degrees */
function hmsToDeg(s) {
  const [h, m, sec] = s.split(":").map(Number);
  return (h + m / 60 + sec / 3600) * 15;
}
/** "-02:27:13.6" → degrees */
function dmsToDeg(s) {
  const sign = s.trim().startsWith("-") ? -1 : 1;
  const [d, m, sec] = s.replace(/^[+-]/, "").split(":").map(Number);
  return sign * (d + m / 60 + sec / 3600);
}
function num(s) {
  if (!s) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}
function trimNum(v) {
  return String(Math.round(v * 100) / 100);
}

const sourcePath =
  process.argv[2] || path.join(__dirname, "../src/lib/data/OpenNGC/NGC.csv");
const outputPath =
  process.argv[3] || path.join(__dirname, "../src/lib/ic-catalog-data.ts");
const lines = fs.readFileSync(sourcePath, "utf8").split("\n");
const header = lines[0].split(";");
const col = (name) => header.indexOf(name);
const [cName, cType, cRa, cDec, cConst, cMaj, cMin, cB, cV, cCommon] = [
  "Name",
  "Type",
  "RA",
  "Dec",
  "Const",
  "MajAx",
  "MinAx",
  "B-Mag",
  "V-Mag",
  "Common names",
].map(col);

const objects = [];
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const f = line.split(";");
  const m = f[cName].match(/^IC(\d+)$/);
  if (!m) continue;
  const typeCode = f[cType];
  if (SKIP_TYPES.has(typeCode)) continue;
  if (!f[cRa] || !f[cDec]) continue;
  const major = num(f[cMaj]);
  const minor = num(f[cMin]);
  let size = null;
  if (major && minor)
    size =
      major === minor ? trimNum(major) : `${trimNum(major)}×${trimNum(minor)}`;
  else if (major) size = trimNum(major);
  const common = (f[cCommon] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  objects.push({
    num: parseInt(m[1], 10),
    type: OBJECT_TYPE_MAP[typeCode] || typeCode,
    constellation: CONSTELLATION_MAP[f[cConst]] || f[cConst] || "—",
    ra: hmsToDeg(f[cRa]),
    dec: dmsToDeg(f[cDec]),
    magnitude: num(f[cV]) ?? num(f[cB]),
    size,
    commonName: common[0] || null,
  });
}
objects.sort((a, b) => a.num - b.num);
console.log(`Found ${objects.length} IC objects`);

let output = `/**
 * IC Catalog Data
 *
 * Generated from the OpenNGC database (IC rows) by scripts/generate-ic-catalog.cjs
 * Total objects: ${objects.length}
 *
 * This file is auto-generated. Do not edit manually.
 */

import type { NGCEntry } from "./ngc-catalog-data";

/** Same row shape as the NGC data; \`num\` is the IC number. */
export type ICEntry = NGCEntry;

export const IC_CATALOG_DATA: ICEntry[] = [
`;
for (const o of objects) {
  const parts = [
    `num:${o.num}`,
    `type:"${o.type}"`,
    `constellation:"${o.constellation}"`,
    `ra:${o.ra.toFixed(4)}`,
    `dec:${o.dec.toFixed(4)}`,
    `magnitude:${o.magnitude !== null ? o.magnitude : "null"}`,
    `size:${o.size !== null ? `"${o.size}"` : "null"}`,
    `commonName:${o.commonName !== null ? `"${o.commonName.replace(/"/g, '\\"')}"` : "null"}`,
  ];
  output += `  {${parts.join(",")}},\n`;
}
output += `];

export const IC_TOTAL_COUNT = ${objects.length};
`;
fs.writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
