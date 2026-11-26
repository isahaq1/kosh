/**
 * Quality's demo data (RFC 0008 §5.8): three control points — a visual inspection on every receipt, a measure with
 * tolerances, a photo of the packing before a delivery — and an alert being investigated.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const QASIM = { login: 'qasim', name: 'Qasim Ali', groups: ['quality.manager'] } as const;

export async function qualityDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(QASIM, async (raw) => {
    const env = raw as Env;
    await env.model('quality.point').create([
      {
        name: 'Visual inspection on receipt',
        kind: 'pass_fail',
        operation: 'receipt',
        instructions: 'No damage to the packaging.\nThe labels match the order.\nNo moisture.',
      },
      {
        name: 'Net weight of a sample',
        kind: 'measure',
        operation: 'receipt',
        every: 5,
        unit: 'kg',
        low: '24.8',
        high: '25.2',
        instructions: 'Weigh one bag of the lot on the calibrated scale.',
      },
      {
        name: 'Photo of the packed pallet',
        kind: 'photo',
        operation: 'delivery',
        instructions: 'One photo showing the wrap and the label before the pallet leaves.',
      },
    ]);
    const made = await env.model('quality.alert').create([
      {
        title: 'Bags arriving under weight',
        priority: 'high',
        description: 'Three receipts in a row had sample bags below 24.8 kg.',
      },
    ]);
    await made.investigate();
  });
  return 'Quality: three control points and an alert under investigation.';
}
