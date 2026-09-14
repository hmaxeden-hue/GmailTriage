import { getAuthClient, SCOPES_READONLY } from '../adapters/gmail/auth.js';
import { GmailMailSource } from '../adapters/gmail/client.js';
import { loadAppConfig } from '../config/load.js';

/**
 * Einmaliges OAuth-Setup. Fordert in CP1 nur den Lese-Scope an und legt das
 * Token lokal ab. Danach laeuft `pnpm ingest` ohne Browser.
 */
async function main(): Promise<number> {
  const app = loadAppConfig();
  console.log(`Angeforderte Scopes: ${SCOPES_READONLY.join(', ')}`);

  const auth = await getAuthClient({
    credentialsPath: app.gmail.credentialsPath,
    tokenPath: app.gmail.tokenPath,
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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
