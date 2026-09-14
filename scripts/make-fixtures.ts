/**
 * Erzeugt fixtures/*.json aus den lesbaren Mail-Texten unten.
 * Aufruf: pnpm fixtures:build
 *
 * Die Inhalte sind synthetisch — erfundene Personen, Firmen und Adressen.
 * Fuer echte Mails: scripts/anonymize.ts verwendet dasselbe Zielformat.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fester Anker, damit die Fixtures deterministisch bleiben. */
const ANCHOR = Date.parse('2026-09-14T09:00:00+02:00');
const h = (n: number) => ANCHOR - n * 3_600_000;

const b64 = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Spec {
  file: string;
  id: string;
  thread?: string;
  from: string;
  to?: string;
  subject: string;
  date: number;
  labels?: string[];
  text?: string;
  html?: string;
  attachments?: string[];
}

function build(s: Spec): unknown {
  const headers = [
    { name: 'From', value: s.from },
    { name: 'To', value: s.to ?? 'Betrieb <betrieb@example.ch>' },
    { name: 'Subject', value: s.subject },
    { name: 'Message-ID', value: `<${s.id}@mail.example.com>` },
    { name: 'Date', value: new Date(s.date).toUTCString() },
  ];

  const leaves: unknown[] = [];
  if (s.text) leaves.push({ mimeType: 'text/plain', body: { data: b64(s.text) } });
  if (s.html) leaves.push({ mimeType: 'text/html', body: { data: b64(s.html) } });
  for (const filename of s.attachments ?? []) {
    leaves.push({ mimeType: 'application/pdf', filename, body: { attachmentId: 'att-1' } });
  }

  const payload =
    leaves.length === 1 && s.text && !s.attachments
      ? { mimeType: 'text/plain', headers, body: { data: b64(s.text) } }
      : { mimeType: 'multipart/alternative', headers, parts: leaves };

  return {
    id: s.id,
    threadId: s.thread ?? s.id,
    labelIds: s.labels ?? ['INBOX', 'UNREAD'],
    internalDate: String(s.date),
    payload,
  };
}

