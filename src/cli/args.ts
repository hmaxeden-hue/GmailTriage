import { parseArgs } from 'node:util';

export interface CommonArgs {
  /** Default ist Dry-Run. Nur --write erlaubt Wirkung nach aussen. */
  write: boolean;
  since: string | undefined;
  max: number | undefined;
  fixtures: string | undefined;
  db: string | undefined;
  model: string | undefined;
  /** Bereits klassifizierte Mails erneut durch das Modell schicken. */
  reclassify: boolean;
  help: boolean;
}

export function parseCommonArgs(argv: string[]): CommonArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      write: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      since: { type: 'string' },
      max: { type: 'string' },
      fixtures: { type: 'string' },
      db: { type: 'string' },
      model: { type: 'string' },
      reclassify: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  return {
    write: values.write === true,
    since: values.since,
    max: values.max === undefined ? undefined : Number(values.max),
    fixtures: values.fixtures,
    db: values.db,
    model: values.model,
    reclassify: values.reclassify === true,
    help: values.help === true,
  };
}
