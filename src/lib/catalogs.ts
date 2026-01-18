/**
 * Astronomical Catalog Definitions
 *
 * Contains Messier and Caldwell catalog objects with metadata.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  commonName?: string;
  type: string;
  constellation: string;
  ra: number; // degrees
  dec: number; // degrees
  magnitude?: number;
  size?: string; // arcmin
  aliases?: string[]; // NGC, IC numbers etc.
}

export interface CatalogDefinition {
  id: string;
  name: string;
  description: string;
  objects: CatalogEntry[];
}

/**
 * Messier Catalog - 110 objects
 */
export const MESSIER_CATALOG: CatalogEntry[] = [
  { id: "M1", name: "M 1", commonName: "Crab Nebula", type: "Supernova Remnant", constellation: "Taurus", ra: 83.6331, dec: 22.0145, magnitude: 8.4, size: "6×4", aliases: ["NGC 1952"] },
  { id: "M2", name: "M 2", type: "Globular Cluster", constellation: "Aquarius", ra: 323.3625, dec: -0.8232, magnitude: 6.5, size: "16", aliases: ["NGC 7089"] },
  { id: "M3", name: "M 3", type: "Globular Cluster", constellation: "Canes Venatici", ra: 205.5484, dec: 28.3772, magnitude: 6.2, size: "18", aliases: ["NGC 5272"] },
  { id: "M4", name: "M 4", type: "Globular Cluster", constellation: "Scorpius", ra: 245.8968, dec: -26.5255, magnitude: 5.6, size: "36", aliases: ["NGC 6121"] },
  { id: "M5", name: "M 5", type: "Globular Cluster", constellation: "Serpens", ra: 229.6384, dec: 2.0810, magnitude: 5.6, size: "23", aliases: ["NGC 5904"] },
  { id: "M6", name: "M 6", commonName: "Butterfly Cluster", type: "Open Cluster", constellation: "Scorpius", ra: 265.0833, dec: -32.2167, magnitude: 4.2, size: "25", aliases: ["NGC 6405"] },
  { id: "M7", name: "M 7", commonName: "Ptolemy's Cluster", type: "Open Cluster", constellation: "Scorpius", ra: 268.4667, dec: -34.7833, magnitude: 3.3, size: "80", aliases: ["NGC 6475"] },
  { id: "M8", name: "M 8", commonName: "Lagoon Nebula", type: "Emission Nebula", constellation: "Sagittarius", ra: 270.9208, dec: -24.3833, magnitude: 6.0, size: "90×40", aliases: ["NGC 6523"] },
  { id: "M9", name: "M 9", type: "Globular Cluster", constellation: "Ophiuchus", ra: 259.7981, dec: -18.5161, magnitude: 7.7, size: "12", aliases: ["NGC 6333"] },
  { id: "M10", name: "M 10", type: "Globular Cluster", constellation: "Ophiuchus", ra: 254.2877, dec: -4.1003, magnitude: 6.6, size: "20", aliases: ["NGC 6254"] },
  { id: "M11", name: "M 11", commonName: "Wild Duck Cluster", type: "Open Cluster", constellation: "Scutum", ra: 282.7667, dec: -6.2667, magnitude: 5.8, size: "14", aliases: ["NGC 6705"] },
  { id: "M12", name: "M 12", type: "Globular Cluster", constellation: "Ophiuchus", ra: 251.8091, dec: -1.9486, magnitude: 6.7, size: "16", aliases: ["NGC 6218"] },
  { id: "M13", name: "M 13", commonName: "Hercules Globular Cluster", type: "Globular Cluster", constellation: "Hercules", ra: 250.4217, dec: 36.4614, magnitude: 5.8, size: "20", aliases: ["NGC 6205"] },
  { id: "M14", name: "M 14", type: "Globular Cluster", constellation: "Ophiuchus", ra: 264.4000, dec: -3.2458, magnitude: 7.6, size: "11", aliases: ["NGC 6402"] },
  { id: "M15", name: "M 15", type: "Globular Cluster", constellation: "Pegasus", ra: 322.4930, dec: 12.1670, magnitude: 6.2, size: "18", aliases: ["NGC 7078"] },
  { id: "M16", name: "M 16", commonName: "Eagle Nebula", type: "Emission Nebula", constellation: "Serpens", ra: 274.7000, dec: -13.8000, magnitude: 6.0, size: "7", aliases: ["NGC 6611"] },
  { id: "M17", name: "M 17", commonName: "Omega Nebula", type: "Emission Nebula", constellation: "Sagittarius", ra: 275.1958, dec: -16.1833, magnitude: 6.0, size: "11", aliases: ["NGC 6618"] },
  { id: "M18", name: "M 18", type: "Open Cluster", constellation: "Sagittarius", ra: 274.3500, dec: -17.1333, magnitude: 6.9, size: "9", aliases: ["NGC 6613"] },
  { id: "M19", name: "M 19", type: "Globular Cluster", constellation: "Ophiuchus", ra: 255.6570, dec: -26.2681, magnitude: 6.8, size: "17", aliases: ["NGC 6273"] },
  { id: "M20", name: "M 20", commonName: "Trifid Nebula", type: "Emission Nebula", constellation: "Sagittarius", ra: 270.6208, dec: -23.0333, magnitude: 6.3, size: "28", aliases: ["NGC 6514"] },
  { id: "M21", name: "M 21", type: "Open Cluster", constellation: "Sagittarius", ra: 270.9833, dec: -22.5000, magnitude: 5.9, size: "13", aliases: ["NGC 6531"] },
  { id: "M22", name: "M 22", type: "Globular Cluster", constellation: "Sagittarius", ra: 279.0998, dec: -23.9050, magnitude: 5.1, size: "32", aliases: ["NGC 6656"] },
  { id: "M23", name: "M 23", type: "Open Cluster", constellation: "Sagittarius", ra: 269.2667, dec: -19.0167, magnitude: 5.5, size: "27", aliases: ["NGC 6494"] },
  { id: "M24", name: "M 24", commonName: "Small Sagittarius Star Cloud", type: "Star Cloud", constellation: "Sagittarius", ra: 274.5333, dec: -18.5167, magnitude: 4.6, size: "90", aliases: ["IC 4715"] },
  { id: "M25", name: "M 25", type: "Open Cluster", constellation: "Sagittarius", ra: 277.9167, dec: -19.1167, magnitude: 4.6, size: "40", aliases: ["IC 4725"] },
  { id: "M26", name: "M 26", type: "Open Cluster", constellation: "Scutum", ra: 281.3167, dec: -9.3833, magnitude: 8.0, size: "15", aliases: ["NGC 6694"] },
  { id: "M27", name: "M 27", commonName: "Dumbbell Nebula", type: "Planetary Nebula", constellation: "Vulpecula", ra: 299.9017, dec: 22.7211, magnitude: 7.4, size: "8×5.7", aliases: ["NGC 6853"] },
  { id: "M28", name: "M 28", type: "Globular Cluster", constellation: "Sagittarius", ra: 276.1369, dec: -24.8699, magnitude: 6.8, size: "11", aliases: ["NGC 6626"] },
  { id: "M29", name: "M 29", type: "Open Cluster", constellation: "Cygnus", ra: 305.9667, dec: 38.5333, magnitude: 6.6, size: "7", aliases: ["NGC 6913"] },
  { id: "M30", name: "M 30", type: "Globular Cluster", constellation: "Capricornus", ra: 325.0922, dec: -23.1799, magnitude: 7.2, size: "12", aliases: ["NGC 7099"] },
  { id: "M31", name: "M 31", commonName: "Andromeda Galaxy", type: "Spiral Galaxy", constellation: "Andromeda", ra: 10.6847, dec: 41.2690, magnitude: 3.4, size: "178×63", aliases: ["NGC 224"] },
  { id: "M32", name: "M 32", type: "Elliptical Galaxy", constellation: "Andromeda", ra: 10.6742, dec: 40.8652, magnitude: 8.1, size: "8×6", aliases: ["NGC 221"] },
  { id: "M33", name: "M 33", commonName: "Triangulum Galaxy", type: "Spiral Galaxy", constellation: "Triangulum", ra: 23.4621, dec: 30.6603, magnitude: 5.7, size: "73×45", aliases: ["NGC 598"] },
  { id: "M34", name: "M 34", type: "Open Cluster", constellation: "Perseus", ra: 40.5167, dec: 42.7833, magnitude: 5.2, size: "35", aliases: ["NGC 1039"] },
  { id: "M35", name: "M 35", type: "Open Cluster", constellation: "Gemini", ra: 92.2500, dec: 24.3333, magnitude: 5.1, size: "28", aliases: ["NGC 2168"] },
  { id: "M36", name: "M 36", type: "Open Cluster", constellation: "Auriga", ra: 84.0833, dec: 34.1333, magnitude: 6.0, size: "12", aliases: ["NGC 1960"] },
  { id: "M37", name: "M 37", type: "Open Cluster", constellation: "Auriga", ra: 88.0667, dec: 32.5500, magnitude: 5.6, size: "24", aliases: ["NGC 2099"] },
  { id: "M38", name: "M 38", type: "Open Cluster", constellation: "Auriga", ra: 82.1667, dec: 35.8500, magnitude: 6.4, size: "21", aliases: ["NGC 1912"] },
  { id: "M39", name: "M 39", type: "Open Cluster", constellation: "Cygnus", ra: 322.2000, dec: 48.4500, magnitude: 4.6, size: "32", aliases: ["NGC 7092"] },
  { id: "M40", name: "M 40", commonName: "Winnecke 4", type: "Double Star", constellation: "Ursa Major", ra: 185.5500, dec: 58.0833, magnitude: 8.4, size: "1" },
  { id: "M41", name: "M 41", type: "Open Cluster", constellation: "Canis Major", ra: 101.5000, dec: -20.7500, magnitude: 4.5, size: "38", aliases: ["NGC 2287"] },
  { id: "M42", name: "M 42", commonName: "Orion Nebula", type: "Emission Nebula", constellation: "Orion", ra: 83.8208, dec: -5.3908, magnitude: 4.0, size: "85×60", aliases: ["NGC 1976"] },
  { id: "M43", name: "M 43", commonName: "De Mairan's Nebula", type: "Emission Nebula", constellation: "Orion", ra: 83.8833, dec: -5.2667, magnitude: 9.0, size: "20×15", aliases: ["NGC 1982"] },
  { id: "M44", name: "M 44", commonName: "Beehive Cluster", type: "Open Cluster", constellation: "Cancer", ra: 130.0917, dec: 19.6211, magnitude: 3.1, size: "95", aliases: ["NGC 2632"] },
  { id: "M45", name: "M 45", commonName: "Pleiades", type: "Open Cluster", constellation: "Taurus", ra: 56.6000, dec: 24.1167, magnitude: 1.6, size: "110" },
  { id: "M46", name: "M 46", type: "Open Cluster", constellation: "Puppis", ra: 115.4500, dec: -14.8167, magnitude: 6.1, size: "27", aliases: ["NGC 2437"] },
  { id: "M47", name: "M 47", type: "Open Cluster", constellation: "Puppis", ra: 114.1500, dec: -14.5000, magnitude: 4.4, size: "30", aliases: ["NGC 2422"] },
  { id: "M48", name: "M 48", type: "Open Cluster", constellation: "Hydra", ra: 123.4167, dec: -5.8000, magnitude: 5.8, size: "54", aliases: ["NGC 2548"] },
  { id: "M49", name: "M 49", type: "Elliptical Galaxy", constellation: "Virgo", ra: 187.4449, dec: 8.0004, magnitude: 8.4, size: "10×8", aliases: ["NGC 4472"] },
  { id: "M50", name: "M 50", type: "Open Cluster", constellation: "Monoceros", ra: 105.6833, dec: -8.3667, magnitude: 5.9, size: "16", aliases: ["NGC 2323"] },
  { id: "M51", name: "M 51", commonName: "Whirlpool Galaxy", type: "Spiral Galaxy", constellation: "Canes Venatici", ra: 202.4696, dec: 47.1952, magnitude: 8.4, size: "11×7", aliases: ["NGC 5194"] },
  { id: "M52", name: "M 52", type: "Open Cluster", constellation: "Cassiopeia", ra: 351.2000, dec: 61.5833, magnitude: 6.9, size: "13", aliases: ["NGC 7654"] },
  { id: "M53", name: "M 53", type: "Globular Cluster", constellation: "Coma Berenices", ra: 198.2302, dec: 18.1681, magnitude: 7.6, size: "13", aliases: ["NGC 5024"] },
  { id: "M54", name: "M 54", type: "Globular Cluster", constellation: "Sagittarius", ra: 283.7636, dec: -30.4781, magnitude: 7.6, size: "12", aliases: ["NGC 6715"] },
  { id: "M55", name: "M 55", type: "Globular Cluster", constellation: "Sagittarius", ra: 294.9988, dec: -30.9647, magnitude: 6.3, size: "19", aliases: ["NGC 6809"] },
  { id: "M56", name: "M 56", type: "Globular Cluster", constellation: "Lyra", ra: 289.1481, dec: 30.1837, magnitude: 8.3, size: "9", aliases: ["NGC 6779"] },
  { id: "M57", name: "M 57", commonName: "Ring Nebula", type: "Planetary Nebula", constellation: "Lyra", ra: 283.3962, dec: 33.0286, magnitude: 8.8, size: "1.4×1", aliases: ["NGC 6720"] },
  { id: "M58", name: "M 58", type: "Barred Spiral Galaxy", constellation: "Virgo", ra: 189.4313, dec: 11.8181, magnitude: 9.7, size: "6×5", aliases: ["NGC 4579"] },
  { id: "M59", name: "M 59", type: "Elliptical Galaxy", constellation: "Virgo", ra: 190.5092, dec: 11.6467, magnitude: 9.6, size: "5×4", aliases: ["NGC 4621"] },
  { id: "M60", name: "M 60", type: "Elliptical Galaxy", constellation: "Virgo", ra: 190.9167, dec: 11.5528, magnitude: 8.8, size: "7×6", aliases: ["NGC 4649"] },
  { id: "M61", name: "M 61", type: "Spiral Galaxy", constellation: "Virgo", ra: 185.4792, dec: 4.4739, magnitude: 9.7, size: "6×5", aliases: ["NGC 4303"] },
  { id: "M62", name: "M 62", type: "Globular Cluster", constellation: "Ophiuchus", ra: 255.3034, dec: -30.1130, magnitude: 6.5, size: "15", aliases: ["NGC 6266"] },
  { id: "M63", name: "M 63", commonName: "Sunflower Galaxy", type: "Spiral Galaxy", constellation: "Canes Venatici", ra: 198.9554, dec: 42.0293, magnitude: 8.6, size: "13×8", aliases: ["NGC 5055"] },
  { id: "M64", name: "M 64", commonName: "Black Eye Galaxy", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 194.1824, dec: 21.6826, magnitude: 8.5, size: "10×5", aliases: ["NGC 4826"] },
  { id: "M65", name: "M 65", type: "Spiral Galaxy", constellation: "Leo", ra: 169.7330, dec: 13.0922, magnitude: 9.3, size: "10×3", aliases: ["NGC 3623"] },
  { id: "M66", name: "M 66", type: "Spiral Galaxy", constellation: "Leo", ra: 170.0628, dec: 12.9914, magnitude: 8.9, size: "9×4", aliases: ["NGC 3627"] },
  { id: "M67", name: "M 67", type: "Open Cluster", constellation: "Cancer", ra: 132.8250, dec: 11.8167, magnitude: 6.9, size: "30", aliases: ["NGC 2682"] },
  { id: "M68", name: "M 68", type: "Globular Cluster", constellation: "Hydra", ra: 189.8667, dec: -26.7444, magnitude: 7.8, size: "11", aliases: ["NGC 4590"] },
  { id: "M69", name: "M 69", type: "Globular Cluster", constellation: "Sagittarius", ra: 279.0992, dec: -32.3481, magnitude: 7.6, size: "9", aliases: ["NGC 6637"] },
  { id: "M70", name: "M 70", type: "Globular Cluster", constellation: "Sagittarius", ra: 280.8024, dec: -32.2922, magnitude: 7.9, size: "8", aliases: ["NGC 6681"] },
  { id: "M71", name: "M 71", type: "Globular Cluster", constellation: "Sagitta", ra: 298.4437, dec: 18.7792, magnitude: 8.2, size: "7", aliases: ["NGC 6838"] },
  { id: "M72", name: "M 72", type: "Globular Cluster", constellation: "Aquarius", ra: 313.3650, dec: -12.5372, magnitude: 9.3, size: "6", aliases: ["NGC 6981"] },
  { id: "M73", name: "M 73", type: "Asterism", constellation: "Aquarius", ra: 314.7500, dec: -12.6333, magnitude: 9.0, size: "3", aliases: ["NGC 6994"] },
  { id: "M74", name: "M 74", commonName: "Phantom Galaxy", type: "Spiral Galaxy", constellation: "Pisces", ra: 24.1742, dec: 15.7836, magnitude: 9.4, size: "11×10", aliases: ["NGC 628"] },
  { id: "M75", name: "M 75", type: "Globular Cluster", constellation: "Sagittarius", ra: 301.5201, dec: -21.9214, magnitude: 8.5, size: "6", aliases: ["NGC 6864"] },
  { id: "M76", name: "M 76", commonName: "Little Dumbbell Nebula", type: "Planetary Nebula", constellation: "Perseus", ra: 25.5817, dec: 51.5756, magnitude: 10.1, size: "2.7×1.8", aliases: ["NGC 650", "NGC 651"] },
  { id: "M77", name: "M 77", commonName: "Cetus A", type: "Spiral Galaxy", constellation: "Cetus", ra: 40.6696, dec: -0.0133, magnitude: 8.9, size: "7×6", aliases: ["NGC 1068"] },
  { id: "M78", name: "M 78", type: "Reflection Nebula", constellation: "Orion", ra: 86.6500, dec: 0.0833, magnitude: 8.3, size: "8×6", aliases: ["NGC 2068"] },
  { id: "M79", name: "M 79", type: "Globular Cluster", constellation: "Lepus", ra: 81.0463, dec: -24.5247, magnitude: 7.7, size: "10", aliases: ["NGC 1904"] },
  { id: "M80", name: "M 80", type: "Globular Cluster", constellation: "Scorpius", ra: 244.2600, dec: -22.9756, magnitude: 7.3, size: "10", aliases: ["NGC 6093"] },
  { id: "M81", name: "M 81", commonName: "Bode's Galaxy", type: "Spiral Galaxy", constellation: "Ursa Major", ra: 148.8882, dec: 69.0654, magnitude: 6.9, size: "27×14", aliases: ["NGC 3031"] },
  { id: "M82", name: "M 82", commonName: "Cigar Galaxy", type: "Starburst Galaxy", constellation: "Ursa Major", ra: 148.9681, dec: 69.6797, magnitude: 8.4, size: "11×5", aliases: ["NGC 3034"] },
  { id: "M83", name: "M 83", commonName: "Southern Pinwheel Galaxy", type: "Barred Spiral Galaxy", constellation: "Hydra", ra: 204.2538, dec: -29.8657, magnitude: 7.5, size: "13×12", aliases: ["NGC 5236"] },
  { id: "M84", name: "M 84", type: "Lenticular Galaxy", constellation: "Virgo", ra: 186.2654, dec: 12.8870, magnitude: 9.1, size: "7×6", aliases: ["NGC 4374"] },
  { id: "M85", name: "M 85", type: "Lenticular Galaxy", constellation: "Coma Berenices", ra: 186.3508, dec: 18.1911, magnitude: 9.1, size: "7×5", aliases: ["NGC 4382"] },
  { id: "M86", name: "M 86", type: "Lenticular Galaxy", constellation: "Virgo", ra: 186.5492, dec: 12.9467, magnitude: 8.9, size: "9×6", aliases: ["NGC 4406"] },
  { id: "M87", name: "M 87", commonName: "Virgo A", type: "Elliptical Galaxy", constellation: "Virgo", ra: 187.7058, dec: 12.3911, magnitude: 8.6, size: "8×7", aliases: ["NGC 4486"] },
  { id: "M88", name: "M 88", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 187.9967, dec: 14.4203, magnitude: 9.6, size: "7×4", aliases: ["NGC 4501"] },
  { id: "M89", name: "M 89", type: "Elliptical Galaxy", constellation: "Virgo", ra: 188.9158, dec: 12.5564, magnitude: 9.8, size: "5×5", aliases: ["NGC 4552"] },
  { id: "M90", name: "M 90", type: "Spiral Galaxy", constellation: "Virgo", ra: 189.2094, dec: 13.1631, magnitude: 9.5, size: "10×5", aliases: ["NGC 4569"] },
  { id: "M91", name: "M 91", type: "Barred Spiral Galaxy", constellation: "Coma Berenices", ra: 188.8604, dec: 14.4964, magnitude: 10.2, size: "6×5", aliases: ["NGC 4548"] },
  { id: "M92", name: "M 92", type: "Globular Cluster", constellation: "Hercules", ra: 259.2808, dec: 43.1364, magnitude: 6.4, size: "14", aliases: ["NGC 6341"] },
  { id: "M93", name: "M 93", type: "Open Cluster", constellation: "Puppis", ra: 116.1333, dec: -23.8667, magnitude: 6.2, size: "22", aliases: ["NGC 2447"] },
  { id: "M94", name: "M 94", type: "Spiral Galaxy", constellation: "Canes Venatici", ra: 192.7213, dec: 41.1203, magnitude: 8.2, size: "14×12", aliases: ["NGC 4736"] },
  { id: "M95", name: "M 95", type: "Barred Spiral Galaxy", constellation: "Leo", ra: 160.9900, dec: 11.7039, magnitude: 9.7, size: "7×5", aliases: ["NGC 3351"] },
  { id: "M96", name: "M 96", type: "Spiral Galaxy", constellation: "Leo", ra: 161.6904, dec: 11.8197, magnitude: 9.2, size: "7×5", aliases: ["NGC 3368"] },
  { id: "M97", name: "M 97", commonName: "Owl Nebula", type: "Planetary Nebula", constellation: "Ursa Major", ra: 168.6986, dec: 55.0192, magnitude: 9.9, size: "3.4×3.3", aliases: ["NGC 3587"] },
  { id: "M98", name: "M 98", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 183.4512, dec: 14.9003, magnitude: 10.1, size: "10×3", aliases: ["NGC 4192"] },
  { id: "M99", name: "M 99", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 184.7067, dec: 14.4161, magnitude: 9.9, size: "6×5", aliases: ["NGC 4254"] },
  { id: "M100", name: "M 100", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 185.7288, dec: 15.8222, magnitude: 9.3, size: "7×6", aliases: ["NGC 4321"] },
  { id: "M101", name: "M 101", commonName: "Pinwheel Galaxy", type: "Spiral Galaxy", constellation: "Ursa Major", ra: 210.8024, dec: 54.3492, magnitude: 7.9, size: "29×27", aliases: ["NGC 5457"] },
  { id: "M102", name: "M 102", commonName: "Spindle Galaxy", type: "Lenticular Galaxy", constellation: "Draco", ra: 226.6229, dec: 55.7636, magnitude: 9.9, size: "6×3", aliases: ["NGC 5866"] },
  { id: "M103", name: "M 103", type: "Open Cluster", constellation: "Cassiopeia", ra: 23.3417, dec: 60.7000, magnitude: 7.4, size: "6", aliases: ["NGC 581"] },
  { id: "M104", name: "M 104", commonName: "Sombrero Galaxy", type: "Spiral Galaxy", constellation: "Virgo", ra: 189.9977, dec: -11.6231, magnitude: 8.0, size: "9×4", aliases: ["NGC 4594"] },
  { id: "M105", name: "M 105", type: "Elliptical Galaxy", constellation: "Leo", ra: 161.9567, dec: 12.5817, magnitude: 9.3, size: "5×5", aliases: ["NGC 3379"] },
  { id: "M106", name: "M 106", type: "Spiral Galaxy", constellation: "Canes Venatici", ra: 184.7396, dec: 47.3039, magnitude: 8.4, size: "19×8", aliases: ["NGC 4258"] },
  { id: "M107", name: "M 107", type: "Globular Cluster", constellation: "Ophiuchus", ra: 248.1326, dec: -13.0536, magnitude: 7.9, size: "13", aliases: ["NGC 6171"] },
  { id: "M108", name: "M 108", commonName: "Surfboard Galaxy", type: "Barred Spiral Galaxy", constellation: "Ursa Major", ra: 167.8792, dec: 55.6744, magnitude: 10.0, size: "8×2", aliases: ["NGC 3556"] },
  { id: "M109", name: "M 109", type: "Barred Spiral Galaxy", constellation: "Ursa Major", ra: 179.3996, dec: 53.3744, magnitude: 9.8, size: "8×5", aliases: ["NGC 3992"] },
  { id: "M110", name: "M 110", type: "Elliptical Galaxy", constellation: "Andromeda", ra: 10.0917, dec: 41.6853, magnitude: 8.5, size: "22×11", aliases: ["NGC 205"] },
];

