# Angebotsanfragen-Triage

Lokal laufender Prototyp: liest das eigene Gmail-Postfach, erkennt Offert-
anfragen, erfasst sie strukturiert und bereitet einen Antwortentwurf vor.
Die Freigabe macht immer der Mensch.

**Stand: CP1 (Ingest).** Klassifikation, Entwürfe und Digest folgen in CP2–CP4.

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
pnpm auth       # einmalig: Browser-Freigabe, Token nach config/token.json (0600)
```

### Betriebsprofil

`config/profile.yaml` ausfüllen. Alles in `«...»` ist ein Platzhalter und wird
vom Code nicht interpretiert. `preisliste: null` bedeutet ausdrücklich
*keine Preise hinterlegt* — Entwürfe nennen dann nie Zahlen.

## Benutzung

```bash
pnpm ingest --fixtures=fixtures --since=3650d   # ohne Gmail, ohne Netzwerk
pnpm ingest --since=7d                          # gegen das echte Postfach
pnpm ingest --help
```

Gmail-Filter: `is:unread -category:promotions -category:social` plus
Zeitfenster aus `--since` (Default 7 Tage).

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
   `baseUrl: http://localhost:1234/v1` gegen LM Studio. Beide Pfade werden
   gebaut, die Wahl steht in der Config, nicht im Code.
2. **Gmail-Scope.** Es gibt bei Google keinen Scope, der das Anlegen von
   Entwürfen ohne Sendefähigkeit erlaubt: `gmail.compose` (ab CP3 nötig)
   schliesst `messages.send` technisch mit ein. Regel 1 ist deshalb
   **ausschliesslich code-seitig** garantiert — durch einen `DraftSink`-Port
   ohne Sendemethode und durch `tests/no-send.test.ts` — nicht durch Google
   erzwungen. CP1 fordert nur `gmail.readonly` an.

## Projektstruktur

```
src/core/      reine Logik — kennt weder Gmail noch SQLite noch einen Anbieter
src/adapters/  gmail, sqlite, llm, telegram — austauschbar hinter Ports
src/pipeline/  Orchestrierung der Abläufe
src/config/    Zod-validierte YAML-Konfiguration
src/cli/       Einstiegspunkte
prompts/       versionierte Prompt-Dateien (ab CP2)
fixtures/      12 synthetische Beispielmails im Gmail-Format
```

Die Schichtentrennung wird getestet: `core/` darf nichts aus `adapters/`
importieren. Ein späterer Wechsel auf IMAP oder Outlook tauscht nur Adapter.

## Tests

```bash
pnpm test        # 46 Tests, ohne Netzwerk
pnpm typecheck
```

Fixtures neu erzeugen: `pnpm fixtures:build`.
Eigene Mails anonymisieren: `pnpm anonymize roh.json fixtures/13-eigene.json`
(läuft lokal; Ergebnis von Hand gegenlesen).

## Noch nicht gebaut (Phase 1 ausgenommen)

Review-Dashboard, Mandantenfähigkeit, Billing, Auto-Versand, Kalender,
Offert-PDF.

### Später

Thread-Verlauf als LLM-Kontext, Duplikaterkennung, Kostentracking pro Lauf.
