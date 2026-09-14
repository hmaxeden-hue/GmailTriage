# Angebotsanfragen-Triage

Lokal laufender Prototyp: liest das eigene Gmail-Postfach, erkennt Offert-
anfragen, erfasst sie strukturiert und bereitet einen Antwortentwurf vor.
Die Freigabe macht immer der Mensch.

**Stand: CP3 (Entwürfe).** Digest und Gesamt-CLI folgen in CP4.

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
```

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
                        ┌─────────────────────────────────────┐
   Gmail API            │            CP1 — Ingest             │
   (read-only)  ──────► │  list → get → normalize → SQLite    │
                        │  HTML→Text, Zitate, Signatur        │
                        └──────────────┬──────────────────────┘
                                       │  messages
                                       ▼
   config/profile.yaml ─────►  ┌───────────────┐
   config/app.yaml             │  data/triage  │
                               │     .db       │
                               └───┬───────────┘
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        │ CP2 — Klassifikation     │ CP3 — Entwurf             │ CP4 — Digest
        │                          ▼                           ▼
        │  LlmClient ──► Zod ──► triage_results ──► Gmail-Draft ──► out/digest-*.md
        │  (extern!)     Repair                     (nie senden)    Telegram (Flag, aus)
        └───────────────────────────────────────────────────────────────────────────┘
```

Ohne `--write` endet jeder Pfad an der SQLite-Grenze.

## Externe Endpunkte

| Endpunkt | Wofür | Übertragene Daten | Betreiber / Standort |
|---|---|---|---|
| `gmail.googleapis.com` | Mails lesen (CP1), Entwurf anlegen (CP3) | OAuth-Token, Mail-IDs, Mail-Inhalte | Google Ireland Ltd. / Google LLC, EU + USA |
| `accounts.google.com`, `oauth2.googleapis.com` | einmalige OAuth-Freigabe, Token-Refresh | Client-ID, Autorisierungscode | dieselben |
| `api.anthropic.com` | Klassifikation und Extraktion (ab CP2) | **vollständiger Mail-Text** inkl. Absenderdaten | Anthropic PBC, USA |
| `api.telegram.org` | Push bei `urgency=hoch` (ab CP4) | Betreff, Absendername, Dringlichkeit | Telegram FZ-LLC; Serverstandort vor Aktivierung selbst prüfen. Default: aus |

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
pnpm test        # 143 Tests, ohne Netzwerk
pnpm typecheck
```

Die Tests prüfen die Verdrahtung — Schema, Repair-Pfad, VIP-Override,
Idempotenz, Persistenz —, nicht die Urteilsqualität eines Modells. Dafür
braucht es einen Lauf gegen echte Mails.

Fixtures neu erzeugen: `pnpm fixtures:build`.
Eigene Mails anonymisieren: `pnpm anonymize roh.json fixtures/13-eigene.json`
(läuft lokal; Ergebnis von Hand gegenlesen).

## Noch nicht gebaut (Phase 1 ausgenommen)

Review-Dashboard, Mandantenfähigkeit, Billing, Auto-Versand, Kalender,
Offert-PDF.

### Später

Thread-Verlauf als LLM-Kontext, Duplikaterkennung, Kostentracking pro Lauf,
`output_config.format` für schemagarantierte Antworten statt Repair-Versuch.