const SPECS: Spec[] = [
  // --- 4 klare Anfragen ----------------------------------------------------
  {
    file: '01-klar-renovation.json',
    id: 'fix-01',
    from: 'Martina Rüegg <m.rueegg@example.ch>',
    subject: 'Offerte Renovation Wohnung Emmenbrücke',
    date: h(3),
    text: `Guten Tag

wir möchten unsere 3.5-Zimmer-Wohnung in Emmenbrücke renovieren lassen
und bitten Sie um eine Offerte.

Objekt: Wohnung im 2. OG, Baujahr 1994, ca. 78 m2, aktuell bewohnt.
Gewünschter Zeitraum: Januar bis Februar 2027.
Budgetrahmen: rund 20'000 bis 25'000 Franken.

Erreichbar bin ich unter 041 555 22 11.

Freundliche Grüsse
Martina Rüegg
Seestrasse 12, 6020 Emmenbrücke
m.rueegg@example.ch`,
  },
  {
    file: '02-klar-neubau.json',
    id: 'fix-02',
    from: 'Bauleitung Frey <bauleitung@freybau.example>',
    subject: 'Anfrage Arbeiten Neubau MFH Kriens, Termin KW 6',
    date: h(9),
    text: `Sehr geehrte Damen und Herren

für unseren Neubau in Kriens (MFH, 8 Wohnungen) suchen wir einen Partner.
Ausführung ab KW 6, Dauer ca. drei Wochen.
Die Ausschreibungsunterlagen hängen an.

Bitte melden Sie sich bis Ende Monat, ob Sie Kapazität haben.

Mit freundlichen Grüssen
Thomas Frey
Frey Bau AG
Tel. +41 41 300 10 10`,
    attachments: ['ausschreibung.pdf'],
  },
  {
    file: '03-klar-html.json',
    id: 'fix-03',
    from: '"Sandra Bieri" <sandra.bieri@example.org>',
    subject: 'Kostenvoranschlag gewünscht',
    date: h(20),
    html: `<html><head><style>p{margin:0}</style></head><body>
<p>Guten Tag</p>
<p>k&ouml;nnen Sie mir einen Kostenvoranschlag erstellen f&uuml;r die Arbeiten
an unserem Reihenhaus in Horw?</p>
<ul><li>Fl&auml;che ca. 120 m&sup2;</li><li>Objekt steht leer</li><li>Ausf&uuml;hrung im Fr&uuml;hling</li></ul>
<p>Freundliche Gr&uuml;sse<br>Sandra Bieri<br>079 111 22 33</p>
</body></html>`,
  },
  {
    file: '04-klar-dringend.json',
    id: 'fix-04',
    from: 'Peter Amrein <p.amrein@example.ch>',
    subject: 'DRINGEND - Schaden, brauche heute noch Rückmeldung',
    date: h(1),
    text: `Guten Morgen

bei uns im Haus an der Bahnhofstrasse 4 in Luzern ist heute Nacht ein
Schaden aufgetreten. Wir brauchen so schnell wie möglich jemanden vor Ort,
idealerweise heute noch.

Bitte rufen Sie mich an: 076 444 55 66

Peter Amrein`,
  },

  // --- 3 bewusst vage ------------------------------------------------------
  {
    file: '05-vage-kurz.json',
    id: 'fix-05',
    from: 'j.keller@example.ch',
    subject: 'Anfrage',
    date: h(5),
    text: `Hallo, was würde das ungefähr kosten? Danke`,
  },
  {
    file: '06-vage-ohne-ort.json',
    id: 'fix-06',
    from: 'Nadia Berger <nadia.b@example.net>',
    subject: 'Frage zu Ihren Leistungen',
    date: h(30),
    text: `Guten Tag

wir planen etwas grösseres umzubauen und überlegen, ob Sie so etwas machen.
Zeitlich sind wir flexibel. Können Sie mir sagen, wie Sie da vorgehen?

Danke und Gruss
Nadia`,
  },
  {
    file: '07-vage-thread.json',
    id: 'fix-07',
    thread: 'thread-07',
    from: 'Lukas Odermatt <l.odermatt@example.ch>',
    subject: 'Re: Ihre Anfrage',
    date: h(48),
    text: `Ja genau, so hatte ich das gemeint. Passt das bei Ihnen?

Am 12. September 2026 um 14:03 schrieb Betrieb <betrieb@example.ch>:
> Guten Tag Herr Odermatt
> meinen Sie die Arbeiten im Erdgeschoss oder im ganzen Haus?
>
> Freundliche Grüsse`,
  },

  // --- 2 VIP ---------------------------------------------------------------
  {
    file: '08-vip-stammkunde.json',
    id: 'fix-08',
    from: 'Verwaltung Zentral <kontakt@vip-verwaltung.example>',
    subject: 'Folgeauftrag Liegenschaft Obergrundstrasse',
    date: h(7),
    text: `Guten Tag

wie besprochen möchten wir den Folgeauftrag für die Liegenschaft an der
Obergrundstrasse auslösen. Umfang wie letztes Mal, Ausführung im Oktober.

Bitte um kurze Bestätigung.

--
Regula Hunziker
Verwaltung Zentral AG
Obergrundstrasse 88, 6003 Luzern
+41 41 222 33 44`,
  },
  {
    file: '09-vip-dringend.json',
    id: 'fix-09',
    from: 'R. Hunziker <kontakt@vip-verwaltung.example>',
    subject: 'Kurze Rückfrage Mieterwechsel',
    date: h(26),
    text: `Guten Tag

eine unserer Wohnungen wird per Ende Monat frei. Können Sie vorher noch
vorbeikommen? Es geht nur um eine Einschätzung, nichts Grosses.

Besten Dank
R. Hunziker`,
  },

  // --- 3 Nicht-Anfragen ----------------------------------------------------
  {
    file: '10-nicht-newsletter.json',
    id: 'fix-10',
    from: 'Branchenverband <news@verband.example>',
    subject: 'Newsletter September: Neue Normen und Weiterbildungen',
    date: h(12),
    html: `<html><body><h1>Newsletter September</h1>
<p>Die neuen Normen treten im Januar in Kraft. <a href="https://verband.example/n">Mehr erfahren</a></p>
<p>Abmelden k&ouml;nnen Sie sich <a href="https://verband.example/u">hier</a>.</p>
</body></html>`,
  },
  {
    file: '11-nicht-rechnung.json',
    id: 'fix-11',
    from: 'Debitoren <buchhaltung@lieferant.example>',
    subject: 'Rechnung 2026-4471 fällig',
    date: h(15),
    text: `Sehr geehrte Damen und Herren

anbei die Rechnung 2026-4471 über CHF 1'284.50, fällig per 30 Tage netto.

-----Ursprüngliche Nachricht-----
Von: Debitoren <buchhaltung@lieferant.example>
Gesendet: Montag, 1. September 2026 08:00
An: Betrieb
Betreff: Lieferschein

Anbei der Lieferschein.`,
    attachments: ['rechnung-2026-4471.pdf'],
  },
  {
    file: '12-nicht-bewerbung.json',
    id: 'fix-12',
    from: 'Ali Demir <ali.demir@example.com>',
    subject: 'Initiativbewerbung',
    date: h(40),
    text: `Sehr geehrte Damen und Herren

ich bewerbe mich initiativ bei Ihnen. Meine Unterlagen finden Sie im Anhang.
Über eine Rückmeldung würde ich mich freuen.

Freundliche Grüsse
Ali Demir`,
    attachments: ['lebenslauf.pdf'],
  },
];

const dir = join(process.cwd(), 'fixtures');
mkdirSync(dir, { recursive: true });
for (const spec of SPECS) {
  writeFileSync(join(dir, spec.file), `${JSON.stringify(build(spec), null, 2)}\n`, 'utf8');
}
console.log(`${SPECS.length} Fixtures geschrieben nach ${dir}`);
