# Dinoinsel – private Freundes-Bestenliste auf Azure

**Vorbereiteter Quellcode; der Dienst ist nicht in Azure bereitgestellt.** Die aktuelle
GitHub-Pages-Version und APK 1.2 verwenden ausschließlich ihre lokale Bestenliste.
Es gibt **noch keine Client-Anbindung**; `leaderboardApiUrl` bleibt leer. Ein Eintrag
in der Konfiguration allein verbindet das Spiel nicht mit dieser API. Die spätere
Client-Integration und Bereitstellung benötigen eine separate ausdrückliche Freigabe
durch eine erwachsene Person; das Spiel benötigt keinen Azure-Zugangsschlüssel.
Hier werden weder Azure-Konten angelegt noch automatisch Ressourcen, Abonnements
oder Deployments gestartet.

## Was enthalten ist

- Azure Functions **Runtime v4, Node.js-Programmiermodell v4**, strikt typisiertes
  TypeScript; Zielruntime **Node.js 24 LTS**.
- Azure **Table Storage**, in Produktion ausschließlich mit Managed Identity.
- Private, nicht öffentlich auflistbare Räume mit maximal **50 Profilen**.
- Feste Fantasienamen, zufällige Einladungen, gehashte Profil-Token.
- **Ein Punkt pro Mahlzeit + ein Punkt pro richtig gelöster Matheaufgabe.**
  Keine Abzüge bei Fehlern. Der Server berechnet `total = meals + mathSolved`.
- Atomare, monoton wachsende Zähler; idempotenter Beitritt und Fortschrittsabgleich.
- Eigene Profile löschen; Erwachsene können Einladungen drehen/sperren,
  verlorene Profile entfernen und ganze Räume löschen.
- Lokaler Testserver, echter Azurite-Table-Test, Bicep-Vorlage und Paketbau.

**Keine Anti-Cheat-Garantie:** Ein angebundener Spielclient meldet seine Zähler selbst.
Die API prüft weder Spielereignisse noch Matheantworten. Wer das eigene Profil-Token
besitzt, kann für dieses Profil bis zum Zählerlimit erfundene Werte melden.
Einladungsinhaber können weitere Profile anlegen, bis der Raum voll ist.
Das ist eine kleine private Freundesrunde, kein manipulationssicherer Wettbewerb.

## Lokal prüfen – ohne Azure und ohne globale Tools

Voraussetzung: ein aktueller **Node.js-24-Patchstand** mit npm.
Alle Befehle dieses Dokuments werden **im Ordner `api/`** ausgeführt.

```sh
npm ci
npm run check
```

`check` prüft TypeScript, baut die Produktionseinstiegsdatei und startet:

| Prüfung | Was tatsächlich geprüft wird |
| --- | --- |
| `npm run test:unit` | Geschäftslogik, Eingabeprüfung, Auth-Isolation, Nicknames, Punkte, Maxima/Replay, Konflikte, Raumlimit, Ranggleichstände, Löschung, CORS, sichere Fehler, Rate-Limits und echte v4-Funktionsregistrierung |
| `npm run test:integration` | Echter `@azure/data-tables`-Client gegen Azurite: Persistenz, ETags, parallele Instanzen, 50er-Grenze, Löschung, fehlende Tabelle vs. fehlende Zeile sowie HTTP-Vertrag über Loopback |
| `npm run build` / `npm run typecheck` | Produktionsbuild bzw. strikte Typprüfung |
| `npm run package` | Nur Produktionsdateien/-abhängigkeiten als `.package/dinoinsel-api.zip`; **kein Upload** |

Azurite ist eine gesperrte, workspace-lokale Entwicklungsabhängigkeit. Tests starten
ihn mit einem frischen Testkonto und zufälligem, nur im Speicher gehaltenem Testschlüssel
auf **127.0.0.1 und einem freien Port**. Sie verwenden `.local/`, beenden ihre
eigenen Prozesse und entfernen die Testdaten auch nach Testfehlern. Keine Verbindung
zu Azure, keine globalen Installationen und keine Hintergrund-Daemons nötig.

Der Speicheradaptertest und die HTTP-Tests sind **keine** Prüfung von Azure-RBAC,
Managed Identity, Azure-TLS, Azure-Host-Authentifizierung, Region/Quota oder der
plattformseitigen CORS-Schicht. Diese Prüfungen stehen vor einer echten Freigabe noch aus.

### Lokalen API-Server starten – noch ohne Spiel-Anbindung

```sh
npm run dev
```

