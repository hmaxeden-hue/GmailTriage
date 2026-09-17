import type { Notifier } from '../../core/ports.js';

/**
 * Push bei dringenden Anfragen. Hinter einem Feature-Flag, Default aus.
 *
 * Es geht nur Absendername, Betreff und Dringlichkeit hinaus — kein Mailtext.
 * Der Endpunkt steht im README mit Betreiber und Standort.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async notify(text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Telegram antwortete ${res.status}: ${body}`);
    }
  }
}

/** Dry-Run und abgeschaltetes Flag: merkt sich, was hinausgegangen wäre. */
export class NoopNotifier implements Notifier {
  readonly sent: string[] = [];

  async notify(text: string): Promise<void> {
    this.sent.push(text);
  }
}

/**
 * Baut den Notifier aus Config und Umgebung. Fehlt etwas, wird nichts
 * verschickt — ein halb konfigurierter Push ist ein stiller Ausfall.
 */
export function createNotifier(cfg: {
  enabled: boolean;
  chatId: string | undefined;
  write: boolean;
}): { notifier: Notifier; reason: string | null } {
  if (!cfg.enabled) return { notifier: new NoopNotifier(), reason: 'telegram.enabled ist false' };
  if (!cfg.write) return { notifier: new NoopNotifier(), reason: 'Dry-Run' };

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) return { notifier: new NoopNotifier(), reason: 'TELEGRAM_BOT_TOKEN fehlt' };
  if (!cfg.chatId) return { notifier: new NoopNotifier(), reason: 'telegram.chatId fehlt' };

  return { notifier: new TelegramNotifier(token, cfg.chatId), reason: null };
}
