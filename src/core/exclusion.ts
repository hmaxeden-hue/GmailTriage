import type { ProfileConfig } from '../config/schema.js';
import type { NormalizedMessage } from './types.js';

export interface ExclusionVerdict {
  excluded: boolean;
  reason: string | null;
}

/**
 * Sortiert Lieferanten, Buchhaltung und aehnliches aus, bevor ein LLM-Call
 * entsteht. Spart Tokens und haelt Inhalte lokal, die niemand triagieren muss.
 */
export function checkExclusion(m: NormalizedMessage, profile: ProfileConfig): ExclusionVerdict {
  const email = m.fromEmail.toLowerCase();
  const domain = email.split('@')[1] ?? '';

  for (const addr of profile.ausschluss.absender) {
    if (addr && email === addr.toLowerCase()) return { excluded: true, reason: `Absender ${addr}` };
  }
  for (const d of profile.ausschluss.domains) {
    const needle = d.toLowerCase().replace(/^@/, '');
    if (needle && (domain === needle || domain.endsWith(`.${needle}`))) {
      return { excluded: true, reason: `Domain ${d}` };
    }
  }
  for (const pattern of profile.ausschluss.betreffMuster) {
    if (pattern && m.subject && new RegExp(pattern, 'i').test(m.subject)) {
      return { excluded: true, reason: `Betreff ~ /${pattern}/i` };
    }
  }
  return { excluded: false, reason: null };
}

/** VIP-Whitelist: Treffer heben die Dringlichkeit spaeter auf mindestens "hoch". */
export function isVip(m: NormalizedMessage, profile: ProfileConfig): boolean {
  const email = m.fromEmail.toLowerCase();
  const domain = email.split('@')[1] ?? '';
  return profile.vipAbsender.some((entry) => {
    const v = entry.toLowerCase().trim();
    if (!v || v.startsWith('«')) return false;
    if (v.startsWith('@')) return domain === v.slice(1) || domain.endsWith(`.${v.slice(1)}`);
    return email === v;
  });
}
