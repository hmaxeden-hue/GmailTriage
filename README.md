# Angebotsanfragen-Triage

Lokal laufender Prototyp: liest das eigene Gmail-Postfach, erkennt Offert-
anfragen, erfasst sie strukturiert und bereitet einen Antwortentwurf vor.
Die Freigabe macht immer der Mensch.

**Stand: Phase 1 vollständig** (CP0–CP4).

## Harte Regeln

1. **Niemals senden.** Ausgehende Mails entstehen ausschliesslich als Gmail-
   Entwurf. Kein Code-Pfad ruft `send` auf — abgesichert durch `tests/no-send.test.ts`.
2. **Keine erfundenen Inhalte.** Preise, Termine, Fristen und Zusagen stammen
   ausschliesslich aus `config/profile.yaml`. Fehlt eine Angabe, wird
   zurückgefragt statt geraten.
3. **Dry-Run ist Default.** Ohne `--write` wirkt kein Lauf nach aussen: keine
   Entwürfe, keine Labels, keine Telegram-Nachrichten. Nur SQLite und stdout.
4. **Datenschutz.** E-Mail-Inhalte verlassen den Rechner nur beim LLM-Call.
   Siehe [Externe Endpunkte](#externe-endpunkte).

## Setup

Voraussetzung: Node ≥ 22, pnpm.

```bash
pnpm install
```

### Gmail-Zugang einrichten

1. [Google Cloud Console](https://console.cloud.google.com) → neues Projekt
2. **Gmail API** aktivieren
3. OAuth-Zustimmungsbildschirm: Nutzertyp *Extern*, Status *Test*, die eigene
   Gmail-Adresse als Testnutzer eintragen
4. Anmeldedaten → OAuth-Client-ID → Anwendungstyp **Desktop-App** → JSON laden
5. Ablegen als `config/credentials.json` (steht in `.gitignore`)

```bash
pnpm auth            # nur Lesezugriff (gmail.readonly)
pnpm auth --drafts   # zusätzlich Entwürfe anlegen (gmail.compose)
```

Das Token landet in `config/token.json` (Dateirechte 0600). Wenn du später
`--drafts` nachziehst, lösche die Datei vorher — Google gibt sonst das alte,
engere Token zurück.

### Betriebsprofil

`config/profile.yaml` ausfüllen. Alles in `«...»` ist ein Platzhalter und wird
vom Code nicht interpretiert. `preisliste: null` bedeutet ausdrücklich
*keine Preise hinterlegt* — Entwürfe nennen dann nie Zahlen.

## Benutzung

```bash
pnpm ingest --fixtures=fixtures --since=3650d   # ohne Gmail, ohne Netzwerk
pnpm ingest --since=7d                          # gegen das echte Postfach
pnpm classify --since=7d                        # klassifiziert, was im Ingest liegt
pnpm classify --model=claude-haiku-4-5          # Modell für einen Lauf überschreiben
pnpm classify --reclassify                      # bereits Eingeordnetes neu bewerten
pnpm draft --since=7d                           # Entwurfstexte berechnen, nichts anlegen
pnpm draft --since=7d --write                   # Entwürfe bei Gmail anlegen

pnpm run triage --since=7d                      # der Gesamtlauf, Dry-Run
pnpm run triage --since=7d --write              # mit Entwürfen, Label und Push
pnpm run triage --fixtures=fixtures --since=30d # gegen Beispielmails statt Gmail
```

`pnpm run triage` macht alles in einem: lesen, einordnen, Entwürfe
vorbereiten, Digest schreiben, bei hoher Dringlichkeit pushen.

| Exit-Code | Bedeutung |
|---|---|
| 0 | alles durch |
| 1 | einzelne Mails fehlgeschlagen, der Rest lief |
| 2 | Konfiguration unvollständig (z.B. Platzhalter als Absenderadresse) |
| 3 | Lauf abgebrochen — ungültiger Schlüssel, unbekanntes Modell |

Gmail-Filter: `is:unread -category:promotions -category:social` plus
Zeitfenster aus `--since` (Default 7 Tage).

`pnpm classify` braucht einen Schlüssel in `ANTHROPIC_API_KEY` — oder
`llm.provider: openai-compatible` mit einem lokalen Modell.

### Modellwahl und Kosten

`llm.model` in `config/app.yaml` steht auf `claude-opus-5`. Überschlag pro
Mail: rund 1 500 Eingabe- und 300 Ausgabe-Token, also grob 1,5 Rappen. Bei
30 Mails am Tag sind das etwa 13 Franken im Monat, mit Prompt-Caching weniger.
`claude-haiku-4-5` kostet etwa ein Fünftel davon und reicht für einfache
Einordnung womöglich aus — das ist eine Messfrage, keine Annahme. Der Wechsel
ist eine Zeile in der Config oder ein `--model=`-Argument.

## Datenfluss

```
  Gmail API                 config/profile.yaml
  (gmail.readonly)          config/app.yaml
        │                          │
        ▼                          ▼
  ┌───────────────┐        ┌───────────────┐
  │    Ingest     │        │  Ausschluss-  │   Lieferanten, Buchhaltung:
  │ HTML→Text     │───────►│    prüfung    │──►  raus, bevor ein LLM-Call
  │ Zitate raus   │        └───────┬───────┘     entsteht
  │ Signatur ab   │                │
  └───────┬───────┘                ▼
          │              ┌─────────────────────┐
          │              │   LlmClient         │  ← einziger Weg nach draussen,
          │              │   anthropic │ lokal │    siehe Endpunkttabelle
          │              └─────────┬───────────┘
          │                        ▼
          │              ┌─────────────────────┐
          │              │ Zod .strict()       │  Bruch → 1 Repair-Versuch
          │              │ + VIP-Override      │  → sonst Fallback-Datensatz
          │              └─────────┬───────────┘
          ▼                        ▼
  ┌──────────────────────────────────────────┐
  │            data/triage.db                │   messages · triage_results
  │         (alles, immer, lokal)            │   drafts · notifications · runs
  └───┬──────────────┬───────────────┬───────┘
      │              │               │
      ▼              ▼               ▼
  Entwurfstext   out/digest-     Telegram
  aus Profil +   YYYY-MM-DD.md   (Flag, Default aus)
  missing_fields      │               │
      │               │               │
      ▼               ▼               ▼
  ╔═══════════════════════════════════════╗
  ║  nur mit --write                      ║   Gmail-Entwurf · Label · Push
  ║  Versendet wird nie etwas.            ║
  ╚═══════════════════════════════════════╝
```

Ohne `--write` endet jeder Pfad an der SQLite-Grenze — ausser dem LLM-Call,
siehe Konflikt 1 unten.

## Externe Endpunkte

| Endpunkt | Wofür | Übertragene Daten | Betreiber / Standort |
|---|---|---|---|
| `gmail.googleapis.com` | Mails lesen (CP1), Entwurf anlegen (CP3) | OAuth-Token, Mail-IDs, Mail-Inhalte | Google Ireland Ltd. / Google LLC, EU + USA |
| `accounts.google.com`, `oauth2.googleapis.com` | einmalige OAuth-Freigabe, Token-Refresh | Client-ID, Autorisierungscode | dieselben |
| `api.anthropic.com` | Klassifikation und Extraktion (ab CP2) | **vollständiger Mail-Text** inkl. Absenderdaten | Anthropic PBC, USA |
| `api.telegram.org` | Push bei `urgency=hoch` | Absendername, Betreff, fehlende Angaben — **kein Mailtext** | Telegram FZ-LLC; Serverstandort vor Aktivierung selbst prüfen. Default: aus |

### Markierte Konflikte

Zwei Stellen widersprechen dem Anspruch „local-first". Sie werden hier
benannt statt geglättet:

1. **LLM-Call.** Mit `llm.provider: anthropic` (aktueller Default in
   `config/app.yaml`) verlassen vollständige Mail-Inhalte den Rechner Richtung
   USA. Wirklich lokal läuft nur `llm.provider: openai-compatible` mit
   `baseUrl: http://localhost:1234/v1` gegen LM Studio. Beide Pfade sind
   gebaut, die Wahl steht in der Config, nicht im Code.
   **Auch der Dry-Run sendet.** Regel 3 sagt „ohne `--write` wirkt kein Lauf
   nach aussen"; Regel 4 erlaubt den LLM-Call ausdrücklich. Beides zusammen
   heisst: `pnpm classify` überträgt Mailtexte auch ohne `--write`. Der Lauf
   sagt das vor dem ersten Call auf stdout an. Wer das nicht will, stellt auf
   den lokalen Anbieter um.
2. **Temperatur 0.1.** Die Vorgabe lässt sich mit `claude-opus-5` nicht
   erfüllen: Anthropic hat die Sampling-Parameter ab der 4.7-Generation
   entfernt, `temperature` wird dort mit HTTP 400 abgelehnt. Der Adapter
   reicht den Wert nur an Modelle weiter, die ihn noch annehmen — etwa
   `claude-haiku-4-5` oder ein lokales Qwen (`supportsTemperature()` in
   `src/adapters/llm/anthropic.ts`). Die Reproduzierbarkeit hängt bei den
   neueren Modellen am Schema und am Prompt, nicht an einem Sampling-Wert.
   `llm.effort: low` hält die Denktiefe und damit die Streuung tief.

3. **Gmail-Scope.** Es gibt bei Google keinen Scope, der das Anlegen von
   Entwürfen ohne Sendefähigkeit erlaubt: `gmail.compose` schliesst die
   Sendefähigkeit technisch mit ein. Regel 1 ist deshalb **ausschliesslich
   code-seitig** garantiert — durch einen `DraftSink`-Port ohne Sendemethode
   und durch `tests/no-send.test.ts`, das den ganzen Quelltext danach absucht
   — nicht durch Google erzwungen. Angefordert wird nur, was der Lauf
   braucht: `pnpm ingest` kommt mit `gmail.readonly` aus.

4. **Label-Scope.** Ein Label an eine Mail zu hängen geht nur über
   `users.messages.modify` und damit über den Scope `gmail.modify`, der
   deutlich breiter ist als `gmail.compose`. Deshalb steht `gmail.label` in
   `config/app.yaml` auf `null`: ohne ausdrückliche Konfiguration wird der
   Scope nie angefordert und kein Label gesetzt.

## Projektstruktur

```
src/core/      reine Logik — kennt weder Gmail noch SQLite noch einen Anbieter
src/adapters/  gmail, sqlite, llm, telegram — austauschbar hinter Ports
src/pipeline/  Orchestrierung der Abläufe
src/config/    Zod-validierte YAML-Konfiguration
src/cli/       Einstiegspunkte
prompts/       versionierte Prompt-Dateien, Version wandert in jeden Datensatz
fixtures/      12 synthetische Beispielmails im Gmail-Format
```

### Antwortentwürfe

Der Entwurfstext entsteht ohne Modell — aus `profile.yaml` und den
`missing_fields` der Triage. Damit kann dort per Konstruktion kein
halluzinierter Preis stehen.

| Lage | Entwurf |
|---|---|
| `missing_fields` nicht leer | Rückfrage, die genau diese Angaben abfragt |
| nichts fehlt | Eingangsbestätigung ohne zugesagten Zeitpunkt |
| `classification: sonstiges` | kein Entwurf |

Getestet wird das negativ: der Text enthält keine Ziffer, keine Währung und
kein Fristwort (`innerhalb`, `spätestens`, `garantiert`, …). `anrede` und
`signatur` in `profile.yaml` steuern Ansprache und Abschluss; ein
Kapazitätshinweis wird nur übernommen, wenn er dort steht und kein
unausgefüllter Platzhalter ist.

**Idempotenz:** `drafts.message_id` ist Primärschlüssel. Ein zweiter Lauf
findet die Zeile und legt nichts Neues an — auch nicht nach drei Läufen. Ein
Dry-Run-Eintrag wird beim späteren `--write` auf den echten Entwurf
nachgezogen, ohne eine zweite Zeile zu erzeugen.

### Tagesdigest

Geht auf stdout und nach `out/digest-YYYY-MM-DD.md`. Sortiert nach
Dringlichkeit, je Eintrag zwei Zeilen:

```markdown
## Dringend

**Peter Amrein** — DRINGEND - Schaden, brauche heute noch Rückmeldung · 14.09., 08:00
Schadensbehebung · Bahnhofstrasse 4, Luzern · heute noch · fehlt: leistung, objektangaben · Entwurf berechnet (Rückfrage)
```

`sonstiges` erscheint nur als Zähler in der Kopfzeile. Bricht ein Lauf ab,
bevor etwas vorliegt, wird die Datei des Tages **nicht** durch eine leere
ersetzt.

### Telegram-Push

Nur bei `urgency: hoch`, nur mit `--write`, nur wenn `telegram.enabled: true`
und `TELEGRAM_BOT_TOKEN` sowie `telegram.chatId` gesetzt sind. Fehlt eines
davon, bleibt der Push stumm und der Lauf sagt warum — ein halb
konfigurierter Push wäre ein stiller Ausfall. Pro Mail geht höchstens eine
Nachricht hinaus (`notifications` mit Primärschlüssel aus Message-ID und
Kanal).

### Umgang mit Modellfehlern

| Fall | Verhalten |
|---|---|
| Antwort verletzt das Schema | genau ein Repair-Versuch mit den konkreten Zod-Fehlern |
| auch der Repair scheitert | Datensatz mit `confidence: 0` und `reasoning: schema_error: …` — die Mail bleibt sichtbar |
| Modell erfindet ein Feld (z.B. einen Preis) | `.strict()` bricht die Validierung, Repair greift |
| einzelner Netzwerkfehler | betrifft nur diese Mail, der Lauf geht weiter |
| ungültiger Schlüssel, unbekanntes Modell | Lauf bricht nach dem ersten Call ab statt N-mal anzuklopfen |
| Modell lehnt eine Mail ab | serverseitiger Ausweichpfad (`refusalFallback`), sonst Fallback-Datensatz |

Die Schichtentrennung wird getestet: `core/` darf nichts aus `adapters/`
importieren. Ein späterer Wechsel auf IMAP oder Outlook tauscht nur Adapter.

## Tests

```bash
pnpm test        # 174 Tests, ohne Netzwerk
pnpm typecheck
```

Die Suite fixiert `TZ=Europe/Zurich` — der Digest formatiert in Ortszeit,
sonst hingen die Erwartungen an der Zone des ausführenden Rechners.

Die Tests prüfen die Verdrahtung — Schema, Repair-Pfad, VIP-Override,
Idempotenz, Persistenz —, nicht die Urteilsqualität eines Modells. Dafür
braucht es einen Lauf gegen echte Mails.

Fixtures neu erzeugen: `pnpm fixtures:build`.
Eigene Mails anonymisieren: `pnpm anonymize roh.json fixtures/13-eigene.json`
(läuft lokal; Ergebnis von Hand gegenlesen).

## Phase 2

Phase 1 läuft gegen ein einziges Postfach und legt Entwürfe an, die ein
Mensch freigibt. Was danach ansteht, in der Reihenfolge, in der es sich
gegenseitig bedingt:

**Zuerst messen, dann bauen.** Ein Lauf über echte Post zeigt, ob die
Einordnung trifft. Ohne diese Zahl ist jede weitere Entscheidung geraten —
auch die, ob ein günstigeres Modell reicht. Dafür braucht es eine kleine
Eval-Sammlung aus eigenen, anonymisierten Mails (`pnpm anonymize`) mit
hinterlegtem Sollergebnis.

**Review-Dashboard (SvelteKit).** Entwürfe durchsehen, bearbeiten, freigeben
— ohne Umweg über die Gmail-Oberfläche. Der Grund, warum es Phase 2 ist und
nicht Phase 1: solange die Trefferquote unbekannt ist, wäre es eine
Oberfläche für ein ungelöstes Problem.

**Mandantenfähigkeit.** Mehrere Betriebe mit je eigenem Profil, eigenem
Token und getrennten Daten. Betrifft das Datenmodell an der Wurzel — jede
Tabelle braucht einen Mandantenschlüssel — und die OAuth-Führung, weil
Google für fremde Postfächer eine verifizierte App verlangt. Das ist der
grösste Brocken.

**Billing.** Erst sinnvoll, wenn Mandantenfähigkeit steht.

**Kalenderanbindung.** Freie Termine kennen, statt nach dem Zeitraum zu
fragen. Berührt Regel 2 unmittelbar: sobald echte Verfügbarkeiten vorliegen,
darf der Entwurf sie nennen — das muss sauber von "erfundenen" Terminen
getrennt bleiben.

**Offert-PDF.** Setzt hinterlegte Preise voraus. Solange `preisliste: null`
ist, gibt es nichts zu rechnen.

### Kleineres, unabhängig davon machbar

- Thread-Verlauf als LLM-Kontext statt nur der jüngsten Mail
- `output_config.format` für schemagarantierte Antworten statt Repair-Versuch
- Kostentracking pro Lauf (die `runs`-Tabelle hat den Platz schon)
- Duplikaterkennung über `body_hash`
- Anhänge auswerten statt nur ihre Dateinamen zu kennen

### Bleibt auch in Phase 2 ausgeschlossen

Automatischer Versand. Die Freigabe macht der Mensch — das ist keine
Reifestufe, sondern die Grundannahme des Produkts.