Das startet die API unter `http://127.0.0.1:7071` und einen eigenen Azurite-Prozess,
beide ausschließlich auf Loopback. Erlaubte Spiel-Origin:
`http://localhost:4173` oder `http://127.0.0.1:4173`.
Ein späterer Browser-Testclient würde nur die API-Origin `http://127.0.0.1:7071`,
**nicht** `/api`, verwenden. **Das vorhandene Spiel ruft diesen Server noch nicht auf.**
Die aktuelle Spiele-Konfiguration bleibt leer; eine Änderung daran ersetzt nicht die
noch zu implementierende Client-Anbindung.

In einem zweiten Terminal:

```sh
npm run admin -- --local create "Unsere Dino-Runde"
```

Der lokale Server erzeugt einen einmaligen lokalen Erwachsenen-Schlüssel in
`.local/dev-admin-key` mit restriktiven Dateirechten. Das Verwaltungstool liest ihn,
ohne ihn anzuzeigen. Er ist **kein Azure-Schlüssel**. `Ctrl+C` beendet beide Prozesse
und entfernt diesen Schlüssel. Die lokalen Table-Daten in `.local/dev/azurite`
bleiben für den nächsten Test erhalten. Nach einem harten Prozessabbruch eine
übrig gebliebene Schlüsseldatei nur entfernen, wenn sicher kein lokaler Server mehr läuft.

Dieser kleine HTTP-Adapter verwendet **dieselben Handler und dieselbe Geschäftslogik**
wie Azure, ersetzt lokal aber die Function-Key-Prüfung durch den lokalen Testschlüssel.
Er ist nicht der Azure Functions Host und gehört nicht ins Deployment.
`local.settings.example.json` enthält ausschließlich die bekannte
`UseDevelopmentStorage=true`-Emulatorkonfiguration für eine optionale Core-Tools-Umgebung
(deren Standard-Table-Port ist 10002); `npm run dev` benötigt und liest diese Datei nicht.

## Fester Frontend-Vertrag

### Grundregeln

- Konfiguration: reine API-**Origin**, z. B. `https://APP.azurewebsites.net`.
  Ein künftig angebundener Client hängt die nachstehenden `/api/...`-Pfade an.
- JSON in UTF-8; Requests maximal **2.048 Bytes**. Kein freier Profilname.
- `playerId`: clientseitig erzeugte UUID, empfohlen `crypto.randomUUID()`.
  Groß-/Kleinschreibung wird zur kanonischen Kleinschreibung normalisiert.
- `playerToken`: **32 kryptografisch zufällige Bytes**, kanonisches Base64url ohne
  Padding, genau **43 Zeichen**. Kein Passwort, Name oder aus Geräteinformationen
  abgeleiteter Wert. **Vor dem ersten Join beide Werte sicher lokal speichern.**
- `credentials: "omit"`; kein Cookie-Login. Ein Token wird ausschließlich im
  `Authorization: Bearer ...`-Header übertragen, niemals in einer URL.
- Jede Mitgliedschaft ist an Raum-ID, Profil-ID und Token gebunden.
- `meals` und `mathSolved`: nichtnegative sichere Ganzzahlen, jeweils höchstens
  **1.000.000**; Gesamtmaximum somit **2.000.000**. Fehlerhafte/fremde Zusatzfelder,
  etwa `score`, `total`, `name` oder `nickname`, werden nicht übernommen.
- Der Client führt beide **Lebenszeit-Zähler** lokal fort. Dinosaurierwechsel oder
  ein neu gestartetes Level dürfen diese Online-Zähler nicht zurücksetzen.
  Der Server zählt Snapshots nicht erneut als neue Ereignisse.

### 1. Raum anlegen – nur Erwachsene

`POST /api/admin/rooms`, Azure `authLevel: "function"`.
Zugriffsschlüssel ausschließlich im Header `x-functions-key`.

Optionaler Body: `{"label":"Unsere Dino-Runde"}`. Ohne Body/Label wird dieser
Standard verwendet. Labels werden normalisiert und auf 1–40 Zeichen aus Buchstaben,
Ziffern, Leerzeichen, `.`, `!`, `_`, `-` beschränkt. Erwachsene sollen keine echten
Namen, Schulklassen oder anderen personenbezogenen Angaben als Label verwenden.

Antwort **201**:

```json
{
  "room": {"id": "ROOM_UUID", "label": "Unsere Dino-Runde"},
  "inviteCode": "ROOM_UUID.BASE64URL_INVITATION"
}
```

