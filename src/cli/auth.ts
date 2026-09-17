import { getAuthClient, scopesFor } from '../adapters/gmail/auth.js';
import { GmailMailSource } from '../adapters/gmail/client.js';
import { loadAppConfig } from '../config/load.js';

/**
 * Einmaliges OAuth-Setup. Fordert in CP1 nur den Lese-Scope an und legt das
 * Token lokal ab. Danach laeuft `pnpm ingest` ohne Browser.
 */
async function main(argv: string[]): Promise<number> {
  const app = loadAppConfig();
  // Ohne --drafts bleibt es beim Lesezugriff.
  const drafts = argv.includes('--drafts');
  const scopes = scopesFor({ drafts, label: app.gmail.label !== null });

  console.log(`Angeforderte Scopes: ${scopes.join(', ')}`);
  if (drafts) {
    console.log(
      'Hinweis: gmail.compose schliesst bei Google die Sendefaehigkeit mit ein.\n' +
        'Dieses Projekt ruft keinen Sendeweg auf — das ist code-seitig gesichert,\n' +
        'nicht von Google erzwungen. Siehe README.\n',
    );
  }

  const auth = await getAuthClient({
    credentialsPath: app.gmail.credentialsPath,
    tokenPath: app.gmail.tokenPath,
    scopes,
  });

  const source = new GmailMailSource(auth);
  const refs = await source.list({
    query: app.gmail.query,
    after: new Date(Date.now() - 7 * 86_400_000),
    max: 1,
  });
  console.log(`Verbindung steht. Treffer im Testfilter: ${refs.length}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
