# Dinoinsel

Ein freundliches Dino-Abenteuer auf Deutsch, für Kinder ab etwa sieben Jahren. Sechs wählbare Dinos, eigene Zeichnungen, keine Werbung, Käufe oder Konten.

**[Im Browser spielen](https://SandraAhlgrimm.github.io/Dinoinsel/)** · **[Android-APK herunterladen](https://github.com/SandraAhlgrimm/Dinoinsel/releases/download/v1.0.0-preview/Dinoinsel.apk)** · **[Release und Hinweise](https://github.com/SandraAhlgrimm/Dinoinsel/releases/tag/v1.0.0-preview)**

Die Android-Vorschau **1.0** ist ein früherer Stand: Die neue lokale Bestenliste und die geplanten Mathepausen der Webversion sind **noch nicht in dieser APK**. Die APK gehört in die Release-Downloads, nicht in den Quellcode. Die App benötigt Android 8.0 oder neuer und ein aktuelles Android System WebView. Über eine Installation und eventuelle Sicherheitswarnungen entscheidet eine erwachsene Gerätebesitzerin oder ein erwachsener Gerätebesitzer.

## Spielen und Punkte

Links laufen, rechts **Essen** oder **Schubsen**. Pflanzenfresser mögen Büsche; Fleischfresser fressen nur kleinere Dinos. Jede Mahlzeit macht den eigenen Dino größer und stärker. Andere Dinos fressen selbstständig. Bäume und Steine lassen sich mit genügend Kraft beseitigen. Der Vulkan bleibt immer erloschen, der eigene Dino wird nicht angegriffen. Die Entdecker-Aufgaben sind freiwillig; danach geht das Spiel weiter.

**Meine Bestenliste** ist auf der Startseite, im Spiel und in der Pause erreichbar. Sie enthält die sechs eigenen Dinos, keine erfundenen Mitspieler: eine Mahlzeit gibt einen Futterpunkt, eine richtig gelöste Matheaufgabe einen Mathepunkt. Mathe folgt in einem nächsten Schritt; ihre Punkte starten bei null. Gesamtpunkte sind Futter- plus Mathepunkte. Gleichstände folgen der festen Dino-Auswahlreihenfolge.

**Nur auf diesem Gerät — noch keine gemeinsame Online-Bestenliste.** Es gibt keine API-Aufrufe, Telemetrie oder externen Laufzeitressourcen. `leaderboardApiUrl` in `game/index.html` ist leer und wird nicht aufgerufen. Bestehende Spielstände werden unter demselben Schlüssel `dino-insel-v1` weiterverwendet und um fehlende Punktefelder ergänzt.

Fortschritt wird nur lokal gespeichert. Browser und Android-App haben getrennte Spielstände; gelöschte Browser-/App-Daten gehen verloren. Speicherfehler werden sichtbar gemeldet, beschädigte Spielstände nicht überschrieben. Die geladene Webseite läuft ohne weitere Internetverbindung; für einen garantiert offline möglichen Neustart `game/index.html` lokal speichern oder die gebündelte Android-App verwenden. GitHub Pages muss beim ersten Aufruf erreichbar sein.

Tastatur: Pfeile/WASD laufen, E/Leertaste essen, F schubsen, Esc Pause/zurück. Auf Tablets sind Laufen und Essen gleichzeitig mit zwei Fingern möglich. Ton ist anfangs aus.

## Quellcode und Entwicklung

`game/index.html` enthält das gesamte Spiel samt reinem `DinoCore`-Regelmodell. `tests/` prüft die unveränderten eingebetteten Skripte, die nativen Lifecycle-Hooks und Tablet-Bedienung. `android/` enthält zunächst die unveränderte native 1.0-Baseline; eine aktualisierte Android-Bauanleitung und Version folgen getrennt. Paketkennung `de.dinoinsel.game` und Speicherkennung bleiben für Updates stabil.

Mit Node.js 22 oder neuer:

```sh
cd tests
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Unter macOS wird vorhandenes Google Chrome genutzt, sonst Playwright-Chromium. `CHROME_PATH` kann einen vorhandenen Browser explizit wählen. CI installiert Chromium inklusive Linux-Systembibliotheken. Die GitHub-Actions-Pipeline prüft das Spiel vor der Veröffentlichung und lädt **ausschließlich `game/`** als Pages-Artefakt hoch. Weder native Quellen, Tests, Schlüssel noch Konfigurationen für einen Server werden als Website veröffentlicht.

## Lizenz

Für den eigenen Quellcode und die eigenen Zeichnungen wurde **noch keine Open-Source-Lizenz ausgewählt**. Die öffentliche Sichtbarkeit allein erteilt keine pauschale Lizenz. Abhängigkeiten und Build-Werkzeuge behalten ihre jeweiligen Lizenzen; die Android-Baseline dokumentiert deren Herkunft unter `android/BUILDING.md`.