Die Einladung enthält die Raum-UUID als Locator plus **256 zufällige Bits**.
Gesamtlänge: 80 Zeichen. Nur ihr SHA-256-Hash wird gespeichert. Es gibt keinen
Such-/Auflistungsendpunkt für Räume. Einmal angezeigte Einladungen können nicht
aus dem Speicher wieder ausgelesen werden; bei Verlust eine neue erzeugen.
Raumerstellung ist anders als Join nicht idempotent: kein automatisches
Retry in einer Schleife, das unbeabsichtigt viele Räume erzeugt.

### 2. Beitreten

`POST /api/rooms/join`, ohne Function Key:

```json
{
  "inviteCode": "ROOM_UUID.BASE64URL_INVITATION",
  "playerId": "CLIENT_UUID",
  "playerToken": "43_CHAR_BASE64URL_TOKEN"
}
```

Antwort **200**:

```json
{
  "room": {"id": "ROOM_UUID", "label": "Unsere Dino-Runde"},
  "player": {"id": "CLIENT_UUID", "nickname": "Flinker Stego-A1B2C3"},
  "score": {"meals": 0, "mathSolved": 0, "total": 0}
}
```

Gleiche Identität + gleiches Token + gültige Einladung liefern das bestehende
Profil **mit seinen bisherigen Punkten**, ohne Schreibzugriff oder Zurücksetzen.
Ein anderes Token für ein bestehendes Profil erhält **409 `IDENTITY_CONFLICT`**.
Einladungen sind geheim zu halten; ungültige, unbekannte und widerrufene Einladungen
liefern einheitlich **403 `INVALID_INVITE`**, keine Raumdetails.
Ein volles Zimmer liefert **409 `ROOM_FULL`**; bestehende Mitglieder können weiter
lesen, spielen und mit gültiger Einladung idempotent erneut beitreten.

### 3. Bestenliste lesen

`GET /api/leaderboard?roomId=ROOM_UUID&playerId=CLIENT_UUID`
mit `Authorization: Bearer PLAYER_TOKEN`.

Antwort **200**:

```json
{
  "entries": [
    {"playerId":"CLIENT_UUID","nickname":"Flinker Stego-A1B2C3","meals":7,"mathSolved":9,"total":16,"rank":1}
  ],
  "you": {"playerId":"CLIENT_UUID","nickname":"Flinker Stego-A1B2C3","meals":7,"mathSolved":9,"total":16,"rank":1},
  "updatedAt": "2026-09-21T12:00:00.000Z"
}
```

Sortierung: `total` absteigend, dann kanonische `playerId` **ASCII-aufsteigend**.
Ränge sind eindeutige Positionen `1..N`; bei Punktgleichstand werden keine geteilten
Ränge vergeben. Die Liste enthält höchstens 50 Einträge und ist ein konsistenter
Snapshot. `updatedAt` ist die letzte tatsächliche Änderung des Raums, keine
„zuletzt gesehen“-Überwachung pro Kind.

### 4. Fortschritt abgleichen

`POST /api/progress`, Bearer-Header:

```json
{"roomId":"ROOM_UUID","playerId":"CLIENT_UUID","meals":7,"mathSolved":9}
```

Antwort **200**:

```json
{"score":{"meals":7,"mathSolved":9,"total":16},"updatedAt":"2026-09-21T12:00:00.000Z"}
```

Der Server speichert **für jeden Zähler unabhängig das Maximum** aus dem aktuellen
und dem gemeldeten Wert. Alte/offline/reihenfolgeverkehrte Snapshots senken nichts.
Identische oder kleinere Snapshots schreiben nicht erneut.
Bei `429`/`503` mit Abstand, Jitter und `Retry-After` erneut versuchen; lokale
Fortschritte nicht verwerfen. Vorschlag: Fortschritt und Bestenliste bündeln,
nicht öfter als etwa alle 30 Sekunden synchronisieren/abfragen.

### 5. Eigenes Online-Profil löschen

`DELETE /api/profile?roomId=ROOM_UUID&playerId=CLIENT_UUID`, Bearer-Header.
Antwort **204**, ohne Body.

Entfernt genau dieses Profil samt Token-Hash, Fantasiename und Online-Zählern.
Die UI muss vorher ausdrücklich bestätigen lassen. Anschließend die gespeicherte
Online-Mitgliedschaft entfernen und **nicht automatisch erneut beitreten**.
Lokale Spielstände werden durch diesen Serveraufruf nicht gelöscht.
Ein wiederholtes Profil-DELETE mit bereits entferntem Token liefert `401`.
Ein späterer ausdrücklicher Beitritt kann ein neues Profil erzeugen; das ist keine
automatische Wiederherstellung gelöschter Daten.

### Fehler und CORS

Von der Anwendung behandelte Fehler haben immer:

```json
{"error":{"code":"UNAUTHORIZED","message":"Dieses Spielprofil ist hier nicht angemeldet. Bitte frage eine erwachsene Person."}}
```

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_INPUT` |
| 401 | `UNAUTHORIZED` |
| 403 | `INVALID_INVITE`, `ORIGIN_NOT_ALLOWED` |
| 404 | `NOT_FOUND` (Verwaltung/entfernte Ressource) |
| 409 | `IDENTITY_CONFLICT`, `ROOM_FULL` |
| 429 | `RATE_LIMITED`, `Retry-After: 60` |
| 503 | `BUSY`, `UNAVAILABLE`, `Retry-After: 5` |

Falsche Raum-/Profil-/Token-Kombinationen sind einheitlich `401`.
Es gibt keine Stacktraces, Body-Daten, Einladungen oder Token in Fehlerantworten.
Antworten einschließlich Fehlern sind `Cache-Control: no-store`.
Der Azure-Host kann Anfragen **vor dem Handler** ablehnen, z. B. fehlende
Erwachsenen-Schlüssel, unbekannte Routen, Host-Überlastung oder Bodies über dem
zusätzlichen **4.096-Byte-Hostlimit**. Solche Plattformantworten können Nicht-JSON
sein; der Client braucht hierfür eine sichere allgemeine Fehlermeldung.

Nur exakt konfigurierte Origins sind erlaubt, keine Wildcards, keine Cookies
und kein `Access-Control-Allow-Credentials`. Anonyme `OPTIONS`-Funktionen erlauben
Preflights auch vor geschützten Erwachsenen-Routen; sie erlauben nur tatsächlich
verfügbare Methoden und `Authorization`, `Content-Type`, `X-Functions-Key`.
Browser-Ursprünge werden auch im Handler geprüft. Requests ohne `Origin`, etwa
vom Verwaltungstool, sind möglich – **CORS ist keine Authentifizierung**.

GitHub Pages benötigt z. B. `https://DEIN-ACCOUNT.github.io`, **ohne** `/dinoinsel/`.
Eine Origin gilt für alle Projekte unter diesem Host, nicht nur für einen
Repository-Pfad. Für stärkere Trennung eine eigene Spiel-Domain verwenden.

## Speicherung und Grenzen

Eine Table-Entity pro Raum: `PartitionKey = Raum-UUID`, `RowKey = room`,
Schema-Version und ein begrenztes JSON-Feld. Ein voller Raum mit maximalen
Zählern bleibt deutlich unter Azures **64-KiB-UTF-16-Property-Limit**;
zusätzlich schützt eine 60.000-Byte-Grenze.

Die gesamte Mitgliedschaft und alle Zähler werden mit dem gelesenen **ETag**
ersetzt, **niemals upserted**. Dadurch sind Raumlimit, Punktänderungen, Löschung
und Einladungsrotation atomar. Konflikte lesen den aktuellen Zustand neu,
berechnen Maxima erneut und versuchen es höchstens **8-mal** mit kurzem Jitter.
Danach folgt `503 BUSY`. Ein gleichzeitig gelöschter Raum oder ein gelöschtes
Profil wird durch alte Fortschrittsanfragen nicht wiederhergestellt.

Token-Hashes sind SHA-256 mit Raum-/Profil-Kontext und Domain-Separation;
Vergleiche sind zeitkonstant. Das ist für zufällige 256-Bit-Token ausgelegt,
**nicht** für menschliche Passwörter. Der Datenbankzugriff erfolgt nur serverseitig.

Zusätzliche Caps pro Node-Prozess / 60-Sekunden-Fenster:

- 600 Anfragen insgesamt, einschließlich Preflights;
- 30 Join-Anfragen, auch bei ungültiger Einladung;
- 10 Verwaltungsanfragen;
- 60 Anfragen pro Kombination aus Raum, Profil und Token;
- maximal 1.024 aktive Rate-Limit-Buckets im Arbeitsspeicher.

Diese Limits sind **Best Effort**, nicht verteilt/persistent: Neustarts setzen sie
zurück, zusätzliche Instanzen vervielfachen sie. Fremde Token verbrauchen nicht
den privaten Bucket eines anderen Mitglieds. Die 50-Profil-Grenze dagegen ist
dauerhaft und atomar. Öffentliche anonyme Endpunkte bleiben für Missbrauch
erreichbar; Limits ersetzen weder DDoS-Schutz noch ein hartes Ausgabenlimit.

## Datenschutz, Aufbewahrung und Aufräumen

