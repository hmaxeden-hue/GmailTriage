/**
 * Fehler, bei denen jeder weitere Versuch im selben Lauf ebenfalls scheitert:
 * fehlender oder ungültiger Schlüssel, fehlende Berechtigung, unbekanntes
 * Modell. Der Lauf bricht dann ab, statt für jede Mail erneut anzuklopfen.
 */
export class FatalLlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FatalLlmError';
  }
}