/**
 * Caldwell Catalog - 109 objects
 */
export const CALDWELL_CATALOG: CatalogEntry[] = [
  { id: "C1", name: "C 1", commonName: "Bow-Tie Nebula", type: "Planetary Nebula", constellation: "Cepheus", ra: 350.3333, dec: 80.4667, magnitude: 8.1, size: "22×15", aliases: ["NGC 188"] },
  { id: "C2", name: "C 2", type: "Planetary Nebula", constellation: "Cepheus", ra: 358.0, dec: 72.5167, magnitude: 10.9, size: "10", aliases: ["NGC 40"] },
  { id: "C3", name: "C 3", type: "Galaxy", constellation: "Draco", ra: 194.4583, dec: 65.0333, magnitude: 9.5, size: "19×5", aliases: ["NGC 4236"] },
  { id: "C4", name: "C 4", commonName: "Iris Nebula", type: "Reflection Nebula", constellation: "Cepheus", ra: 315.3167, dec: 68.1667, magnitude: 7.0, size: "18", aliases: ["NGC 7023"] },
  { id: "C5", name: "C 5", commonName: "IC 342", type: "Spiral Galaxy", constellation: "Camelopardalis", ra: 56.7125, dec: 68.0978, magnitude: 9.1, size: "21×21", aliases: ["IC 342"] },
  { id: "C6", name: "C 6", commonName: "Cat's Eye Nebula", type: "Planetary Nebula", constellation: "Draco", ra: 269.6339, dec: 66.6328, magnitude: 8.1, size: "0.4", aliases: ["NGC 6543"] },
  { id: "C7", name: "C 7", type: "Galaxy", constellation: "Camelopardalis", ra: 44.0417, dec: 68.9000, magnitude: 11.6, size: "7×4", aliases: ["NGC 2403"] },
  { id: "C8", name: "C 8", type: "Open Cluster", constellation: "Cassiopeia", ra: 36.9583, dec: 63.3000, magnitude: 5.2, size: "45", aliases: ["NGC 559"] },
  { id: "C9", name: "C 9", commonName: "Cave Nebula", type: "Emission Nebula", constellation: "Cepheus", ra: 343.0667, dec: 62.5167, magnitude: 7.7, size: "50×30", aliases: ["Sh2-155"] },
  { id: "C10", name: "C 10", type: "Open Cluster", constellation: "Cassiopeia", ra: 7.3083, dec: 61.2667, magnitude: 7.1, size: "5", aliases: ["NGC 663"] },
  { id: "C11", name: "C 11", commonName: "Bubble Nebula", type: "Emission Nebula", constellation: "Cassiopeia", ra: 350.2042, dec: 61.2000, magnitude: 11.0, size: "15×8", aliases: ["NGC 7635"] },
  { id: "C12", name: "C 12", type: "Galaxy", constellation: "Cepheus", ra: 14.5167, dec: 59.8333, magnitude: 9.2, size: "10×9", aliases: ["NGC 6946"] },
  { id: "C13", name: "C 13", commonName: "Owl Cluster", type: "Open Cluster", constellation: "Cassiopeia", ra: 19.8833, dec: 58.2000, magnitude: 6.4, size: "12", aliases: ["NGC 457"] },
  { id: "C14", name: "C 14", commonName: "Double Cluster", type: "Open Cluster", constellation: "Perseus", ra: 34.7500, dec: 57.1333, magnitude: 3.3, size: "60", aliases: ["NGC 869", "NGC 884"] },
  { id: "C15", name: "C 15", commonName: "Blinking Planetary", type: "Planetary Nebula", constellation: "Cygnus", ra: 313.8333, dec: 50.5250, magnitude: 8.8, size: "2", aliases: ["NGC 6826"] },
  { id: "C16", name: "C 16", type: "Open Cluster", constellation: "Lacerta", ra: 351.5917, dec: 49.8833, magnitude: 5.8, size: "15", aliases: ["NGC 7243"] },
  { id: "C17", name: "C 17", type: "Open Cluster", constellation: "Cygnus", ra: 303.2083, dec: 47.7167, magnitude: 5.7, size: "10", aliases: ["NGC 6633"] },
  { id: "C18", name: "C 18", type: "Open Cluster", constellation: "Vulpecula", ra: 307.0167, dec: 43.7833, magnitude: 6.2, size: "10", aliases: ["NGC 185"] },
  { id: "C19", name: "C 19", commonName: "Cocoon Nebula", type: "Emission Nebula", constellation: "Cygnus", ra: 328.3958, dec: 47.2694, magnitude: 7.2, size: "10", aliases: ["IC 5146"] },
  { id: "C20", name: "C 20", commonName: "North America Nebula", type: "Emission Nebula", constellation: "Cygnus", ra: 314.7500, dec: 44.5333, magnitude: 4.0, size: "120×100", aliases: ["NGC 7000"] },
  { id: "C21", name: "C 21", type: "Open Cluster", constellation: "Cepheus", ra: 342.6167, dec: 58.3500, magnitude: 7.2, size: "5", aliases: ["NGC 4449"] },
  { id: "C22", name: "C 22", commonName: "Blue Snowball", type: "Planetary Nebula", constellation: "Andromeda", ra: 17.5792, dec: 42.5356, magnitude: 8.3, size: "0.5", aliases: ["NGC 7662"] },
  { id: "C23", name: "C 23", type: "Galaxy", constellation: "Andromeda", ra: 9.2750, dec: 42.3500, magnitude: 10.0, size: "8×4", aliases: ["NGC 891"] },
  { id: "C24", name: "C 24", commonName: "Perseus A Cluster", type: "Galaxy Cluster", constellation: "Perseus", ra: 49.9500, dec: 41.5167, magnitude: 12.6, size: "2.5", aliases: ["NGC 1275"] },
  { id: "C25", name: "C 25", type: "Galaxy", constellation: "Triangulum", ra: 24.2333, dec: 37.0500, magnitude: 12.6, size: "4×3", aliases: ["NGC 2419"] },
  { id: "C26", name: "C 26", type: "Open Cluster", constellation: "Canes Venatici", ra: 186.7417, dec: 39.3500, magnitude: 12.5, size: "3", aliases: ["NGC 4244"] },
  { id: "C27", name: "C 27", commonName: "Crescent Nebula", type: "Emission Nebula", constellation: "Cygnus", ra: 303.0583, dec: 38.3500, magnitude: 7.4, size: "18×12", aliases: ["NGC 6888"] },
  { id: "C28", name: "C 28", type: "Open Cluster", constellation: "Andromeda", ra: 3.4333, dec: 35.6833, magnitude: 6.4, size: "6", aliases: ["NGC 752"] },
  { id: "C29", name: "C 29", type: "Galaxy", constellation: "Canes Venatici", ra: 196.2417, dec: 40.2833, magnitude: 10.9, size: "4", aliases: ["NGC 5005"] },
  { id: "C30", name: "C 30", type: "Galaxy", constellation: "Pegasus", ra: 353.0333, dec: 34.4167, magnitude: 11.6, size: "3×2", aliases: ["NGC 7331"] },
  { id: "C31", name: "C 31", commonName: "Flaming Star Nebula", type: "Emission Nebula", constellation: "Auriga", ra: 79.9417, dec: 34.2667, magnitude: 6.0, size: "30×19", aliases: ["IC 405"] },
  { id: "C32", name: "C 32", commonName: "Whale Galaxy", type: "Spiral Galaxy", constellation: "Canes Venatici", ra: 193.0875, dec: 32.5403, magnitude: 8.9, size: "16×3", aliases: ["NGC 4631"] },
  { id: "C33", name: "C 33", commonName: "East Veil Nebula", type: "Supernova Remnant", constellation: "Cygnus", ra: 312.7500, dec: 30.7167, magnitude: 7.0, size: "80×8", aliases: ["NGC 6992", "NGC 6995"] },
  { id: "C34", name: "C 34", commonName: "West Veil Nebula", type: "Supernova Remnant", constellation: "Cygnus", ra: 311.0417, dec: 30.7167, magnitude: 7.0, size: "70×6", aliases: ["NGC 6960"] },
  { id: "C35", name: "C 35", type: "Galaxy", constellation: "Coma Berenices", ra: 184.9667, dec: 27.9667, magnitude: 9.3, size: "8×3", aliases: ["NGC 4889"] },
  { id: "C36", name: "C 36", type: "Galaxy", constellation: "Coma Berenices", ra: 185.6333, dec: 26.7000, magnitude: 10.7, size: "4×2", aliases: ["NGC 4559"] },
  { id: "C37", name: "C 37", type: "Open Cluster", constellation: "Vulpecula", ra: 298.9333, dec: 27.4833, magnitude: 5.7, size: "20", aliases: ["NGC 6885"] },
  { id: "C38", name: "C 38", commonName: "Needle Galaxy", type: "Spiral Galaxy", constellation: "Coma Berenices", ra: 187.3708, dec: 25.9833, magnitude: 9.5, size: "16×2", aliases: ["NGC 4565"] },
  { id: "C39", name: "C 39", commonName: "Eskimo Nebula", type: "Planetary Nebula", constellation: "Gemini", ra: 112.2958, dec: 20.9117, magnitude: 9.2, size: "0.8", aliases: ["NGC 2392"] },
  { id: "C40", name: "C 40", type: "Galaxy", constellation: "Leo", ra: 152.0917, dec: 21.5000, magnitude: 11.5, size: "3×2", aliases: ["NGC 3626"] },
  { id: "C41", name: "C 41", type: "Open Cluster", constellation: "Taurus", ra: 66.7583, dec: 16.0333, magnitude: 0.5, size: "330", aliases: ["Melotte 25", "Hyades"] },
  { id: "C42", name: "C 42", type: "Emission Nebula", constellation: "Orion", ra: 83.5833, dec: 9.9333, magnitude: 5.0, size: "15", aliases: ["NGC 1977"] },
  { id: "C43", name: "C 43", type: "Galaxy", constellation: "Leo", ra: 168.7708, dec: 6.1000, magnitude: 10.5, size: "4×2", aliases: ["NGC 4027"] },
  { id: "C44", name: "C 44", type: "Galaxy", constellation: "Pegasus", ra: 357.7333, dec: 12.3167, magnitude: 11.6, size: "3×2", aliases: ["NGC 7479"] },
  { id: "C45", name: "C 45", type: "Galaxy", constellation: "Bootes", ra: 207.8333, dec: 8.8833, magnitude: 10.4, size: "4×1", aliases: ["NGC 5248"] },
  { id: "C46", name: "C 46", commonName: "Hubble's Variable Nebula", type: "Reflection Nebula", constellation: "Monoceros", ra: 99.6917, dec: 8.7417, magnitude: 9.0, size: "2", aliases: ["NGC 2261"] },
  { id: "C47", name: "C 47", type: "Globular Cluster", constellation: "Lyra", ra: 283.3667, dec: 33.0167, magnitude: 10.5, size: "5", aliases: ["NGC 6934"] },
  { id: "C48", name: "C 48", type: "Galaxy", constellation: "Pisces", ra: 13.1958, dec: -0.0833, magnitude: 10.3, size: "4×3", aliases: ["NGC 2775"] },
  { id: "C49", name: "C 49", commonName: "Rosette Nebula", type: "Emission Nebula", constellation: "Monoceros", ra: 98.0000, dec: 5.0333, magnitude: 9.0, size: "80", aliases: ["NGC 2237"] },
  { id: "C50", name: "C 50", type: "Open Cluster", constellation: "Monoceros", ra: 105.4750, dec: 4.7000, magnitude: 5.9, size: "8", aliases: ["NGC 2244"] },
  { id: "C51", name: "C 51", type: "Galaxy", constellation: "Cetus", ra: 17.8750, dec: -5.4667, magnitude: 10.0, size: "3×1", aliases: ["IC 1613"] },
  { id: "C52", name: "C 52", type: "Galaxy", constellation: "Virgo", ra: 186.5167, dec: -3.7333, magnitude: 9.8, size: "6×3", aliases: ["NGC 4697"] },
  { id: "C53", name: "C 53", commonName: "Spindle Galaxy", type: "Lenticular Galaxy", constellation: "Sextans", ra: 153.7167, dec: -7.7167, magnitude: 9.1, size: "9×2", aliases: ["NGC 3115"] },
  { id: "C54", name: "C 54", type: "Galaxy", constellation: "Monoceros", ra: 119.8333, dec: -9.5500, magnitude: 9.7, size: "5×4", aliases: ["NGC 2506"] },
  { id: "C55", name: "C 55", commonName: "Saturn Nebula", type: "Planetary Nebula", constellation: "Aquarius", ra: 316.0500, dec: -11.3667, magnitude: 8.0, size: "0.7", aliases: ["NGC 7009"] },
  { id: "C56", name: "C 56", type: "Galaxy", constellation: "Cetus", ra: 24.8750, dec: -11.8833, magnitude: 10.8, size: "5×4", aliases: ["NGC 246"] },
  { id: "C57", name: "C 57", commonName: "Barnard's Galaxy", type: "Irregular Galaxy", constellation: "Sagittarius", ra: 294.5250, dec: -14.8167, magnitude: 8.8, size: "16×15", aliases: ["NGC 6822"] },
  { id: "C58", name: "C 58", type: "Open Cluster", constellation: "Hydra", ra: 131.1500, dec: -15.6333, magnitude: 8.2, size: "30", aliases: ["NGC 2360"] },
  { id: "C59", name: "C 59", commonName: "Ghost of Jupiter", type: "Planetary Nebula", constellation: "Hydra", ra: 156.4333, dec: -18.6500, magnitude: 7.8, size: "1.6", aliases: ["NGC 3242"] },
  { id: "C60", name: "C 60", commonName: "Antennae Galaxies", type: "Interacting Galaxy", constellation: "Corvus", ra: 180.4708, dec: -18.8667, magnitude: 10.3, size: "5×3", aliases: ["NGC 4038", "NGC 4039"] },
  { id: "C61", name: "C 61", type: "Galaxy", constellation: "Corvus", ra: 190.3375, dec: -19.3333, magnitude: 10.0, size: "6×3", aliases: ["NGC 4027"] },
  { id: "C62", name: "C 62", type: "Planetary Nebula", constellation: "Centaurus", ra: 196.6083, dec: -23.4333, magnitude: 8.6, size: "1.4", aliases: ["NGC 247"] },
  { id: "C63", name: "C 63", commonName: "Helix Nebula", type: "Planetary Nebula", constellation: "Aquarius", ra: 337.4125, dec: -20.8333, magnitude: 7.3, size: "15", aliases: ["NGC 7293"] },
  { id: "C64", name: "C 64", type: "Galaxy", constellation: "Cetus", ra: 15.8333, dec: -20.7500, magnitude: 8.2, size: "20×7", aliases: ["NGC 2362"] },
  { id: "C65", name: "C 65", commonName: "Sculptor Galaxy", type: "Spiral Galaxy", constellation: "Sculptor", ra: 13.1583, dec: -25.2833, magnitude: 7.2, size: "27×7", aliases: ["NGC 253"] },
  { id: "C66", name: "C 66", type: "Globular Cluster", constellation: "Hydra", ra: 159.1333, dec: -26.5333, magnitude: 9.2, size: "7", aliases: ["NGC 5694"] },
  { id: "C67", name: "C 67", type: "Globular Cluster", constellation: "Sagittarius", ra: 269.7750, dec: -27.3333, magnitude: 9.3, size: "3", aliases: ["NGC 1097"] },
  { id: "C68", name: "C 68", type: "Galaxy", constellation: "Corvus", ra: 186.0000, dec: -27.6000, magnitude: 9.4, size: "6×4", aliases: ["NGC 6729"] },
  { id: "C69", name: "C 69", commonName: "Bug Nebula", type: "Planetary Nebula", constellation: "Scorpius", ra: 255.3375, dec: -37.1000, magnitude: 9.6, size: "2", aliases: ["NGC 6302"] },
  { id: "C70", name: "C 70", type: "Galaxy", constellation: "Sculptor", ra: 21.8833, dec: -32.3667, magnitude: 8.9, size: "8×5", aliases: ["NGC 300"] },
  { id: "C71", name: "C 71", type: "Open Cluster", constellation: "Puppis", ra: 117.0333, dec: -37.0833, magnitude: 5.8, size: "25", aliases: ["NGC 2477"] },
  { id: "C72", name: "C 72", type: "Globular Cluster", constellation: "Sculptor", ra: 6.0125, dec: -33.8667, magnitude: 9.3, size: "6", aliases: ["NGC 55"] },
  { id: "C73", name: "C 73", type: "Globular Cluster", constellation: "Columba", ra: 79.7000, dec: -35.0500, magnitude: 7.3, size: "7", aliases: ["NGC 1851"] },
  { id: "C74", name: "C 74", type: "Galaxy", constellation: "Fornax", ra: 52.7667, dec: -35.4333, magnitude: 8.5, size: "9×6", aliases: ["NGC 3132"] },
  { id: "C75", name: "C 75", type: "Galaxy", constellation: "Pavo", ra: 298.4583, dec: -37.1333, magnitude: 10.2, size: "6×5", aliases: ["NGC 6124"] },
  { id: "C76", name: "C 76", type: "Open Cluster", constellation: "Scorpius", ra: 248.8333, dec: -38.5500, magnitude: 5.8, size: "29", aliases: ["NGC 6231"] },
  { id: "C77", name: "C 77", commonName: "Centaurus A", type: "Galaxy", constellation: "Centaurus", ra: 201.3650, dec: -43.0192, magnitude: 6.8, size: "26×20", aliases: ["NGC 5128"] },
  { id: "C78", name: "C 78", type: "Globular Cluster", constellation: "Corona Australis", ra: 287.7167, dec: -36.9333, magnitude: 7.1, size: "14", aliases: ["NGC 6541"] },
  { id: "C79", name: "C 79", type: "Globular Cluster", constellation: "Lepus", ra: 82.1750, dec: -26.8167, magnitude: 8.7, size: "5", aliases: ["NGC 3201"] },
  { id: "C80", name: "C 80", commonName: "Omega Centauri", type: "Globular Cluster", constellation: "Centaurus", ra: 201.6969, dec: -47.4797, magnitude: 3.7, size: "36", aliases: ["NGC 5139"] },
  { id: "C81", name: "C 81", type: "Globular Cluster", constellation: "Ara", ra: 265.6500, dec: -53.6833, magnitude: 8.4, size: "5", aliases: ["NGC 6352"] },
  { id: "C82", name: "C 82", type: "Open Cluster", constellation: "Ara", ra: 260.7333, dec: -48.7667, magnitude: 5.2, size: "8", aliases: ["NGC 6193"] },
  { id: "C83", name: "C 83", type: "Open Cluster", constellation: "Centaurus", ra: 193.8333, dec: -60.2833, magnitude: 4.2, size: "12", aliases: ["NGC 4945"] },
  { id: "C84", name: "C 84", type: "Globular Cluster", constellation: "Centaurus", ra: 194.1500, dec: -51.3833, magnitude: 8.5, size: "4", aliases: ["NGC 5286"] },
  { id: "C85", name: "C 85", commonName: "Omicron Velorum Cluster", type: "Open Cluster", constellation: "Vela", ra: 131.6250, dec: -52.7667, magnitude: 2.5, size: "50", aliases: ["IC 2391"] },
  { id: "C86", name: "C 86", type: "Globular Cluster", constellation: "Ara", ra: 260.0917, dec: -51.9833, magnitude: 5.6, size: "12", aliases: ["NGC 6397"] },
  { id: "C87", name: "C 87", type: "Globular Cluster", constellation: "Horologium", ra: 64.8833, dec: -54.5500, magnitude: 7.2, size: "7", aliases: ["NGC 1261"] },
  { id: "C88", name: "C 88", type: "Globular Cluster", constellation: "Circinus", ra: 234.5333, dec: -59.2500, magnitude: 8.2, size: "6", aliases: ["NGC 5823"] },
  { id: "C89", name: "C 89", type: "Open Cluster", constellation: "Norma", ra: 246.5333, dec: -57.7667, magnitude: 5.4, size: "7", aliases: ["NGC 6087"] },
  { id: "C90", name: "C 90", type: "Planetary Nebula", constellation: "Carina", ra: 158.4333, dec: -58.8833, magnitude: 8.5, size: "3", aliases: ["NGC 2867"] },
  { id: "C91", name: "C 91", type: "Open Cluster", constellation: "Carina", ra: 169.6917, dec: -59.7333, magnitude: 3.0, size: "55", aliases: ["NGC 3532"] },
  { id: "C92", name: "C 92", commonName: "Eta Carinae Nebula", type: "Emission Nebula", constellation: "Carina", ra: 161.2583, dec: -59.8667, magnitude: 3.0, size: "120", aliases: ["NGC 3372"] },
  { id: "C93", name: "C 93", type: "Globular Cluster", constellation: "Pavo", ra: 280.9917, dec: -64.0667, magnitude: 5.4, size: "12", aliases: ["NGC 6752"] },
  { id: "C94", name: "C 94", commonName: "Jewel Box", type: "Open Cluster", constellation: "Crux", ra: 186.5833, dec: -60.3333, magnitude: 4.2, size: "10", aliases: ["NGC 4755"] },
  { id: "C95", name: "C 95", type: "Open Cluster", constellation: "Triangulum Australe", ra: 243.0833, dec: -68.6500, magnitude: 5.1, size: "12", aliases: ["NGC 6025"] },
  { id: "C96", name: "C 96", type: "Open Cluster", constellation: "Carina", ra: 113.9667, dec: -61.0667, magnitude: 3.8, size: "50", aliases: ["NGC 2516"] },
  { id: "C97", name: "C 97", commonName: "Pearl Cluster", type: "Open Cluster", constellation: "Centaurus", ra: 189.6000, dec: -63.0167, magnitude: 6.2, size: "12", aliases: ["NGC 3766"] },
  { id: "C98", name: "C 98", type: "Open Cluster", constellation: "Crux", ra: 193.6000, dec: -62.4333, magnitude: 6.9, size: "5", aliases: ["NGC 4609"] },
  { id: "C99", name: "C 99", commonName: "Coalsack Nebula", type: "Dark Nebula", constellation: "Crux", ra: 186.7500, dec: -62.5000, magnitude: 0, size: "420×300" },
  { id: "C100", name: "C 100", type: "Open Cluster", constellation: "Centaurus", ra: 173.0667, dec: -64.4000, magnitude: 4.5, size: "15", aliases: ["IC 2944"] },
  { id: "C101", name: "C 101", type: "Planetary Nebula", constellation: "Pavo", ra: 291.0417, dec: -66.3833, magnitude: 10.4, size: "2", aliases: ["NGC 6744"] },
  { id: "C102", name: "C 102", commonName: "Southern Pleiades", type: "Open Cluster", constellation: "Carina", ra: 126.3750, dec: -64.8500, magnitude: 1.9, size: "50", aliases: ["IC 2602"] },
  { id: "C103", name: "C 103", commonName: "Tarantula Nebula", type: "Emission Nebula", constellation: "Dorado", ra: 84.6833, dec: -69.1000, magnitude: 5.0, size: "40×25", aliases: ["NGC 2070"] },
  { id: "C104", name: "C 104", commonName: "47 Tucanae", type: "Globular Cluster", constellation: "Tucana", ra: 6.0236, dec: -72.0811, magnitude: 4.0, size: "31", aliases: ["NGC 104"] },
  { id: "C105", name: "C 105", type: "Globular Cluster", constellation: "Musca", ra: 191.8333, dec: -70.8667, magnitude: 6.6, size: "4", aliases: ["NGC 4833"] },
  { id: "C106", name: "C 106", commonName: "47 Tucanae", type: "Globular Cluster", constellation: "Tucana", ra: 2.7917, dec: -72.0833, magnitude: 4.9, size: "13", aliases: ["NGC 362"] },
  { id: "C107", name: "C 107", type: "Globular Cluster", constellation: "Apus", ra: 241.5000, dec: -78.8833, magnitude: 7.5, size: "3", aliases: ["NGC 6101"] },
  { id: "C108", name: "C 108", type: "Globular Cluster", constellation: "Musca", ra: 206.6167, dec: -64.8667, magnitude: 7.8, size: "9", aliases: ["NGC 4372"] },
  { id: "C109", name: "C 109", type: "Planetary Nebula", constellation: "Chamaeleon", ra: 184.0333, dec: -81.7833, magnitude: 11.6, size: "0.3", aliases: ["NGC 3195"] },
];

