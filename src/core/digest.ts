import type { DraftRecord, NormalizedMessage, TriageRecord } from './types.js';

/**
 * Tagesdigest als Markdown. Reine Funktion — die Ausgabe haengt nur von den
 * uebergebenen Daten ab, nicht von der Uhr oder vom Dateisystem.
 */

export interface DigestItem {
  message: NormalizedMessage;
  triage: TriageRecord;
  draft: DraftRecord | null;
}

const ORDER: Record<TriageRecord['urgency'], number> = { hoch: 0, normal: 1, niedrig: 2 };
const TITLES: Record<TriageRecord['urgency'], string> = {
  hoch: 'Dringend',
  normal: 'Normal',
  niedrig: 'Ohne Eile',
};

const DATE = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit' });
const DATE_FULL = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const TIME = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });

/** YYYY-MM-DD in Ortszeit — für den Dateinamen. */
export function digestDateStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function digestFilename(date: Date): string {
  return `digest-${digestDateStamp(date)}.md`;
}

function sortItems(items: DigestItem[]): DigestItem[] {
  return [...items].sort((a, b) => {
    const byUrgency = ORDER[a.triage.urgency] - ORDER[b.triage.urgency];
    return byUrgency !== 0 ? byUrgency : b.message.internalDate - a.message.internalDate;
  });
}

/** Zweite Zeile: was bekannt ist, was fehlt, was an Entwurf bereitliegt. */
function detailLine(item: DigestItem): string {
  const parts: string[] = [];

  const known = [item.triage.service, item.triage.location, item.triage.desiredDate].filter(
    (v): v is string => v !== null,
  );
  parts.push(known.length ? known.join(' · ') : 'keine Angaben extrahiert');

  if (item.triage.missingFields.length) {
    parts.push(`fehlt: ${item.triage.missingFields.join(', ')}`);
  }

  if (item.draft) {
    const kind = item.draft.kind === 'rueckfrage' ? 'Rückfrage' : 'Eingangsbestätigung';
    parts.push(item.draft.dryRun ? `Entwurf berechnet (${kind})` : `Entwurf liegt bereit (${kind})`);
  } else {
    parts.push('kein Entwurf');
  }

  if (item.triage.urgencySource === 'vip_override') parts.push('VIP');
  if (item.triage.confidence < 0.5) {
    parts.push(`unsicher (${item.triage.confidence.toFixed(2)})`);
  }

  return parts.join(' · ');
}

export function renderDigest(
  items: DigestItem[],
  opts: { date: Date; sonstige: number },
): string {
  // sonstiges gehoert nicht in die Durchsicht — nur in die Kopfzeile.
  const relevant = items.filter((i) => i.triage.classification !== 'sonstiges');
  const lines: string[] = [`# Tagesdigest ${DATE_FULL.format(opts.date)}`, ''];

  const anfragen = relevant.filter((i) => i.triage.classification === 'offertanfrage').length;
  const bestand = relevant.length - anfragen;
  const entwuerfe = relevant.filter((i) => i.draft !== null).length;

  lines.push(
    `${anfragen} Offertanfragen, ${bestand} von Bestandskunden, ${opts.sonstige} sonstige. ` +
      `${entwuerfe} Entwürfe vorbereitet. Alles wartet auf deine Freigabe.`,
    '',
  );

  if (relevant.length === 0) {
    lines.push('Keine Anfragen im Zeitraum.', '');
    return lines.join('\n');
  }

  let current: TriageRecord['urgency'] | null = null;
  for (const item of sortItems(relevant)) {
    if (item.triage.urgency !== current) {
      current = item.triage.urgency;
      lines.push(`## ${TITLES[current]}`, '');
    }

    const when = `${DATE.format(new Date(item.message.internalDate))}, ${TIME.format(new Date(item.message.internalDate))}`;
    const who = item.triage.senderName ?? item.message.fromName ?? item.message.fromEmail;
    lines.push(`**${who}** — ${item.message.subject ?? '(kein Betreff)'} · ${when}`);
    lines.push(detailLine(item));
    lines.push('');
  }

  return lines.join('\n');
}

/** Kurznachricht für den Push. Keine Mailinhalte, nur das Nötigste. */
export function renderUrgentNotice(item: DigestItem): string {
  const who = item.triage.senderName ?? item.message.fromName ?? item.message.fromEmail;
  const subject = item.message.subject ?? '(kein Betreff)';
  const missing = item.triage.missingFields.length
    ? `\nFehlt: ${item.triage.missingFields.join(', ')}`
    : '';
  return `Dringende Anfrage von ${who}\n${subject}${missing}\nEntwurf wartet auf Freigabe.`;
}
