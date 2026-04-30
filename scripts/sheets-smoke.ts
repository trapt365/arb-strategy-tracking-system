import { readClientContext } from '../src/adapters/sheets.js';

async function main(): Promise<void> {
  const ctx = await readClientContext({ clientId: 'geonline' });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        clientId: ctx.clientId,
        readAt: ctx.readAt,
        counts: {
          stakeholders: ctx.stakeholders.length,
          okrs: ctx.okrs.length,
          f5Metrics: ctx.f5Metrics.length,
        },
        sample_stakeholder: ctx.stakeholders[0],
        sample_okr: ctx.okrs[0],
        sample_f5: ctx.f5Metrics[0],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('sheets:smoke failed', err);
  process.exit(1);
});