Gespeichert werden Raum-ID/-Label, gehashte Einladung, Erstellungs-/Änderungszeit
sowie je Profil zufällige ID, Token-Hash, Fantasiename und zwei Zähler.
Keine echten Spielernamen, E-Mail-Adressen, Geburtstage, Werbung, Analytics-SDKs
oder eigene Spieltelemetrie. Anwendungsausgaben bei Serverfehlern enthalten nur
statische Kategorie/Fehlercode, keine URLs, IDs, Request-Bodies, Token oder Codes.
Keine Application-Insights-/Log-Analytics-Ressource wird angelegt.
Verbose SDK-/Request-Logging nicht einschalten; keine Schlüssel als `?code=...`
verwenden und keine vollständigen Requests in eigene Diagnosewerkzeuge kopieren.

**Das ist trotzdem nicht „ohne personenbezogene Daten“.** Pseudonyme Kennungen
und Fortschritte können personenbezogen sein. Azure, Netzbetreiber und ggf.
GitHub Pages verarbeiten technische Daten wie IP-/Verbindungsmetadaten. Die
Vorlage deaktiviert eigene HTTP-/Tracing-Logs, kann aber keine vollständige
Kontrolle über Plattformprotokolle oder deren Aufbewahrung garantieren.
Erwachsene müssen Zweck, Information/Einwilligung, Hostingregion und geltende
Datenschutzanforderungen vor dem Teilen eigenverantwortlich klären.
Ein Einladungscode belegt keine elterliche Einwilligung.

**Präzise Aufbewahrungsgrenze:** Es gibt absichtlich **keine automatische
Ablaufzeit, TTL oder Hintergrundlöschung**. Räume bleiben gespeichert und nutzbar,
bis ein Erwachsener sie löscht. Es findet niemals ein stiller Zeit-Reset statt.
Empfehlung: spätestens nach 30 Tagen gemeinsam prüfen und Räume am Ende der
Spielrunde löschen. Eine verbindliche automatische Löschfrist ist mit dieser
Version **nicht** umgesetzt; nicht als solche ankündigen.

Implementierte Löschung entfernt den aktuellen Table-Datensatz bzw. das Profil
aus diesem Datensatz. Sie löscht keine bereits angefertigten Exporte,
Screenshots, externe Sicherungen oder Azure-Plattformmetadaten. Die Vorlage
legt keine Spielsicherungen an. Beim späteren Aktivieren von Backups muss deren
Aufbewahrung separat geregelt werden.

## Verwaltung durch Erwachsene

```sh
npm run admin -- --api https://APP.azurewebsites.net create "Unsere Dino-Runde"
npm run admin -- --api https://APP.azurewebsites.net inspect ROOM_UUID
npm run admin -- --api https://APP.azurewebsites.net rotate ROOM_UUID
npm run admin -- --api https://APP.azurewebsites.net revoke ROOM_UUID --confirm
npm run admin -- --api https://APP.azurewebsites.net delete-profile ROOM_UUID PLAYER_UUID --confirm
npm run admin -- --api https://APP.azurewebsites.net delete-room ROOM_UUID --confirm
```

Für Azure wird der Schlüssel **verdeckt im Terminal abgefragt**, niemals als
Argument oder URL angenommen. Keine `.env`-Datei mit Schlüssel nötig.
Das Tool verweigert Redirects. Nur `create`/`rotate` zeigen absichtlich die neue
Einladung an: Diese Ausgabe privat behandeln, nicht als Diagnoselog veröffentlichen.
`inspect` nennt IDs/Fantasienamen, um ein Profil ohne verlorenes Token zu löschen.

Geschützte Zusatzrouten:

| Methode / Route | Wirkung |
| --- | --- |
| `GET /api/admin/rooms/{roomId}` | Raumdaten, `inviteActive`, `playerCount`, IDs/Fantasienamen; keine Token oder Einladungen |
| `POST /api/admin/rooms/{roomId}/invite`, `{"action":"rotate"}` | Neue Einladung, bisherige Einladung sofort ungültig; bestehende Punkte bleiben |
| Derselbe Pfad, `{"action":"revoke"}` | Keine weiteren Beitritte, Antwort `{room,inviteRevoked:true}` |
| `DELETE /api/admin/rooms/{roomId}/profiles/{playerId}` | Genau dieses Profil entfernen; bei bereits entferntem Profil idempotent 204 |
| `DELETE /api/admin/rooms/{roomId}` | Alle Raumdaten atomar entfernen; auch wiederholt 204 |

