/**
 * The links of lines to their parents, and whether they are indexed (RFC 0039 §5b):
 * `pnpm index:report`. Lists what the modules declare without an index — the server indexes these itself
 * (`kosh_parent_indexes`) — and checks that, in the registry the server builds, none is left without one.
 */

import { demoCatalogue } from '../apps/demo/src/catalogue.ts';
import { buildKoshRegistry, parentLinksWithoutIndex } from '../packages/server/src/index.ts';

const { loaded, registry } = buildKoshRegistry(demoCatalogue(), { security: { enforce: false } });
const declared = parentLinksWithoutIndex(loaded.modules);
const links = [...declared.values()].reduce((n, keys) => n + keys.length, 0);
process.stdout.write(
  `links of lines to their parents declared without an index: ${links} on ${declared.size} models\n`,
);
const models = (
  registry as unknown as {
    models: ReadonlyMap<
      string,
      {
        model: {
          fields: Readonly<Record<string, { index?: unknown }>>;
          indexes: readonly { fields: readonly string[] }[];
        };
      }
    >;
  }
).models;
const left: string[] = [];
for (const [name, keys] of declared) {
  const model = models.get(name)?.model;
  for (const key of keys) {
    const indexed =
      (model?.fields[key]?.index !== undefined && model.fields[key]?.index !== false) ||
      (model?.indexes ?? []).some((i) => i.fields[0] === key);
    if (!indexed) left.push(`${name}.${key}`);
  }
}
for (const [name, keys] of [...declared].sort(([a], [b]) => a.localeCompare(b)))
  process.stdout.write(`  ${name}: ${keys.join(', ')}\n`);
process.stdout.write(
  left.length === 0
    ? "in the server's registry every one of them is indexed\n"
    : `NOT indexed in the server's registry: ${left.join(', ')}\n`,
);
process.exit(left.length === 0 ? 0 : 1);
