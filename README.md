# Dinoinsel

Ein freundliches Dino-Abenteuer auf Deutsch, für Kinder ab etwa sieben Jahren. Sechs wählbare Dinos, eigene Zeichnungen, keine Werbung, Käufe oder Konten.

**[Im Browser spielen](https://SandraAhlgrimm.github.io/Dinoinsel/)** · **[Android-APK herunterladen](https://github.com/SandraAhlgrimm/Dinoinsel/releases/download/v1.2.0-preview/Dinoinsel.apk)** · **[Release und Hinweise](https://github.com/SandraAhlgrimm/Dinoinsel/releases/tag/v1.2.0-preview)**

Die Android-Vorschau **1.2** heißt ebenfalls **Dinoinsel** und enthält jetzt die lokale Bestenliste und die verpflichtenden Mathepausen der Webversion. Sie läuft offline ohne Netzwerkberechtigung; eine gemeinsame Cloud-Bestenliste ist nicht enthalten. Die APK gehört in die Release-Downloads, nicht in den Quellcode. Die App benötigt Android 8.0 oder neuer und ein aktuelles Android System WebView. Über eine Installation und eventuelle Sicherheitswarnungen entscheidet eine erwachsene Gerätebesitzerin oder ein erwachsener Gerätebesitzer. **Ein Funktionstest auf einem echten Android-Gerät steht noch aus.**

**Update von 1.0:** Die neue APK über die vorhandene App installieren. Paketkennung und Signaturschlüssel sind unverändert. **Nicht vorher deinstallieren oder App-Daten löschen**, wenn der lokale Spielstand erhalten bleiben soll.

## Spielen und Punkte

Links laufen, rechts **Essen** oder **Schubsen**. Pflanzenfresser mögen Büsche; Fleischfresser fressen nur kleinere Dinos. Jede Mahlzeit macht den eigenen Dino größer und stärker. Andere Dinos fressen selbstständig. Bäume und Steine lassen sich mit genügend Kraft beseitigen. Der Vulkan bleibt immer erloschen, der eigene Dino wird nicht angegriffen. Die Entdecker-Aufgaben sind freiwillig; danach geht das Spiel weiter.

**Meine Bestenliste** ist auf der Startseite, im Spiel und in der Pause erreichbar. Sie enthält die sechs eigenen Dinos, keine erfundenen Mitspieler: eine Mahlzeit gibt einen Futterpunkt, eine richtig gelöste Matheaufgabe genau einen Mathepunkt. Gesamtpunkte sind Futter- plus Mathepunkte. Gleichstände folgen der festen Dino-Auswahlreihenfolge. Mathepunkte ändern weder Wachstum noch Kraft.

## Kleine Mathepausen

Nach **vier eigenen Mahlzeiten oder 90 Sekunden aktiver Spielzeit** wartet die ganze Insel auf eine kurze Plus- oder Minusaufgabe. Menüs, Hintergrund, Pause, Hilfe, Bestenliste und die Mathepause selbst zählen nicht als Spielzeit. Auch alle anderen Dinos und die Physik stehen während einer offenen Aufgabe still.

Genau vier von je fünf Aufgaben bleiben mit beiden Zahlen und dem Ergebnis im Bereich **0 bis 20**. Die fünfte enthält tatsächlich eine Zahl über 20, höchstens 100. Es gibt keine negativen Ergebnisse, Multiplikation, Zeitlimits oder Punktabzüge. Große Zahlentasten, die Tastatur (Ziffern, Enter, Rücktaste/Entf) und freiwillige Tipps helfen; „Schritt für Schritt“ zeigt auch die Lösung.

Nach der richtigen Antwort gibt es Zuspruch und eine ausdrückliche Schaltfläche **Weiter auf die Insel**. Erst dann geht das Spiel weiter und beginnt das nächste Intervall. In der Pause ist zusätzlich **Mathe üben** möglich. Offene Aufgaben, Eingabe, Versuche, Hinweise und bereits vergebene Belohnungen werden gespeichert. Pause, Zurück, Dino-Wechsel oder Neustart überspringen keine Aufgabe und vergeben keine doppelten Punkte. Nach einem Dino-Wechsel zählt der Mathepunkt weiterhin für den Dino, mit dem die Aufgabe begonnen wurde. Über **Pause / nach Hause** lässt sich das Spiel jederzeit verlassen; beim Weiterspielen wartet dieselbe Aufgabe.

**Nur auf diesem Gerät — noch keine gemeinsame Online-Bestenliste.** Es gibt keine API-Aufrufe, Telemetrie oder externen Laufzeitressourcen. `leaderboardApiUrl` in `game/index.html` ist leer und wird nicht aufgerufen. Bestehende Spielstände werden unter demselben Schlüssel `dino-insel-v1` auf Formatversion 2 erweitert, ohne alte Größe, Kraft oder Punkte zu löschen. Alte Mahlzeiten lösen nicht rückwirkend neue Aufgaben aus. Der Gesamtzähler `stats.mathSolved` und die Dino-Zähler sind für spätere gemeinsame Punkte verfügbar; eine gemeinsame Online-Liste wird hier noch nicht umgesetzt.

Fortschritt wird nur lokal gespeichert. Browser und Android-App haben getrennte Spielstände; gelöschte Browser-/App-Daten gehen verloren. Speicherfehler werden sichtbar gemeldet, beschädigte Spielstände nicht überschrieben. Die geladene Webseite läuft ohne weitere Internetverbindung; für einen garantiert offline möglichen Neustart `game/index.html` lokal speichern oder die gebündelte Android-App verwenden. GitHub Pages muss beim ersten Aufruf erreichbar sein.

Tastatur: Pfeile/WASD laufen, E/Leertaste essen, F schubsen, Esc Pause/zurück. Auf Tablets sind Laufen und Essen gleichzeitig mit zwei Fingern möglich. Ton ist anfangs aus.

## Quellcode und Entwicklung

`game/index.html` enthält das gesamte Spiel samt reinem `DinoCore`-Regelmodell: Aufgaben erzeugen, Spielzeit planen, Antworten prüfen, Punkte verbuchen und Spielstände migrieren sind unabhängig vom DOM prüfbar. `tests/core.test.cjs`, `tests/math.test.cjs` und `tests/native-shell.test.cjs` prüfen Spielregeln, 10.000 Aufgaben und native Lifecycle-Hooks. `tests/browser.test.cjs` und `tests/math-browser.test.cjs` prüfen reale Touch-/Tastaturbedienung, beide Tabletgrößen, Offline-Nutzung und Speicher-/Pause-/Zurück-Wege. Gestellte Spielstände liegen nur als Testfixtures unter `tests/fixtures/`; das Spiel enthält keine Cheat-Schnittstelle.

`android/` enthält die nativen Quellen der Version **1.2**; die Bauanleitung steht in [`android/BUILDING.md`](android/BUILDING.md). Paketkennung `de.dinoinsel.game`, Speicherkennung sowie `window.dinoApp.pause()` und `.handleBack()` bleiben für Updates stabil. `snapshot()` liefert ausschließlich lesende Diagnosedaten.

Unter [`api/`](api/README.md) liegt **nur vorbereiteter Backend-Quellcode** für eine spätere freiwillige Online-Erweiterung. Der Dienst ist **nicht in Azure bereitgestellt und nicht mit dem aktuellen Spiel verbunden**; eine Client-Anbindung fehlt noch. Ein Konfigurationseintrag allein aktiviert sie nicht. Die Webversion und APK **1.2 behalten ausschließlich lokale Bestenlisten**.

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

Für den eigenen Quellcode und die eigenen Zeichnungen wurde **noch keine Open-Source-Lizenz ausgewählt**. Die öffentliche Sichtbarkeit allein erteilt keine pauschale Lizenz. Abhängigkeiten und Build-Werkzeuge behalten ihre jeweiligen Lizenzen; die Android-Bauanleitung dokumentiert deren Herkunft unter `android/BUILDING.md`.