Sperren/Drehen einer Einladung meldet bestehende Mitglieder **nicht** ab.
Bei weitergegebener Einladung: sperren, unerwünschte Profile entfernen, dann neue
Einladung privat verteilen. Bei verlorenem/kompromittiertem Profil-Token:
betroffenes Profil entfernen; es gibt keine unsichere Token-Wiederherstellung.
Bei kompromittiertem Erwachsenen-Schlüssel diesen zusätzlich in Azure drehen.

Alle Erwachsenen-Routen haben `authLevel: "function"`. Azure akzeptiert einen
Funktionsschlüssel für die betreffende Funktion oder einen App-/Host-Schlüssel
für mehrere Funktionen. Am einfachsten ist ein eigener benannter App-Schlüssel
für Erwachsene; er berechtigt zur Verwaltung der gesamten App. Alternativ
einzelne Funktionsschlüssel verwenden. **Nie den `_master`-Schlüssel und nie
einen Erwachsenen-Schlüssel im Spiel, Android-Paket, Pages-HTML oder Repository
speichern.** Raum-IDs und aktuelle Einladungen privat notieren.

## Späteres Azure-Deployment – nur nach separater Freigabe

**Die folgenden Schritte sind eine Anleitung, keine bereits ausgeführten Aktionen.
Sie benötigen eine bewusst ausgewählte Azure-Subscription und können Geld kosten.**
Aktuelle Azure CLI mit Flex-/Entra-Deployment-Unterstützung und Bicep verwenden.
Das ausführende Erwachsenenkonto braucht Ressourcen- und RBAC-Zuweisungsrechte
für die gewählte, dedizierte Ressourcengruppe; die App selbst erhält keine solchen
Verwaltungsrechte.

### 1. Lokal vorbereiten und prüfen

```sh
npm ci
npm run check
npm run package
cp infra/parameters.example.json infra/deployment.local.parameters.json
```

In der Kopie alle Platzhalter ersetzen: global eindeutiger kleiner App-Name,
gewünschte unterstützte Region und exakte HTTPS-Spiel-Origin(s). Zum Beispiel
die tatsächliche eigene `https://account.github.io`-Origin, ohne Projektpfad.

```sh
npm run infra:check -- infra/deployment.local.parameters.json
bicep build infra/main.bicep --outfile .local/infra.json
```

Diese beiden Prüfungen erzeugen keine Azure-Ressourcen. Die erste verweigert
Platzhalter/Wildcards/unsichere Origins. Region, Laufzeitverfügbarkeit, Quotas
und Berechtigungen lassen sich damit noch nicht prüfen.

### 2. Nach ausdrücklicher Kosten-/Deployment-Freigabe

Vorher Azure-Preise/Region prüfen und ein kleines **Budget mit Benachrichtigungen**
einrichten. Dann erst manuell anmelden:

```sh
az login
az account set --subscription "SUBSCRIPTION-ID"
az functionapp list-flexconsumption-locations --output table
az functionapp list-flexconsumption-runtimes --location westeurope --output table
```

Nur eine **neue, eigene** Ressourcengruppe für diese App benutzen; Namen und Region
bewusst anpassen, keine vorhandenen fremden Ressourcen überschreiben.

```sh
az group create --name rg-dinoinsel-friends --location westeurope
az deployment group what-if \
  --resource-group rg-dinoinsel-friends \
  --template-file infra/main.bicep \
  --parameters @infra/deployment.local.parameters.json

# Erst nach Prüfung der What-if-Ausgabe:
az deployment group create \
  --resource-group rg-dinoinsel-friends \
  --template-file infra/main.bicep \
  --parameters @infra/deployment.local.parameters.json
```

Die Vorlage erstellt:

- **Linux Flex Consumption (FC1)**, Node 24, 512 MB, HTTP-Parallelität 4,
  standardmäßig maximal **1** On-Demand-Instanz, keine Always-ready-Instanzen;
- eine eigene User-assigned Managed Identity;
- getrennte Standard-LRS-Storagekonten für Host/Deployment und Spieldaten;
- eine vorab angelegte Table `Dinoinsel`, privaten Deployment-Blobcontainer;
- HTTPS-only/TLS 1.2, keine anonymen Blobs oder Shared-Key-Storagezugriffe;
- exakte CORS-Originliste ohne Credentials, zusätzliche Anwendungskontrolle;
- deaktivierte Publishing-Basisauthentifizierung und keine Monitoring-Ressourcen.

Minimale Rollen der App:

| Rolle | Scope / Begründung |
| --- | --- |
| Storage Table Data Contributor | **Nur** die konkrete `Dinoinsel`-Table im Datenkonto |
| Storage Blob Data Owner | **Nur** das separate Hostkonto; laut Microsoft für Host-Speicher einschließlich Container-/Lease-/Key-Verwaltung erforderlich; deckt auch den Deployment-Blob ab |

