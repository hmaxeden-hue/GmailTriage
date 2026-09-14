/**
 * Zieht eine echte Gmail-Antwort ins Fixture-Format und ersetzt dabei
 * personenbezogene Daten. Laeuft rein lokal, ohne Netzwerk.
 *
 *   pnpm anonymize roh.json fixtures/13-eigene.json
 *
 * Die Ersetzungen sind konsistent innerhalb einer Datei: dieselbe Adresse
 * wird ueberall zur selben Pseudoadresse. Kontrolliere das Ergebnis trotzdem
 * von Hand — eine Heuristik erkennt nicht jeden Namen.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Aufruf: pnpm anonymize <eingabe.json> <ausgabe.json>');
  process.exit(2);
}

const dec = (d: string) => Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const enc = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const emails = new Map<string, string>();
function pseudoEmail(addr: string): string {
  const key = addr.toLowerCase();
  let hit = emails.get(key);
  if (!hit) {
    hit = `person${emails.size + 1}@example.ch`;
    emails.set(key, hit);
  }
  return hit;
}

const names = new Map<string, string>();
function pseudoName(name: string): string {
  const key = name.toLowerCase();
  let hit = names.get(key);
  if (!hit) {
    hit = `Vorname${names.size + 1} Nachname${names.size + 1}`;
    names.set(key, hit);
  }
  return hit;
}

function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, (m) => pseudoEmail(m))
    .replace(/(?:\+\d{2}\s?)?\(?0?\d{2}\)?[\s./-]?\d{3}[\s./-]?\d{2}[\s./-]?\d{2}/g, '041 555 00 00')
    .replace(/\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}(?:[\s]?[\dA-Z]{4}){2,4}\b/g, 'CH00 0000 0000 0000 0000 0')
    .replace(/\b(CH|DE|AT)?-?\d{4,5}\s+[A-ZÄÖÜ][\wäöüß-]+/g, '6000 Musterort')
    .replace(/\b[A-ZÄÖÜ][\wäöüß-]*(?:strasse|straße|weg|gasse|platz|allee)\s+\d+[a-z]?\b/gi, 'Musterweg 1');
}

function walk(part: Record<string, any>): void {
  if (part.headers) {
    for (const h of part.headers) {
      const name = String(h.name).toLowerCase();
      if (name === 'from' || name === 'to' || name === 'cc' || name === 'reply-to') {
        h.value = String(h.value).replace(/^\s*(.*?)\s*<([^>]+)>\s*$/, (_m, disp: string, addr: string) => {
          const clean = disp.replace(/^["']|["']$/g, '').trim();
          return `${clean ? `${pseudoName(clean)} ` : ''}<${pseudoEmail(addr)}>`;
        });
        if (!h.value.includes('<')) h.value = pseudoEmail(h.value.trim());
      }
      if (name === 'message-id') h.value = '<anon@mail.example.com>';
    }
  }
  if (part.body?.data) part.body.data = enc(scrub(dec(part.body.data)));
  if (part.filename) part.filename = part.filename.replace(/^[^.]+/, 'anhang');
  for (const child of part.parts ?? []) walk(child);
}

const msg = JSON.parse(readFileSync(inPath, 'utf8')) as Record<string, any>;
msg.id = `anon-${Date.now().toString(36)}`;
msg.threadId = msg.id;
msg.snippet = undefined;
if (msg.payload) walk(msg.payload);

// Namen, die nur im Fliesstext auftauchen, nach der Header-Runde nachziehen.
const serialized = JSON.stringify(msg, null, 2);
writeFileSync(outPath, `${serialized}\n`, 'utf8');
console.log(
  `Geschrieben: ${outPath}\n` +
    `${emails.size} Adressen, ${names.size} Namen ersetzt. Bitte von Hand gegenlesen.`,
);
