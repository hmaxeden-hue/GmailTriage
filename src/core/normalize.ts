import { createHash } from 'node:crypto';
import type { MimePart, NormalizedMessage, RawMessage } from './types.js';

export interface NormalizeOptions {
  /** Harte Obergrenze fuer bodyText. Schuetzt Token-Budget und Kosten in CP2. */
  maxBodyChars: number;
  now: number;
}

export const DEFAULT_MAX_BODY_CHARS = 8000;

// --- MIME ------------------------------------------------------------------

export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function getHeader(part: MimePart, name: string): string | null {
  const wanted = name.toLowerCase();
  const hit = part.headers?.find((h) => h.name.toLowerCase() === wanted);
  return hit ? hit.value : null;
}

/**
 * Waehlt den Body aus dem MIME-Baum: text/plain schlaegt text/html.
 * Anhaenge werden in Phase 1 ignoriert, nur ihre Dateinamen werden gemeldet.
 */
export function selectBody(payload: MimePart): {
  text: string;
  source: 'plain' | 'html' | 'none';
  attachments: string[];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];

  const walk = (part: MimePart): void => {
    if (part.filename) {
      attachments.push(part.filename);
      return;
    }
    if (part.parts?.length) {
      for (const child of part.parts) walk(child);
      return;
    }
    if (!part.data) return;
    const decoded = decodeBase64Url(part.data);
    if (part.mimeType === 'text/plain') plain.push(decoded);
    else if (part.mimeType === 'text/html') html.push(decoded);
  };
  walk(payload);

  if (plain.length) return { text: plain.join('\n'), source: 'plain', attachments };
  if (html.length) return { text: htmlToText(html.join('\n')), source: 'html', attachments };
  return { text: '', source: 'none', attachments };
}

// --- HTML ------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', middot: '·',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name] ?? m);
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  return collapseBlankLines(decodeEntities(s));
}

export function collapseBlankLines(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/g, '').replace(/ /g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Zitate ----------------------------------------------------------------

/** Marker, ab denen der Rest der Mail zitierter Verlauf ist. */
const QUOTE_MARKERS: RegExp[] = [
  /^-{2,}\s*(Urspr(ü|ue)ngliche Nachricht|Original Message|Weitergeleitete Nachricht|Forwarded message)\s*-{2,}/i,
  /^_{10,}$/,
  /^Von:\s*.+$/i,
  /^From:\s*.+$/i,
  /^Gesendet:\s*.+$/i,
  /^Sent:\s*.+$/i,
];

/** Mehrzeilige Einleitungen wie "Am 3. Jan. 2026 um 10:12 schrieb Max <m@x.ch>:". */
const QUOTE_INTROS: RegExp[] = [
  /^Am\s[\s\S]{0,180}?\sschrieb\s[\s\S]{0,180}?:\s*$/i,
  /^On\s[\s\S]{0,180}?\swrote:\s*$/i,
];

export function stripQuotes(text: string): string {
  const lines = text.split('\n');
  let cut = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('>') || QUOTE_MARKERS.some((re) => re.test(line.trim()))) {
      cut = i;
      break;
    }
    // Einleitung darf ueber bis zu drei Zeilen umgebrochen sein; deshalb
    // waechst das Fenster schrittweise, statt fix drei Zeilen zu greifen.
    let introHit = false;
    for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
      const window = lines.slice(i, i + span).join('\n').trim();
      if (QUOTE_INTROS.some((re) => re.test(window))) {
        introHit = true;
        break;
      }
    }
    if (introHit) {
      cut = i;
      break;
    }
  }

  return collapseBlankLines(lines.slice(0, cut).join('\n'));
}

// --- Signatur --------------------------------------------------------------

const CONTACT_HINTS: RegExp[] = [
  /\b(tel|telefon|mobil|natel|fon|phone|mob)\b\s*[.:+]?/i,
  /\+41|\+49|\+43|\b0\d{2}\s?\d{3}\s?\d{2}\s?\d{2}\b/,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  /\bwww\.|https?:\/\//i,
  /\b(CH|DE|AT)?-?\d{4,5}\s+[A-ZÄÖÜ][\wäöüß-]+/,
  /\b(GmbH|AG|KG|e\.K\.|Einzelfirma|UG)\b/,
];

/**
 * Trennt eine Signatur ab. Sie wird nicht verworfen, sondern separat
 * aufbewahrt — Kontaktdaten stehen fast immer dort und werden in CP2 gebraucht.
 */
export function splitSignature(text: string): { body: string; signature: string | null } {
  const lines = text.split('\n');

  // 1. RFC-Trenner "-- "
  const delim = lines.findIndex((l) => /^--\s?$/.test(l));
  if (delim !== -1) {
    return {
      body: collapseBlankLines(lines.slice(0, delim).join('\n')),
      signature: collapseBlankLines(lines.slice(delim + 1).join('\n')) || null,
    };
  }

  // 2. Konservative Heuristik: Kontaktblock am Textende.
  const tailStart = Math.max(0, lines.length - 8);
  for (let start = tailStart; start < lines.length; start++) {
    const tail = lines.slice(start);
    const nonEmpty = tail.filter((l) => l.trim() !== '');
    if (nonEmpty.length < 2) break;
    const hits = nonEmpty.filter((l) => CONTACT_HINTS.some((re) => re.test(l))).length;
    if (hits >= 2 && hits >= nonEmpty.length - 1) {
      return {
        body: collapseBlankLines(lines.slice(0, start).join('\n')),
        signature: collapseBlankLines(tail.join('\n')) || null,
      };
    }
  }

  return { body: collapseBlankLines(text), signature: null };
}

// --- Adressen --------------------------------------------------------------

export function parseAddress(raw: string | null): { name: string | null; email: string } {
  if (!raw) return { name: null, email: '' };
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? '').replace(/^["']|["']$/g, '').trim();
    return { name: name || null, email: (angled[2] ?? '').trim().toLowerCase() };
  }
  return { name: null, email: raw.trim().toLowerCase() };
}

// --- Einstieg --------------------------------------------------------------

export function normalizeMessage(raw: RawMessage, opts: NormalizeOptions): NormalizedMessage {
  const { text } = selectBody(raw.payload);
  const { body, signature } = splitSignature(stripQuotes(text));

  const truncated = body.length > opts.maxBodyChars;
  const bodyText = truncated ? `${body.slice(0, opts.maxBodyChars)}\n[…gekürzt]` : body;

  const from = parseAddress(getHeader(raw.payload, 'From'));
  const to = parseAddress(getHeader(raw.payload, 'To'));

  return {
    messageId: raw.messageId,
    threadId: raw.threadId,
    rfc822Id: getHeader(raw.payload, 'Message-ID'),
    fromName: from.name,
    fromEmail: from.email,
    toEmail: to.email || null,
    subject: getHeader(raw.payload, 'Subject'),
    internalDate: raw.internalDate,
    bodyText,
    signatureText: signature,
    bodyHash: createHash('sha256').update(bodyText).digest('hex'),
    labelIds: raw.labelIds,
    truncated,
    ingestedAt: opts.now,
  };
}