Keine Subscription-/Resource-Group-Ownerrolle, kein Storage Account Contributor,
keine Queue-Rolle, keine redundante Blob-Contributor-Zuweisung für die App.
Die optionale Table-Rolle für **Host-Diagnoseereignisse** wird nicht vergeben;
solche Azure-Diagnosen können deshalb Berechtigungswarnungen melden. Das ist
nicht dieselbe Table wie die Spiele-Table.
Storage-Endpunkte sind öffentlich erreichbar, aber niemals anonym autorisiert;
ein VNet/private endpoints sind für diese kleine Vorlage nicht enthalten.

RBAC-Änderungen können bis zu etwa zehn Minuten benötigen. Danach das zuvor lokal
gebaute, fertige Paket über Entra-authentifizierte Azure CLI bereitstellen:

```sh
az functionapp deployment source config-zip \
  --resource-group rg-dinoinsel-friends \
  --name APP-NAME \
  --src .package/dinoinsel-api.zip \
  --build-remote false
```

Dieses Paket enthält bereits `dist/`, `host.json` und ausschließlich
Produktionsabhängigkeiten; hier ist **kein Remote Build** nötig. Nicht den gesamten
Arbeitsordner zippen. Verwendete Laufzeitpakete sind JavaScript; bei späteren
nativen Abhängigkeiten den Paketbau auf passendes Linux umstellen.
Die App-Laufzeit verwendet explizit `ManagedIdentityCredential`, keine
Developer-Login-/Client-Secret-/Shared-Key-Fallbackkette.

Die Vorlage nutzt die Flex-eigenen `functionAppConfig`-Felder. Keine dort veralteten
Settings wie `WEBSITE_RUN_FROM_PACKAGE`, `FUNCTIONS_WORKER_RUNTIME`,
`FUNCTIONS_EXTENSION_VERSION` oder `WEBSITE_NODE_DEFAULT_VERSION` ergänzen.
Der öffentliche Output `apiBaseOrigin` enthält die tatsächlich vergebene
Function-App-Origin. Erst nach separater Implementierung und Prüfung der
Client-Anbindung diesen nichtgeheimen Wert im Spiel konfigurieren; die Konfiguration
allein erzeugt keine API-Aufrufe. Diese Vorlage zielt auf die öffentliche Azure-Cloud.

### 3. Vor Freigabe für Kinder manuell kontrollieren

1. Kostenbudget/Benachrichtigungen, Region, Skalierungsgrenze und IAM prüfen.
2. Im Azure-Portal einen benannten Erwachsenen-Zugriffsschlüssel verwalten;
   ihn nicht mittels `--show-keys` oder URL-Query in Protokolle kopieren.
3. Ein Erwachsenen-Endpunkt ohne/falschen Schlüssel muss vom Azure-Host abgewiesen
   werden. Noch keine private Spielgruppe für diese Prüfung verwenden.
4. Raum anlegen und das echte Browser-Preflight von der erlaubten Pages-Origin
   testen; fremde Origin darf keine lesbare CORS-Antwort erhalten.
5. Mit zwei Testprofilen Join/Replay, beide Zähler, gleichzeitigen Abgleich,
   Ranggleichstand und Fremdprofil-Zugriff ausprobieren.
6. Profil- und Raumlöschung sowie Einladungsrotation/Sperrung testen;
   Testdaten anschließend entfernen.
7. Die noch fehlende Client-Anbindung separat implementieren und prüfen; erst danach
   bewusst Online-Opt-in im Spiel anbieten. Offline-Fortschritte bei Netzwerkfehlern
   behalten; die lokale Bestenliste bleibt unabhängig.

## Kosten: klein geplant, nicht als kostenlos zugesichert

Flex kann auf null skalieren und enthält je nach Angebot/Subscription
On-Demand-Freikontingente. **Das ist keine Kostengarantie.** Zu berücksichtigen
sind unter anderem Ausführungen, GB-Sekunden, Storage-Daten/Transaktionen,
Deployment-/Hostblobs und ausgehender Traffic. Andere Apps können gemeinsame
Freikontingente bereits verbrauchen. Always-ready ist hier aus; aktiviertes
Monitoring, private endpoints oder zusätzliche Dienste können weitere Kosten erzeugen.

