import { randomBytes, randomInt } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const environmentPath = path.join(projectRoot, ".env");
const pinSheetPath = path.join(projectRoot, "pincodes.local.txt");
const participants = [
  ["viktor", "Viktor"],
  ["daniel", "Daniel"],
  ["keano", "Keano"],
  ["sander", "Sander"],
  ["jurjan", "Jurjan"],
];

for (const filePath of [environmentPath, pinSheetPath]) {
  try {
    await access(filePath);
    throw new Error(`${path.basename(filePath)} bestaat al. Verwijder of verplaats het bestand eerst als je bewust nieuwe pincodes wilt maken.`);
  } catch (error) {
    if (error instanceof Error && !Object.hasOwn(error, "code")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

const usedPins = new Set();
const pins = Object.fromEntries(participants.map(([id]) => {
  let pin;
  do pin = String(randomInt(100_000, 1_000_000));
  while (usedPins.has(pin));
  usedPins.add(pin);
  return [id, pin];
}));
const secret = randomBytes(48).toString("base64url");
const environment = [
  `AUTH_SECRET=${secret}`,
  `MEMBER_PINS='${JSON.stringify(pins)}'`,
  "",
].join("\n");
const pinSheet = [
  "DE GEZAMENLIJKE 50 — PINCODES",
  "",
  ...participants.map(([id, name]) => `${name}: ${pins[id]}`),
  "",
  "Bewaar dit bestand privé en deel met iedereen alleen diens eigen pincode.",
  "Nieuwe pincodes maken alle nieuw gestarte sessies afhankelijk van de nieuwe codes.",
  "",
].join("\n");

await writeFile(environmentPath, environment, { encoding: "utf8", flag: "wx", mode: 0o600 });
await writeFile(pinSheetPath, pinSheet, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log("Pincodes en sessiegeheim zijn lokaal aangemaakt.");
console.log("Open pincodes.local.txt om de codes privé te verdelen.");
