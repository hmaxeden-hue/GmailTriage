import type { AppConfig, ProfileConfig } from '../config/schema.js';
import { renderUrgentNotice, type DigestItem } from '../core/digest.js';
import type {
  DraftStore,
  LabelSink,
  DraftSink,
  LlmClient,
  MailSource,
  MessageStore,
  NotificationStore,
  Notifier,
  TriageStore,
} from '../core/ports.js';
import type { PromptTemplates } from '../core/prompt.js';
import { runClassify } from './classify.js';
import { runDrafts } from './draft.js';
import { runIngest } from './ingest.js';

export interface TriageDeps {
  source: MailSource;
  llm: LlmClient;
  draftSink: DraftSink;
  labelSink: LabelSink;
  notifier: Notifier;
  messages: MessageStore;
  triage: TriageStore;
  drafts: DraftStore;
  notifications: NotificationStore;
  profile: ProfileConfig;
  app: AppConfig;
  templates: PromptTemplates;
  since: Date;
  max: number;
  write: boolean;
  reclassify: boolean;
  now: () => number;
}

export interface TriageSummary {
  ingest: Record<string, number>;
  classify: Record<string, number>;
  drafts: Record<string, number>;
  pushes: number;
  abortedWith: string | null;
  items: DigestItem[];
  sonstige: number;
}

/**
 * Der Gesamtlauf: lesen, einordnen, Entwuerfe vorbereiten, benachrichtigen.
 * Ohne write wirkt nichts nach aussen ausser dem LLM-Call — der ist laut
 * Regel 4 ausdruecklich erlaubt und wird vom Aufrufer angekuendigt.
 */
export async function runTriage(deps: TriageDeps): Promise<TriageSummary> {
  const ingest = await runIngest({
    source: deps.source,
    store: deps.messages,
    profile: deps.profile,
    query: deps.app.gmail.query,
    after: deps.since,
    max: deps.max,
    maxBodyChars: deps.app.ingest.maxBodyChars,
    now: deps.now,
  });

  const classify = await runClassify(
    ingest.rows.map((r) => r.message),
    {
      llm: deps.llm,
      store: deps.triage,
      profile: deps.profile,
      templates: deps.templates,
      temperature: deps.app.llm.temperature,
      maxTokens: deps.app.llm.maxTokens,
      skipAlreadyClassified: !deps.reclassify,
      now: deps.now,
    },
  );

  // Fuer Entwuerfe zaehlt der juengste Stand, auch bei uebersprungenen Mails.
  const items: DigestItem[] = [];
  for (const { message } of classify.outcomes) {
    const record = deps.triage.latestTriage(message.messageId);
    if (record) items.push({ message, triage: record, draft: null });
  }

  const drafts = await runDrafts(
    items
      .filter((i) => i.triage.classification !== 'sonstiges')
      .map((i) => ({ message: i.message, triage: i.triage })),
    {
      sink: deps.draftSink,
      store: deps.drafts,
      profile: deps.profile,
      from: deps.profile.betrieb.email,
      write: deps.write,
      label: deps.app.gmail.label,
      labelSink: deps.labelSink,
      now: deps.now,
    },
  );

  for (const item of items) {
    item.draft = deps.drafts.getDraft(item.message.messageId);
  }

  const pushes = await pushUrgent(items, deps);

  return {
    ingest: ingest.counts,
    classify: classify.counts,
    drafts: drafts.counts,
    pushes,
    abortedWith: classify.abortedWith,
    items,
    sonstige: items.filter((i) => i.triage.classification === 'sonstiges').length,
  };
}

/** Push nur bei hoher Dringlichkeit, hoechstens einmal pro Mail. */
async function pushUrgent(items: DigestItem[], deps: TriageDeps): Promise<number> {
  let sent = 0;

  for (const item of items) {
    if (item.triage.urgency !== 'hoch') continue;
    if (item.triage.classification === 'sonstiges') continue;
    if (deps.notifications.wasNotified(item.message.messageId, 'telegram')) continue;

    await deps.notifier.notify(renderUrgentNotice(item));
    deps.notifications.markNotified(item.message.messageId, 'telegram', deps.now(), !deps.write);
    sent += 1;
  }

  return sent;
}
