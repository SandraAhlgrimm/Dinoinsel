import { readFile } from "node:fs/promises";

const HELP = `Dinoinsel – nur für Erwachsene

npm run admin -- --api https://APP.azurewebsites.net create ["Unsere Dino-Runde"]
npm run admin -- --api https://APP.azurewebsites.net inspect ROOM_ID
npm run admin -- --api https://APP.azurewebsites.net rotate ROOM_ID
npm run admin -- --api https://APP.azurewebsites.net revoke ROOM_ID --confirm
npm run admin -- --api https://APP.azurewebsites.net delete-room ROOM_ID --confirm
npm run admin -- --api https://APP.azurewebsites.net delete-profile ROOM_ID PLAYER_ID --confirm

Für den laufenden lokalen Testserver statt "--api ..." nur "--local" verwenden.
Der Azure-Zugriffsschlüssel wird verdeckt abgefragt, nie als Argument oder URL.
Einladungen werden bei create/rotate einmal angezeigt: nur privat weitergeben!
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AdminError extends Error {}

async function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new AdminError("Bitte interaktiv in einem Terminal starten; keine Schlüssel in Befehlszeilen oder Dateien hinterlegen.");
  }
  process.stderr.write("Azure Function-Zugriffsschlüssel (verdeckt): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const buffer of process.stdin) {
      for (const character of buffer.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") throw new AdminError("Abgebrochen.");
        if (character === "\r" || character === "\n") {
          if (!/^[A-Za-z0-9_+/=-]{16,512}$/.test(value)) throw new AdminError("Der Schlüssel hat kein gültiges Format.");
          return value;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (/^[A-Za-z0-9_+/=-]$/.test(character) && value.length < 512) value += character;
      }
    }
    throw new AdminError("Kein Schlüssel eingegeben.");
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const local = args[0] === "--local";
  let origin;
  if (local) {
    args.shift();
    origin = "http://127.0.0.1:7071";
  } else {
    if (args.shift() !== "--api") throw new AdminError("Bitte --api mit einer reinen HTTPS-Origin oder --local angeben.");
    const input = args.shift();
    let parsed;
    try { parsed = new URL(input); } catch { throw new AdminError("Ungültige API-Origin."); }
    if (parsed.protocol !== "https:" || input !== parsed.origin) {
      throw new AdminError("Die API-Adresse muss eine HTTPS-Origin ohne /api, Pfad, Zugangsdaten oder Query sein.");
    }
    origin = parsed.origin;
  }
  const action = args.shift();
  const confirmed = args.includes("--confirm");
  const values = args.filter((value) => value !== "--confirm");
  const validId = (value) => {
    if (!UUID.test(value ?? "")) throw new AdminError("Bitte eine gültige Raum-/Profil-UUID angeben.");
    return value.toLowerCase();
  };
  let method;
  let path;
  let body;
  switch (action) {
    case "create":
      if (values.length > 1) throw new AdminError("Den Raumnamen bitte als ein Argument in Anführungszeichen angeben.");
      method = "POST";
      path = "admin/rooms";
      body = values.length === 1 ? { label: values[0] } : {};
      break;
    case "inspect":
    case "rotate":
    case "revoke":
    case "delete-room": {
      if (values.length !== 1) throw new AdminError("Genau eine Raum-ID angeben.");
      path = `admin/rooms/${validId(values[0])}`;
      method = action === "inspect" ? "GET" : action === "delete-room" ? "DELETE" : "POST";
      if (action === "rotate" || action === "revoke") {
        path += "/invite";
        body = { action };
      }
      if ((action === "revoke" || action === "delete-room") && !confirmed) {
        throw new AdminError("Diese Änderung ist absichtlich geschützt. Nach Prüfung --confirm hinzufügen.");
      }
      break;
    }
    case "delete-profile":
      if (values.length !== 2) throw new AdminError("Raum-ID und Profil-ID angeben.");
      if (!confirmed) throw new AdminError("Das Profil wird endgültig aus der Online-Runde entfernt. Zum Bestätigen --confirm hinzufügen.");
      path = `admin/rooms/${validId(values[0])}/profiles/${validId(values[1])}`;
      method = "DELETE";
      break;
    default:
      throw new AdminError("Unbekannter Befehl. Hilfe: npm run admin -- --help");
  }
  let key;
  if (local) {
    try { key = await readFile(".local/dev-admin-key", "utf8"); }
    catch { throw new AdminError("Kein lokaler Erwachsenen-Schlüssel gefunden. Zuerst npm run dev starten."); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new AdminError("Der lokale Test-Schlüssel ist ungültig.");
  } else {
    key = await hiddenKey();
  }
  let response;
  try {
    response = await fetch(`${origin}/api/${path}`, {
      method,
      headers: { "x-functions-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AdminError("API nicht erreichbar. Adresse und Internetverbindung prüfen; Schlüssel werden nicht angezeigt.");
  }
  key = undefined;
  if (!response.ok) {
    throw new AdminError(`API meldet HTTP ${response.status}. Schlüssel, IDs und Eingaben prüfen; bei 429/503 später erneut versuchen.`);
  }
  if (response.status === 204) {
    console.log("Löschung bestätigt. Lokale Spielstände auf den Geräten wurden dadurch nicht gelöscht.");
    return;
  }
  let result;
  try { result = await response.json(); }
  catch { throw new AdminError("Unerwartete API-Antwort."); }
  if (!result?.room || !UUID.test(result.room.id) || typeof result.room.label !== "string") {
    throw new AdminError("Unerwartete API-Antwort.");
  }
  const safe = { room: { id: result.room.id, label: result.room.label } };
  if (action === "create" || action === "rotate") {
    if (typeof result.inviteCode !== "string" || result.inviteCode.length !== 80) throw new AdminError("Einladung fehlt.");
    safe.inviteCode = result.inviteCode;
    console.error("Private Einladung: nicht in GitHub, öffentliche Chats oder Screenshots kopieren.");
  } else if (action === "revoke") {
    safe.inviteRevoked = result.inviteRevoked === true;
  } else if (action === "inspect") {
    safe.createdAt = result.createdAt;
    safe.updatedAt = result.updatedAt;
    safe.inviteActive = result.inviteActive;
    safe.playerCount = result.playerCount;
    safe.players = Array.isArray(result.players)
      ? result.players.map((player) => ({ id: player.id, nickname: player.nickname })) : [];
  }
  console.log(JSON.stringify(safe, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof AdminError ? error.message : "Die Verwaltungsanfrage konnte nicht abgeschlossen werden.");
  process.exitCode = 1;
});
