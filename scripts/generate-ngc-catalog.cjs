#!/usr/bin/env node
/**
 * Generate NGC catalog TypeScript file from astronomical_objects_full.json
 */

const fs = require('fs');
const path = require('path');

// Object type mapping from codes to human-readable names
const OBJECT_TYPE_MAP = {
  'G': 'Galaxy',
  'DrkN': 'Dark Nebula',
  'BrtN': 'Bright Nebula',
  'OCl': 'Open Cluster',
  '*': 'Star',
  '**': 'Double Star',
  'GPair': 'Galaxy Pair',
  'GCl': 'Globular Cluster',
  'PN': 'Planetary Nebula',
  'Neb': 'Nebula',
  'HII': 'HII Region',
  'Cl+N': 'Cluster+Nebula',
  '*Ass': 'Stellar Association',
  'RfN': 'Reflection Nebula',
  'GTrpl': 'Galaxy Triplet',
  'GGroup': 'Galaxy Group',
  'SNR': 'Supernova Remnant',
  'EmN': 'Emission Nebula',
  'Nova': 'Nova',
  'WR*': 'Wolf-Rayet Star',
  'Star': 'Star',
  'Other': 'Other',
};

// Constellation abbreviation to full name mapping
const CONSTELLATION_MAP = {
  'And': 'Andromeda',
  'Ant': 'Antlia',
  'Aps': 'Apus',
  'Aqr': 'Aquarius',
  'Aql': 'Aquila',
  'Ara': 'Ara',
  'Ari': 'Aries',
  'Aur': 'Auriga',
  'Boo': 'Bootes',
  'Cae': 'Caelum',
  'Cam': 'Camelopardalis',
  'Cnc': 'Cancer',
  'CVn': 'Canes Venatici',
  'CMa': 'Canis Major',
  'CMi': 'Canis Minor',
  'Cap': 'Capricornus',
  'Car': 'Carina',
  'Cas': 'Cassiopeia',
  'Cen': 'Centaurus',
  'Cep': 'Cepheus',
  'Cet': 'Cetus',
  'Cha': 'Chamaeleon',
  'Cir': 'Circinus',
  'Col': 'Columba',
  'Com': 'Coma Berenices',
  'CrA': 'Corona Australis',
  'CrB': 'Corona Borealis',
  'Crv': 'Corvus',
  'Crt': 'Crater',
  'Cru': 'Crux',
  'Cyg': 'Cygnus',
  'Del': 'Delphinus',
  'Dor': 'Dorado',
  'Dra': 'Draco',
  'Equ': 'Equuleus',
  'Eri': 'Eridanus',
  'For': 'Fornax',
  'Gem': 'Gemini',
  'Gru': 'Grus',
  'Her': 'Hercules',
  'Hor': 'Horologium',
  'Hya': 'Hydra',
  'Hyi': 'Hydrus',
  'Ind': 'Indus',
  'Lac': 'Lacerta',
  'Leo': 'Leo',
  'LMi': 'Leo Minor',
  'Lep': 'Lepus',
  'Lib': 'Libra',
  'Lup': 'Lupus',
  'Lyn': 'Lynx',
  'Lyr': 'Lyra',
  'Men': 'Mensa',
  'Mic': 'Microscopium',
  'Mon': 'Monoceros',
  'Mus': 'Musca',
  'Nor': 'Norma',
  'Oct': 'Octans',
  'Oph': 'Ophiuchus',
  'Ori': 'Orion',
  'Pav': 'Pavo',
  'Peg': 'Pegasus',
  'Per': 'Perseus',
  'Phe': 'Phoenix',
  'Pic': 'Pictor',
  'Psc': 'Pisces',
  'PsA': 'Piscis Austrinus',
  'Pup': 'Puppis',
  'Pyx': 'Pyxis',
  'Ret': 'Reticulum',
  'Sge': 'Sagitta',
  'Sgr': 'Sagittarius',
  'Sco': 'Scorpius',
  'Scl': 'Sculptor',
  'Sct': 'Scutum',
  'Ser': 'Serpens',
  'Sex': 'Sextans',
  'Tau': 'Taurus',
  'Tel': 'Telescopium',
  'Tri': 'Triangulum',
  'TrA': 'Triangulum Australe',
  'Tuc': 'Tucana',
  'UMa': 'Ursa Major',
  'UMi': 'Ursa Minor',
  'Vel': 'Vela',
  'Vir': 'Virgo',
  'Vol': 'Volans',
  'Vul': 'Vulpecula',
};

