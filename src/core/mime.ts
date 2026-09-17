/**
 * Minimaler RFC-822-Aufbau für Antwortentwürfe. Rein, damit er ohne Gmail
 * testbar ist.
 */

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  /** Message-ID-Header der Mail, auf die geantwortet wird. */
  inReplyTo: string | null;
  body: string;
}

/** Verhindert Header-Injection über Zeilenumbrüche in Feldwerten. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC-2047, damit Umlaute im Betreff ankommen. */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function wrap(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join('\r\n');
}

export function buildRfc822(input: MimeInput): string {
  const headers = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    `To: ${sanitizeHeaderValue(input.to)}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  if (input.inReplyTo) {
    const ref = sanitizeHeaderValue(input.inReplyTo);
    // References haelt den Thread in fremden Clients zusammen.
    headers.push(`In-Reply-To: ${ref}`, `References: ${ref}`);
  }

  const body = wrap(Buffer.from(input.body, 'utf8').toString('base64'));
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
