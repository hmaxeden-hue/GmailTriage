import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppConfig, ProfileConfig } from './schema.js';

export function loadAppConfig(path = 'config/app.yaml'): AppConfig {
  return AppConfig.parse(parse(readFileSync(path, 'utf8')) ?? {});
}

export function loadProfile(path = 'config/profile.yaml'): ProfileConfig {
  return ProfileConfig.parse(parse(readFileSync(path, 'utf8')) ?? {});
}

/** Wandelt "7d", "48h", "30m" in Millisekunden. */
export function parseSince(spec: string): number {
  const m = spec.trim().match(/^(\d+)\s*([dhm])$/i);
  if (!m) throw new Error(`Ungültiges Zeitfenster: "${spec}". Erwartet z.B. 7d, 48h, 90m.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd').toLowerCase();
  const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return n * factor;
}