// Read the source file
const sourcePath = path.join(__dirname, '../src/lib/data/astronomical_objects_full.json');
const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

// Extract NGC objects
const ngcObjects = [];
for (const obj of data.objects) {
  const ngcId = obj.catalog_ids?.ngc;
  if (!ngcId) continue;

  // Extract NGC number from ID like "NGC0001" -> 1
  const match = ngcId.match(/NGC(\d+)/);
  if (!match) continue;
  const num = parseInt(match[1], 10);

  // Get readable type
  const typeCode = obj.object_type || 'Other';
  const type = OBJECT_TYPE_MAP[typeCode] || typeCode;

  // Get constellation
  const constAbbr = obj.coordinates?.constellation || '';
  const constellation = CONSTELLATION_MAP[constAbbr] || constAbbr || '—';

  // Get coordinates
  const ra = obj.coordinates?.ra_j2000?.decimal || 0;
  const dec = obj.coordinates?.dec_j2000?.decimal || 0;

  // Get magnitude
  const magnitude = obj.magnitudes?.v || obj.magnitudes?.b || null;

  // Get size (format as string)
  const major = obj.physical_properties?.size?.major_axis_arcmin;
  const minor = obj.physical_properties?.size?.minor_axis_arcmin;
  let size = null;
  if (major && minor) {
    size = major === minor ? `${major}` : `${major}×${minor}`;
  } else if (major) {
    size = `${major}`;
  }

  // Get common names
  const commonNames = obj.names?.common || [];
  const commonName = commonNames.length > 0 ? commonNames[0] : null;

  ngcObjects.push({
    num,
    type,
    constellation,
    ra,
    dec,
    magnitude,
    size,
    commonName,
  });
}

// Sort by NGC number
ngcObjects.sort((a, b) => a.num - b.num);

console.log(`Found ${ngcObjects.length} NGC objects`);

// Generate TypeScript file
const outputPath = path.join(__dirname, '../src/lib/ngc-catalog-data.ts');

let output = `/**
 * NGC Catalog Data
 *
 * Generated from OpenNGC Database
 * Total objects: ${ngcObjects.length}
 *
 * This file is auto-generated. Do not edit manually.
 */

export interface NGCEntry {
  num: number;
  type: string;
  constellation: string;
  ra: number;
  dec: number;
  magnitude: number | null;
  size: string | null;
  commonName: string | null;
}

export const NGC_CATALOG_DATA: NGCEntry[] = [
`;

for (const obj of ngcObjects) {
  const parts = [
    `num:${obj.num}`,
    `type:"${obj.type}"`,
    `constellation:"${obj.constellation}"`,
    `ra:${obj.ra.toFixed(4)}`,
    `dec:${obj.dec.toFixed(4)}`,
    `magnitude:${obj.magnitude !== null ? obj.magnitude : 'null'}`,
    `size:${obj.size !== null ? `"${obj.size}"` : 'null'}`,
    `commonName:${obj.commonName !== null ? `"${obj.commonName.replace(/"/g, '\\"')}"` : 'null'}`,
  ];
  output += `  {${parts.join(',')}},\n`;
}

output += `];

/**
 * Get NGC total count
 */
export const NGC_TOTAL_COUNT = ${ngcObjects.length};
`;

fs.writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