/**
 * Get catalog definition by template name
 */
export function getCatalog(template: string): CatalogDefinition | null {
  switch (template) {
    case "messier":
      return {
        id: "messier",
        name: "Messier Catalog",
        description: "The 110 objects cataloged by French astronomer Charles Messier in the 18th century",
        objects: MESSIER_CATALOG,
      };
    case "caldwell":
      return {
        id: "caldwell",
        name: "Caldwell Catalog",
        description: "109 deep-sky objects compiled by Sir Patrick Caldwell-Moore to complement the Messier catalog",
        objects: CALDWELL_CATALOG,
      };
    default:
      return null;
  }
}

/**
 * Check if a name matches a catalog entry (handles various formats like M31, M 31, NGC 224)
 */
export function matchesCatalogEntry(name: string, entry: CatalogEntry): boolean {
  const normalizedName = name.trim().toUpperCase();

  // Check primary name (with and without space)
  const entryNameNoSpace = entry.name.replace(/\s+/g, "").toUpperCase();
  const entryNameWithSpace = entry.name.toUpperCase();
  if (normalizedName === entryNameNoSpace || normalizedName === entryNameWithSpace) {
    return true;
  }

  // Check ID
  if (normalizedName === entry.id.toUpperCase()) {
    return true;
  }

  // Check aliases
  if (entry.aliases) {
    for (const alias of entry.aliases) {
      const aliasNormalized = alias.replace(/\s+/g, "").toUpperCase();
      const aliasWithSpace = alias.toUpperCase();
      if (normalizedName === aliasNormalized || normalizedName === aliasWithSpace) {
        return true;
      }
    }
  }

  return false;
}
