import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OAuth2Client } from 'google-auth-library';

/** CP1 kommt mit read-only aus. gmail.compose kommt erst in CP3 dazu. */
export const SCOPES_READONLY = ['https://www.googleapis.com/auth/gmail.readonly'];

interface InstalledCredentials {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

/**
 * OAuth Desktop-Flow ueber einen Loopback-Server auf 127.0.0.1.
 * Das Token bleibt lokal in tokenPath (Dateirechte 0600).
 */
export async function getAuthClient(opts: {
  credentialsPath: string;
  tokenPath: string;
  scopes?: string[];
}): Promise<OAuth2Client> {
  const scopes = opts.scopes ?? SCOPES_READONLY;

  if (!existsSync(opts.credentialsPath)) {
    throw new Error(
      `Keine OAuth-Credentials unter ${opts.credentialsPath}.\n` +
        'Google Cloud Console → APIs & Dienste → Anmeldedaten → OAuth-Client-ID → ' +
        'Anwendungstyp "Desktop-App" → JSON herunterladen und dort ablegen.',
    );
  }

  const raw = JSON.parse(readFileSync(opts.credentialsPath, 'utf8')) as InstalledCredentials;
  const cred = raw.installed ?? raw.web;
  if (!cred) throw new Error(`${opts.credentialsPath} enthält weder "installed" noch "web".`);

  if (existsSync(opts.tokenPath)) {
    const client = new OAuth2Client({ clientId: cred.client_id, clientSecret: cred.client_secret });
    client.setCredentials(JSON.parse(readFileSync(opts.tokenPath, 'utf8')));
    return client;
  }

  const { client, tokens } = await runLoopbackFlow(cred, scopes);
  mkdirSync(dirname(opts.tokenPath), { recursive: true });
  writeFileSync(opts.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Token gespeichert: ${opts.tokenPath}`);
  return client;
}

async function runLoopbackFlow(
  cred: { client_id: string; client_secret: string },
  scopes: string[],
): Promise<{ client: OAuth2Client; tokens: unknown }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const client = new OAuth2Client({
        clientId: cred.client_id,
        clientSecret: cred.client_secret,
        redirectUri,
      });
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes,
      });

      console.log('\nDiesen Link im Browser öffnen und die Freigabe erteilen:\n');
      console.log(authUrl, '\n');

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error ? `Fehlgeschlagen: ${error}` : 'Freigabe erteilt. Fenster kann geschlossen werden.');
        server.close();
        if (error || !code) {
          reject(new Error(`OAuth abgebrochen: ${error ?? 'kein Code erhalten'}`));
          return;
        }
        client
          .getToken(code)
          .then(({ tokens }) => {
            client.setCredentials(tokens);
            resolve({ client, tokens });
          })
          .catch(reject);
      });
    });
    server.on('error', reject);
  });
}
