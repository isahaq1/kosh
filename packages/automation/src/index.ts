/**
 * @packageDocumentation
 * `@kosh/automation` (RFC 0011): the automation builder. Rules ("when a record is created / updated / moves to a
 * state / an event is emitted, then set fields, run a transition, plan an activity, notify, post a note, create
 * a record, run a module action") are records of the Automation app, evaluated by an engine on Shutro's audit
 * trail and outbox, exactly once per change, as the actor or the system, with a run log.
 */
import { chatterContext, messaging } from '@kosh/messaging';
import { type AutomationActionSpec, defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import { type AutomationContext, startAutomation } from './engine.js';
import { automationShutro } from './models.js';
import { registerAutomationRoutes } from './routes.js';

export {
  type AutomationContext,
  applyChange,
  applyRule,
  type Change,
  chainOf,
  changesOf,
  loadRules,
  MAX_DEPTH,
  type Outcome,
  pollAudit,
  pollOutbox,
  type RuleRow,
  render,
  retryRun,
  runActions,
  startAutomation,
  testRule,
  trackedFields,
  triggerMismatch,
} from './engine.js';
export {
  ACTION_KINDS,
  type ActionKind,
  automationShutro,
  TRIGGERS,
  type Trigger,
} from './models.js';
export { registerAutomationRoutes } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/automation',
  rfc: 'RFC 0011',
});

/** The engine's context for a server: the served modules' actions, the chatter's view of the models. */
export function automationContext(context: ModuleContext): AutomationContext {
  const actions = new Map<string, AutomationActionSpec>();
  for (const m of context.registry.loaded.modules)
    for (const a of m.automationActions ?? []) actions.set(a.key, a);
  return {
    shutro: context.shutro,
    driver: context.driver,
    registry: context.registry,
    auth: context.auth,
    chatter: chatterContext(context),
    actions,
    log: (message, error) => context.app.log.warn({ err: error }, message),
  };
}

export interface AutomationOptions {
  /** Start the engine (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
  readonly pollMs?: number | undefined;
}

/** The automation module with explicit options (tests). */
export function automationModule(options: AutomationOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: automationShutro,
    kosh: '^0.1.0',
    depends: [base, messaging],
    app: {
      code: 'automation',
      label: 'Automation',
      icon: 'automation',
      sequence: 940,
      category: 'Administration',
      summary: 'When this happens, do that: rules on your records, with a log of every run',
    },
    accessLevels: {
      user: { label: 'User (the runs of records they read)', groups: ['automation.user'] },
      manager: {
        label: 'Manager (the rules)',
        groups: ['automation.manager'],
        implies: ['user'],
      },
    },
    privateModels: ['automation.cursor'],
    actions: {
      'automation.action_rules': action('automation.rule', {
        label: 'Rules',
        views: ['list', 'form'],
      }),
      'automation.action_runs': action('automation.run', {
        label: 'Runs',
        views: ['list', 'form'],
      }),
    },
    menus: [
      { id: 'automation.root', label: 'Automation', app: 'automation' },
      {
        id: 'automation.rules',
        parent: 'automation.root',
        label: 'Rules',
        action: 'automation.action_rules',
        sequence: 1,
      },
      {
        id: 'automation.runs',
        parent: 'automation.root',
        label: 'Runs',
        action: 'automation.action_runs',
        sequence: 2,
      },
    ],
    views: {
      'automation.rule.list': list('automation.rule', {
        columns: ['name', 'targetModel', 'trigger', 'enabled', 'runAs', 'lastRunAt'],
        inlineEdit: ['enabled'],
      }),
      'automation.rule.form': form('automation.rule', (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['name', 'targetModel', 'trigger', 'enabled', 'sequence']),
          k.group('when', ['watchFields', 'fromValues', 'toValues', 'topic', 'condition'], {
            columns: 1,
          }),
          k.group('then', ['actions', 'runAs', 'runAsUser', 'logOnRecord'], { columns: 1 }),
          k.group('about', ['description', 'lastRunAt'], { columns: 1 }),
        ],
        chatter: true,
      })),
      'automation.run.list': list('automation.run', {
        columns: [
          'rule',
          'targetModel',
          'targetId',
          'trigger',
          'state',
          'reason',
          'actor',
          'startedAt',
        ],
        defaultOrder: ['id desc'],
      }),
      'automation.run.form': form('automation.run', (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['rule', 'trigger', 'targetModel', 'targetId', 'actor', 'tx']),
          k.group('result', ['state', 'reason', 'startedAt', 'finishedAt']),
          k.group('details', ['outcomes', 'error'], { columns: 1 }),
        ],
      })),
    },
    search: {
      'automation.rule': search('automation.rule', {
        fields: ['name', 'targetModel'],
        filters: {
          enabled: { label: 'Enabled', domain: { enabled: true } },
        },
        groupBy: ['targetModel', 'trigger'],
      }),
      'automation.run': search('automation.run', {
        fields: ['targetModel'],
        filters: {
          failed: { label: 'Failed', domain: { state: 'failed' }, group: 'state' },
          done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
          skipped: { label: 'Skipped', domain: { state: 'skipped' }, group: 'state' },
        },
        groupBy: ['rule', 'state', 'targetModel'],
      }),
    },
    routes: (context: ModuleContext) => {
      const engine = automationContext(context);
      registerAutomationRoutes(context, engine);
      // Background work is off in the CLI (kosh init, migrate), like the schedules.
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const running = startAutomation(engine, {
        pollMs: options.pollMs ?? Number(process.env['KOSH_AUTOMATION_POLL_MS'] ?? 5000),
      });
      context.app.addHook('onClose', async () => {
        await running.stop();
      });
    },
  });
}

/** The automation module: a technical module every installation has (the app shows for its managers). */
export const automation: ReturnType<typeof defineModule> = automationModule();