Nach aktueller Microsoft-Dokumentation ist eine maximale Flex-Skalierung ab
**1 Instanz** möglich; ältere Beispielvorlagen nennen noch 40. Region/Subscription
vorher prüfen, nicht stillschweigend auf ein größeres Limit hochsetzen.
Auch eine Instanz, Rate-Limits oder Budgetwarnungen sind **kein hartes Geldlimit**:
selbst abgelehnte HTTP-Anfragen können ausgeführt/abgerechnet werden.
Vor einem größeren/public Einsatz sind stärkere Missbrauchsschutzmaßnahmen separat
zu planen und zu bepreisen. Bei Nichtgebrauch Räume löschen und, wenn dauerhaft
nicht mehr benötigt, die **ausschließlich hierfür angelegten** Azure-Ressourcen
bewusst abbauen. Allein das Stoppen der App entfernt keine Storagekosten.

## Dateien, Konfiguration und Teilen

- Produktionsvariablen: `STORAGE_MODE=managed-identity`, `TABLE_ENDPOINT`,
  `TABLE_NAME`, `MANAGED_IDENTITY_CLIENT_ID` und kommasepariertes `ALLOWED_ORIGINS`.
  Die Bicep-Vorlage setzt sie ohne Geheimnisse. Ohne Client-ID wäre eine
  system-assigned Identity nutzbar; die Vorlage verwendet eine eigene
  user-assigned Identity.
- `STORAGE_MODE=azurite` ist nur lokal erlaubt; erkannte Azure-Hostumgebungen
  werden in diesem Modus absichtlich abgewiesen.
- `.gitignore` und `.funcignore` schließen echte lokale Settings, `.env`,
  Emulator-/Testdaten, Dependencies, Builddateien und Pakete aus.
  `local.settings.example.json` und `infra/parameters.example.json` dürfen
  geteilt werden, echte Schlüssel/Einladungen/Spielstände nicht.
- Paketbau arbeitet mit einer **Datei-Allowlist**, nicht mit `zip .`.
  Niemals tatsächliche `local.settings.json`, `.env` oder `.local/` veröffentlichen.
- Die getrennte [API-CI](../.github/workflows/api-ci.yml) führt auf passenden PRs
  mit Node.js 24 nur `npm ci` und `npm run check` aus. Sie hat ausschließlich
  Lesezugriff auf den Quellcode, keine Azure-Anmeldung, Secrets oder Deployments.
  Paketbau und ein Bicep-Compile können später als lokale Prüfungen ergänzt werden.

## Offizielle Quellen

Geprüft am **21. September 2026**; Laufzeit-, Regions- und Preisangaben vor einem
späteren Deployment erneut prüfen.

1. [Unterstützte Azure-Functions-Sprachen](https://learn.microsoft.com/azure/azure-functions/supported-languages):
   Node.js **24 GA**, erwartetes Supportende **30. April 2028**; Node 22 ebenfalls
   unterstützt, aber nicht Ziel dieser Vorlage.
2. [Node.js-Programmiermodell v4](https://learn.microsoft.com/azure/azure-functions/functions-reference-node):
   Code-Registrierung mit `app.http`, Funktionsruntime v4.
3. [Flex Consumption: Runtime, Skalierung, Speicher und Abrechnung](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan).
4. [Flex erstellen, regionale Runtimes prüfen und bereitstellen](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to).
5. [Functions-Infrastruktur als Code](https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code)
   und [veraltete Flex-Einstellungen](https://learn.microsoft.com/azure/azure-functions/functions-app-settings#flex-consumption-plan-deprecations).
6. [Managed-Identity-Verbindungen und minimale Host-Rollen](https://learn.microsoft.com/azure/azure-functions/manage-connections?pivots=functions-auth-identity&tabs=host).
7. [Table Storage mit Microsoft Entra ID](https://learn.microsoft.com/azure/storage/tables/authorize-access-azure-active-directory)
   und [Table-bezogene RBAC-Scopes](https://learn.microsoft.com/azure/storage/tables/assign-azure-role-data-access).
8. [Azure Tables JavaScript SDK](https://learn.microsoft.com/javascript/api/overview/azure/data-tables-readme)
   und [Table-Datenmodell / Property-Limits](https://learn.microsoft.com/rest/api/storageservices/understanding-the-table-service-data-model).
9. [Functions-Zugriffsschlüssel](https://learn.microsoft.com/azure/azure-functions/function-keys-how-to)
   und [CORS-/Sicherheitskonzepte](https://learn.microsoft.com/azure/azure-functions/security-concepts).
10. [Functions-Preise](https://azure.microsoft.com/pricing/details/functions/),
    [Table-Storage-Preise](https://azure.microsoft.com/pricing/details/storage/tables/)
    und [Azure-Budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets).
11. [Azurite-Emulator](https://learn.microsoft.com/azure/storage/common/storage-use-azurite).
