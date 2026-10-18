/**
 * View extension by anchors (RFC 0004 §5): other modules insert, replace, remove or change nodes by id, applied in
 * module dependency order, with the origin of every node recorded. An unknown anchor is an error at load time, not
 * a silently missing button.
 */
import type {
  ButtonNode,
  FormNode,
  ResolvedView,
  ViewDefinition,
  ViewExtension,
  ViewOperation,
} from './types.js';

type AnyNode = FormNode | ButtonNode;

/** A view or extension that cannot apply. */
export class ViewDefinitionError extends Error {
  readonly view: string;
  constructor(view: string, problem: string, hint: string) {
    super(`View '${view}': ${problem} ${hint}`);
    this.name = 'ViewDefinitionError';
    this.view = view;
  }
}

/** Every node of a view, in document order. */
export function nodesOf(view: ViewDefinition): AnyNode[] {
  const out: AnyNode[] = [];
  const walk = (nodes: readonly FormNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.kind === 'group') walk(node.children);
      if (node.kind === 'notebook')
        for (const page of node.pages) {
          out.push(page as unknown as FormNode);
          walk(page.children);
        }
      if (node.kind === 'lines') out.push(...node.columns);
    }
  };
  switch (view.type) {
    case 'list':
      walk(view.columns);
      break;
    case 'form':
      out.push(...view.header.buttons);
      walk(view.sheet);
      break;
    case 'kanban':
      walk([...(view.card.footer ?? []), ...(view.card.badges ?? [])]);
      break;
    default:
      break; // report views have no node tree: they are changed with setAttrs on the view
  }
  return out;
}

const anchorOf = (op: ViewOperation): string =>
  'insertAfter' in op
    ? op.insertAfter
    : 'insertBefore' in op
      ? op.insertBefore
      : 'append' in op
        ? op.append
        : 'replace' in op
          ? op.replace
          : 'remove' in op
            ? op.remove
            : op.setAttrs;

/** Applies `op` to a list of sibling nodes (recursively); returns the new list and whether it applied. */
function applyIn<T extends AnyNode>(nodes: readonly T[], op: ViewOperation): [T[], boolean] {
  const anchor = anchorOf(op);
  const index = nodes.findIndex((n) => n.id === anchor);
  if (index >= 0) {
    const out = [...nodes];
    const added = ('nodes' in op ? op.nodes : []) as unknown as T[];
    if ('insertAfter' in op) out.splice(index + 1, 0, ...added);
    else if ('insertBefore' in op) out.splice(index, 0, ...added);
    else if ('replace' in op) out.splice(index, 1, ...added);
    else if ('remove' in op) out.splice(index, 1);
    else if ('setAttrs' in op)
      out[index] = {
        ...(out[index] as T),
        ...op.attrs,
        kind: (out[index] as T).kind,
        id: anchor,
      } as T;
    else if ('append' in op) {
      const target = out[index] as AnyNode;
      if (target.kind === 'group')
        out[index] = {
          ...target,
          children: [...target.children, ...(added as unknown as FormNode[])],
        } as unknown as T;
      else if ((target as { kind: string }).kind === 'page')
        out[index] = {
          ...target,
          children: [
            ...(target as unknown as { children: FormNode[] }).children,
            ...(added as unknown as FormNode[]),
          ],
        } as unknown as T;
      else return [[...nodes], false];
    }
    return [out, true];
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as AnyNode;
    if (node.kind === 'group') {
      const [children, done] = applyIn(node.children, op);
      if (done) {
        const out = [...nodes];
        out[i] = { ...node, children } as unknown as T;
        return [out, true];
      }
    }
    if (node.kind === 'notebook') {
      const [pages, done] = applyIn(node.pages as unknown as FormNode[], op);
      if (done) {
        const out = [...nodes];
        out[i] = { ...node, pages } as unknown as T;
        return [out, true];
      }
      for (let p = 0; p < node.pages.length; p++) {
        const page = node.pages[p] as (typeof node.pages)[number];
        const [children, inPage] = applyIn(page.children, op);
        if (inPage) {
          const pagesOut = [...node.pages];
          pagesOut[p] = { ...page, children };
          const out = [...nodes];
          out[i] = { ...node, pages: pagesOut } as unknown as T;
          return [out, true];
        }
      }
    }
    if (node.kind === 'lines') {
      const [columns, done] = applyIn(node.columns, op);
      if (done) {
        const out = [...nodes];
        out[i] = { ...node, columns } as unknown as T;
        return [out, true];
      }
    }
  }
  return [[...nodes], false];
}

function apply(view: ViewDefinition, op: ViewOperation): ViewDefinition {
  let done = false;
  let next: ViewDefinition = view;
  switch (view.type) {
    case 'list': {
      const [columns, ok] = applyIn(view.columns, op);
      [next, done] = [{ ...view, columns }, ok];
      break;
    }
    case 'form': {
      const [buttons, inHeader] = applyIn(view.header.buttons, op);
      if (inHeader)
        [next, done] = [
          { ...view, header: { ...view.header, buttons: buttons as ButtonNode[] } },
          true,
        ];
      else {
        const [sheet, ok] = applyIn(view.sheet, op);
        [next, done] = [{ ...view, sheet: sheet as FormNode[] }, ok];
      }
      break;
    }
    case 'kanban': {
      const [footer, inFooter] = applyIn(view.card.footer ?? [], op);
      if (inFooter) [next, done] = [{ ...view, card: { ...view.card, footer } }, true];
      else {
        const [badges, ok] = applyIn(view.card.badges ?? [], op);
        [next, done] = [{ ...view, card: { ...view.card, badges } }, ok];
      }
      break;
    }
    default:
      // Report views: `setAttrs` on the view id changes the view itself (e.g. add a measure, change the chart).
      if ('setAttrs' in op && op.setAttrs === view.id)
        [next, done] = [
          {
            ...view,
            ...op.attrs,
            type: view.type,
            id: view.id,
            model: view.model,
          } as ViewDefinition,
          true,
        ];
      break;
  }
  if (!done)
    throw new ViewDefinitionError(
      view.id,
      `no node has the id '${anchorOf(op)}'.`,
      `Anchors: ${
        nodesOf(view)
          .map((n) => n.id)
          .join(', ') || 'none'
      }.`,
    );
  return next;
}

/**
 * Applies extensions (already in module dependency order) to a view, recording origins.
 * @throws {ViewDefinitionError} for an unknown anchor or a duplicate node id
 */
export function resolveView(
  view: ViewDefinition,
  owner: string,
  extensions: readonly { readonly module: string; readonly extension: ViewExtension }[],
): ResolvedView {
  const origins: Record<string, string> = {};
  for (const node of nodesOf(view)) origins[node.id] = owner;
  let current = view;
  const chain = [owner];
  for (const { module, extension } of extensions) {
    if (extension.view !== view.id) continue;
    for (const op of extension.operations) {
      current = apply(current, op);
      if ('nodes' in op) for (const node of op.nodes) origins[node.id] = module;
      if ('setAttrs' in op) origins[op.setAttrs] = module;
      if ('remove' in op) delete origins[op.remove];
    }
    chain.push(module);
  }
  const seen = new Set<string>();
  for (const node of nodesOf(current)) {
    if (seen.has(node.id))
      throw new ViewDefinitionError(
        view.id,
        `two nodes have the id '${node.id}'.`,
        'Give one an explicit id.',
      );
    seen.add(node.id);
  }
  return { view: current, origins, chain };
}
