/**
 * @packageDocumentation
 * `@kosh/loyalty` (RFC 0034 §2.6): the **Loyalty** app. Points by rules, tiers, points that expire, a ledger per
 * customer card; confirmed orders of Sales and of the Shop earn once and give back when cancelled; and before a
 * program runs, a **preview** of what it would have given over past orders, and what that is worth.
 *
 * - `POST /api/v1/loyalty/age`   Loyalty managers: expire old points and bring every card up to date, now (daily on
 *   the server)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { sales } from '@kosh/sales';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { action, field, form, list, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { loyaltyDemo } from './demo.js';
import {
  ageCards,
  earnOrder,
  LoyaltyCard,
  LoyaltyEntry,
  LoyaltyProgram,
  LoyaltyPromotion,
  LoyaltyRule,
  LoyaltyTier,
  LoyaltyVoucher,
  LoyaltyVoucherEntry,
  loyaltyShutro,
  releaseOrder,
  reverseOrder,
} from './module.js';

export {
  type Earned,
  type EarnRule,
  earn,
  expiredPoints,
  type Movement,
  monthsBefore,
  type Order,
  type OrderLine,
  orderAmount,
  type Preview,
  preview,
  type Redeemable,
  redeemLimit,
  type Tier,
  tierOf,
  voucherUse,
} from './engine.js';
export {
  ageCards,
  applyCredits,
  CompanyLoyalty,
  type EarningSale,
  earnOrder,
  earnSale,
  LineLoyalty,
  LoyaltyCard,
  LoyaltyEntry,
  LoyaltyProgram,
  LoyaltyPromotion,
  LoyaltyRule,
  LoyaltyTier,
  LoyaltyVoucher,
  LoyaltyVoucherEntry,
  loyaltyShutro,
  OrderLoyalty,
  previewProgram,
  previewPromotionOf,
  promoteOrder,
  refreshCard,
  releaseCredits,
  releaseOrder,
  reverseOrder,
  type SaleReturn,
  takeBackSale,
} from './module.js';
export {
  applyPromotions,
  type Discount,
  discountOf,
  PROMOTION_KINDS,
  type PromoLine,
  type PromoOrder,
  type Promotion,
  type PromotionKind,
  type PromotionPreview,
  previewPromotion,
} from './promotions.js';

/** The workers that give and take back points as orders are confirmed and cancelled; tests `drain()` them. */
export function loyaltyWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  const idOf = (payload: unknown): number | null => {
    const id = Number((payload as { id?: unknown } | null)?.id);
    return Number.isInteger(id) ? id : null;
  };
  return [
    context.shutro.subscribe(
      'loyalty.earn',
      'sale.order.confirmed',
      async (event, env) => {
        const id = idOf(event.payload);
        if (id !== null) await earnOrder(env as unknown as Env, id);
      },
      { pollMs: 5000 },
    ),
    context.shutro.subscribe(
      'loyalty.reverse',
      'sale.order.cancelled',
      async (event, env) => {
        const id = idOf(event.payload);
        if (id === null) return;
        await reverseOrder(env as unknown as Env, id);
        await releaseOrder(env as unknown as Env, id);
      },
      { pollMs: 5000 },
    ),
  ];
}

function registerLoyaltyRoutes(context: ModuleContext, workers: boolean): void {
  const { app } = context;
  app.post('/api/v1/loyalty/age', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!(env.administrator || env.groups.has('loyalty.manager')))
          throw new HttpProblem(
            403,
            'access',
            'Loyalty managers',
            'Expiring points needs the Loyalty manager role.',
          );
        const expired = await ageCards(env);
        await audit(env as never, {
          kind: 'loyalty.age',
          summary: `${expired} loyalty point(s) expired by hand.`,
          ip: request.ip,
        });
        return { expired };
      },
      { write: true },
    ),
  );
  if (!workers) return;
  const running = loyaltyWorkers(context);
  for (const w of running) w.start();
  // Once a day, each company: old points expire once, so a second server finds nothing left.
  const round = async () => {
    try {
      const companies = await context.shutro.bootstrap({ reason: 'loyalty cards aged' }, (env) =>
        (env as unknown as Env)
          .model('res.company')
          .search({ where: {} })
          .then((found) => found.ids.map(Number)),
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'loyalty cards aged', company }, (env) =>
          ageCards(env as unknown as Env),
        );
    } catch (error) {
      app.log.warn({ err: error }, 'loyalty cards were not aged');
    }
  };
  const timer = setInterval(() => void round(), 24 * 60 * 60 * 1000);
  timer.unref();
  const first = setTimeout(() => void round(), 4 * 60 * 1000);
  first.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearTimeout(first);
    for (const w of running) await w.stop();
  });
}

export interface LoyaltyOptions {
  /** Start the workers and the daily round (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** Loyalty with explicit options (tests: workers drained by hand). */
export function loyaltyModule(options: LoyaltyOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: loyaltyShutro,
    kosh: '^0.1.0',
    hooks: { demo: loyaltyDemo },
    depends: [contacts, product, sales, messaging, reporting],
    app: {
      code: 'loyalty',
      label: 'Loyalty',
      icon: 'loyalty',
      sequence: 36,
      category: 'Sales',
      summary:
        'Points by rules, tiers, cards with a ledger, previewed on past orders before it runs',
    },
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'User (cards and their points)', groups: ['loyalty.user'] },
      manager: { label: 'Manager (programs, adjustments)', groups: ['loyalty.manager'] },
    },
    routes: (context: ModuleContext) =>
      registerLoyaltyRoutes(context, options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off'),
    events: [
      {
        topic: 'loyalty.program.launched',
        model: 'loyalty.program',
        label: 'Loyalty program launched',
      },
      {
        topic: 'loyalty.promotion.launched',
        model: 'loyalty.promotion',
        label: 'Promotion launched',
      },
    ],
    documents: [
      {
        key: 'loyalty_promotion',
        name: 'Promotion',
        model: 'loyalty.promotion',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'what',
              items: [
                { label: 'Gives', bind: 'kind' },
                { label: 'Percentage or amount', bind: 'value' },
                { label: 'Orders from', bind: 'minimumOrder' },
                { label: 'Code', bind: 'code' },
                { label: 'From', bind: 'dateFrom' },
                { label: 'To', bind: 'dateTo' },
                { label: 'Status', bind: 'state' },
              ],
            },
            {
              kind: 'fields',
              id: 'preview',
              items: [
                { label: 'Preview from', bind: 'previewFrom' },
                { label: 'Preview to', bind: 'previewTo' },
                { label: 'Orders', bind: 'previewOrders' },
                { label: 'Orders it would have applied to', bind: 'previewApplied' },
                { label: 'Taken off', bind: 'previewDiscount' },
                { label: 'Share of sales %', bind: 'previewShare' },
              ],
            },
          ],
        },
      },
      {
        key: 'loyalty_program',
        name: 'Loyalty program',
        model: 'loyalty.program',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'what',
              items: [
                { label: 'A point is worth', bind: 'pointValue' },
                { label: 'Points expire after (months)', bind: 'expireMonths' },
                { label: 'Status', bind: 'state' },
              ],
            },
            {
              kind: 'table',
              id: 'rules',
              bind: 'rules',
              columns: [
                { label: 'Rule', bind: 'name' },
                { label: 'Points', bind: 'points' },
                { label: 'For every', bind: 'amountPer' },
                { label: 'Orders from', bind: 'minimumOrder' },
              ],
            },
            {
              kind: 'fields',
              id: 'preview',
              items: [
                { label: 'Preview from', bind: 'previewFrom' },
                { label: 'Preview to', bind: 'previewTo' },
                { label: 'Orders', bind: 'previewOrders' },
                { label: 'Points given', bind: 'previewPoints' },
                { label: 'Worth', bind: 'previewCost' },
                { label: 'Share of sales %', bind: 'previewShare' },
              ],
            },
          ],
        },
      },
    ],
    importTemplates: [
      {
        key: 'loyalty_program',
        model: 'loyalty.program',
        label: 'Loyalty programs (with their rules)',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'A point is worth', field: 'pointValue' },
          { header: 'Points expire after (months)', field: 'expireMonths' },
          { header: 'Rules › Rule', field: 'rules.name' },
          { header: 'Rules › Points', field: 'rules.points' },
          { header: 'Rules › For every', field: 'rules.amountPer' },
        ],
      },
      {
        key: 'loyalty_card',
        model: 'loyalty.card',
        label: 'Loyalty cards',
        columns: [
          { header: 'Program', field: 'program' },
          { header: 'Customer', field: 'partner' },
        ],
      },
      {
        key: 'loyalty_promotion',
        model: 'loyalty.promotion',
        label: 'Promotions',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Gives', field: 'kind' },
          { header: 'Percentage or amount', field: 'value' },
          { header: 'Orders from', field: 'minimumOrder' },
          { header: 'Code', field: 'code' },
          { header: 'From', field: 'dateFrom' },
          { header: 'To', field: 'dateTo' },
        ],
      },
      {
        key: 'loyalty_voucher',
        model: 'loyalty.voucher',
        label: 'Wallets and gift cards',
        columns: [
          { header: 'Kind', field: 'kind' },
          { header: 'Customer', field: 'partner' },
          { header: 'Valid until', field: 'dateExpiry' },
          { header: 'Note', field: 'note' },
          { header: 'Movements › Amount', field: 'entries.amount' },
          { header: 'Movements › Why', field: 'entries.note' },
        ],
      },
      {
        key: 'loyalty_opening',
        model: 'loyalty.entry',
        label: 'Opening points (adjustments)',
        columns: [
          { header: 'Card', field: 'card' },
          { header: 'Date', field: 'date' },
          { header: 'Points', field: 'points' },
          { header: 'Why', field: 'note' },
        ],
      },
    ],
    // The Overview (RFC 0022 step 2): who holds points, and how they move.
    overview: {
      cards: [
        {
          id: 'cards',
          title: 'Cards',
          kind: 'kpi',
          model: 'loyalty.card',
          measure: 'count',
          w: 3,
        },
        {
          id: 'outstanding',
          title: 'Points held',
          kind: 'kpi',
          model: 'loyalty.card',
          measure: 'sum:points',
          w: 3,
        },
        {
          id: 'earned',
          title: 'Earned this month',
          kind: 'kpi',
          model: 'loyalty.entry',
          measure: 'sum:points',
          filter: { kind: 'earn' },
          comparison: { field: 'date', mode: 'previous' },
          w: 3,
        },
        {
          id: 'expired',
          title: 'Expired this month',
          kind: 'kpi',
          model: 'loyalty.entry',
          measure: 'sum:points',
          filter: { kind: 'expire' },
          comparison: { field: 'date', mode: 'previous' },
          w: 3,
        },
        {
          id: 'by_tier',
          title: 'Cards by tier',
          kind: 'chart',
          model: 'loyalty.card',
          measure: 'count',
          groupBy: 'tier',
          chart: 'pie',
          w: 6,
        },
        {
          id: 'by_kind',
          title: 'Points by movement',
          kind: 'chart',
          model: 'loyalty.entry',
          measure: 'sum:points',
          groupBy: 'kind',
          chart: 'bar',
          w: 6,
        },
        {
          id: 'top',
          title: 'Customers with the most points',
          kind: 'pivot',
          model: 'loyalty.card',
          measure: 'sum:points',
          groupBy: 'partner',
          w: 12,
        },
      ],
    },
    actions: {
      'loyalty.action_cards': action(LoyaltyCard, { label: 'Cards', views: ['list', 'form'] }),
      'loyalty.action_entries': action(LoyaltyEntry, { label: 'Points', views: ['list', 'form'] }),
      'loyalty.action_vouchers': action(LoyaltyVoucher, {
        label: 'Wallets and gift cards',
        views: ['list', 'form'],
      }),
      'loyalty.action_voucher_entries': action(LoyaltyVoucherEntry, {
        label: 'Wallet and gift card movements',
        views: ['list', 'form'],
      }),
      'loyalty.action_promotions': action(LoyaltyPromotion, {
        label: 'Promotions',
        views: ['list', 'form'],
      }),
      'loyalty.action_programs': action(LoyaltyProgram, {
        label: 'Programs',
        views: ['list', 'form'],
      }),
      'loyalty.action_rules': action(LoyaltyRule, {
        label: 'Earning rules',
        views: ['list', 'form'],
      }),
      'loyalty.action_tiers': action(LoyaltyTier, { label: 'Tiers', views: ['list', 'form'] }),
    },
    menus: [
      { id: 'loyalty.root', label: 'Loyalty', app: 'loyalty' },
      {
        id: 'loyalty.cards',
        parent: 'loyalty.root',
        label: 'Cards',
        action: 'loyalty.action_cards',
        sequence: 1,
      },
      {
        id: 'loyalty.entries',
        parent: 'loyalty.root',
        label: 'Points',
        action: 'loyalty.action_entries',
        sequence: 2,
      },
      {
        id: 'loyalty.vouchers',
        parent: 'loyalty.root',
        label: 'Wallets and gift cards',
        action: 'loyalty.action_vouchers',
        sequence: 2.5,
      },
      {
        id: 'loyalty.promotions',
        parent: 'loyalty.root',
        label: 'Promotions',
        action: 'loyalty.action_promotions',
        sequence: 2.8,
      },
      {
        id: 'loyalty.programs',
        parent: 'loyalty.root',
        label: 'Programs',
        action: 'loyalty.action_programs',
        sequence: 3,
      },
    ],
    views: {
      'loyalty.program.list': list(LoyaltyProgram, {
        columns: ['name', 'pointValue', 'expireMonths', 'previewPoints', 'previewShare', 'state'],
        decorations: { success: { state: 'running' }, neutral: { state: 'ended' } },
      }),
      'loyalty.program.form': form(LoyaltyProgram, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('look', { label: 'Preview' }),
            k.button('launch', {
              primary: true,
              label: 'Launch',
              confirm: 'Start giving points on confirmed orders?',
            }),
            k.button('finish', {
              label: 'End',
              confirm: 'Stop giving points? Cards keep what they have.',
            }),
          ],
        },
        sheet: [
          k.stats('related', [
            {
              id: 'program_cards',
              label: 'Cards',
              model: LoyaltyCard,
              where: { program: { $record: 'id' } },
              action: 'loyalty.action_cards',
            },
          ]),
          k.group('main', ['name', 'pointValue', 'autoEnrol', 'tierMonths', 'expireMonths'], {
            description:
              'Write the rules, press Preview to see what they would have given over past orders, then Launch. One program runs at a time.',
          }),
          k.group('spending', ['redeemable', 'redeemMaxPercent', 'redeemMinPoints'], {
            label: 'Spending points',
            description:
              'On a quotation, the points typed come off what the customer pays — after taxes, like a payment — and leave the card at once; a cancelled order gives them back.',
          }),
          k.lines('rules', [
            { field: 'sequence', id: 'rule_sequence' },
            { field: 'name', id: 'rule_name' },
            { field: 'points', id: 'rule_points' },
            { field: 'amountPer', id: 'rule_amount' },
            { field: 'product', id: 'rule_product' },
            { field: 'category', id: 'rule_category' },
            { field: 'minimumOrder', id: 'rule_minimum' },
            { field: 'dateFrom', id: 'rule_from' },
            { field: 'dateTo', id: 'rule_to' },
          ]),
          k.lines('tiers', [
            { field: 'name', id: 'tier_name' },
            { field: 'minPoints', id: 'tier_from' },
            { field: 'multiplier', id: 'tier_multiplier' },
          ]),
          k.group(
            'preview',
            [
              'previewFrom',
              'previewTo',
              'previewOrders',
              'previewEarning',
              'previewPoints',
              'previewRevenue',
              'previewCost',
              'previewShare',
              'previewAt',
            ],
            {
              label: 'Preview',
              description:
                'What the rules would have given over the confirmed orders of the period — the month before this one unless you give dates —, and what that is worth at the value of a point. Tiers are left out: nobody has one before the program starts.',
            },
          ),
        ],
        chatter: true,
      })),
      'loyalty.rule.list': list(LoyaltyRule, {
        columns: ['program', 'name', 'points', 'amountPer', 'product', 'category', 'minimumOrder'],
      }),
      'loyalty.rule.form': form(LoyaltyRule, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['program', 'sequence', 'name', 'points', 'amountPer']),
          k.group('scope', ['product', 'category', 'minimumOrder', 'dateFrom', 'dateTo'], {
            label: 'Applies to',
          }),
        ],
      })),
      'loyalty.tier.list': list(LoyaltyTier, {
        columns: ['program', 'name', 'minPoints', 'multiplier'],
      }),
      'loyalty.tier.form': form(LoyaltyTier, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['program', 'name', 'minPoints', 'multiplier'])],
      })),
      'loyalty.card.list': list(LoyaltyCard, {
        columns: ['code', 'partner', 'program', 'tier', { field: 'points', sum: true }, 'earned'],
      }),
      'loyalty.card.form': form(LoyaltyCard, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['code', 'partner', 'program']),
          k.group('standing', ['points', 'earned', 'tier'], { label: 'Standing' }),
          k.lines(
            'entries',
            [
              { field: 'date', id: 'entry_date' },
              { field: 'kind', id: 'entry_kind' },
              { field: 'points', id: 'entry_points', sum: true },
              { field: 'note', id: 'entry_note' },
            ],
            { readonlyWhen: {} },
          ),
        ],
      })),
      'loyalty.promotion.list': list(LoyaltyPromotion, {
        columns: ['name', 'kind', 'value', 'code', 'dateFrom', 'dateTo', 'previewShare', 'state'],
        decorations: { success: { state: 'running' }, neutral: { state: 'ended' } },
      }),
      'loyalty.promotion.form': form(LoyaltyPromotion, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('look', { label: 'Preview' }),
            k.button('launch', {
              primary: true,
              label: 'Launch',
              confirm: 'Let quotations take this promotion from now on?',
            }),
            k.button('finish', { label: 'End' }),
          ],
        },
        sheet: [
          k.stats('related', [
            {
              id: 'promotion_lines',
              label: 'Order lines',
              model: 'sale.order.line',
              where: { promotion: { $record: 'id' } },
            },
          ]),
          k.group('main', ['name', 'kind', 'value', 'minimumOrder', 'code', 'exclusive'], {
            description:
              'Write it, press Preview to see what it would have taken off past orders, then Launch. On a quotation, Apply promotions takes every running promotion that applies.',
          }),
          k.group('scope', ['product', 'category', 'dateFrom', 'dateTo'], { label: 'Applies to' }),
          k.group('free', ['buy', 'get', 'rewardProduct'], {
            label: 'Buy and get',
            description:
              'Buy 2, get 1: of every three units of what it applies to, the cheapest is free. With a free product: one of it for every two bought.',
          }),
          k.group(
            'preview',
            [
              'previewFrom',
              'previewTo',
              'previewOrders',
              'previewApplied',
              'previewDiscount',
              'previewRevenue',
              'previewShare',
              'previewFree',
              'previewAt',
            ],
            {
              label: 'Preview',
              description:
                'What it would have taken off the confirmed orders of the period — the month before this one unless you give dates. A promotion with a code is counted as if every customer had typed it: the most it can cost.',
            },
          ),
        ],
        chatter: true,
      })),
      'loyalty.voucher.list': list(LoyaltyVoucher, {
        columns: ['code', 'kind', 'partner', { field: 'balance', sum: true }, 'dateExpiry'],
        decorations: { neutral: { balance: { lte: 0 } } },
      }),
      'loyalty.voucher.form': form(LoyaltyVoucher, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['code', 'kind', 'partner', 'dateExpiry', 'note', 'balance'], {
            description:
              'Load it with a line below. On a quotation, type its code and press Apply points and credit: it pays what the order still comes to, or all it holds.',
          }),
          k.lines('entries', [
            { field: 'date', id: 'movement_date' },
            { field: 'amount', id: 'movement_amount', sum: true },
            { field: 'note', id: 'movement_note' },
            { field: 'kind', id: 'movement_kind' },
          ]),
        ],
        chatter: true,
      })),
      'loyalty.voucher.entry.list': list(LoyaltyVoucherEntry, {
        columns: ['date', 'voucher', 'kind', { field: 'amount', sum: true }, 'note'],
        decorations: { danger: { amount: { lt: 0 } } },
      }),
      'loyalty.voucher.entry.form': form(LoyaltyVoucherEntry, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['voucher', 'date', 'amount', 'note', 'kind'])],
      })),
      'loyalty.entry.list': list(LoyaltyEntry, {
        columns: ['date', 'card', 'kind', { field: 'points', sum: true }, 'note'],
        decorations: { danger: { points: { lt: 0 } } },
      }),
      'loyalty.entry.form': form(LoyaltyEntry, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['card', 'date', 'points', 'note', 'kind'], {
            description:
              'A line added here is an adjustment: opening points, a gift, a correction. Lines are not changed afterwards — correct one with another. A card never goes below zero by hand.',
          }),
        ],
      })),
    },
    viewExtensions: [
      {
        view: 'sale.order.form',
        operations: [
          {
            append: 'dates',
            nodes: [
              field({ field: 'promoCode', id: 'loyalty_promo_code' }),
              field({ field: 'promotionAmount', id: 'loyalty_promotion_amount' }),
              field({ field: 'loyaltyRedeem', id: 'loyalty_redeem' }),
              field({ field: 'voucherCode', id: 'loyalty_voucher_code' }),
              field({ field: 'loyaltyRedeemed', id: 'loyalty_redeemed' }),
              field({ field: 'voucherUsed', id: 'loyalty_voucher_used' }),
              field({ field: 'loyaltyPoints', id: 'loyalty_points' }),
            ],
          },
          {
            append: 'header',
            nodes: [
              {
                kind: 'button',
                id: 'loyalty_promote',
                transition: 'promote',
                label: 'Apply promotions',
                visibleWhen: { state: 'draft' },
              },
              {
                kind: 'button',
                id: 'loyalty_credit',
                transition: 'credit',
                label: 'Apply points and credit',
                visibleWhen: { state: 'draft' },
              },
            ],
          },
        ],
      },
      {
        view: 'res.partner.form',
        operations: [
          {
            append: 'related',
            nodes: [
              stat({
                id: 'partner_loyalty_cards',
                label: 'Loyalty cards',
                model: 'loyalty.card',
                where: { partner: { $record: 'id' } },
                action: 'loyalty.action_cards',
              }),
            ],
          },
        ],
      },
    ],
    search: {
      'loyalty.program': search(LoyaltyProgram, {
        fields: ['name'],
        filters: { running: { label: 'Running', domain: { state: 'running' }, group: 'state' } },
        groupBy: ['state'],
      }),
      'loyalty.rule': search(LoyaltyRule, { fields: ['name'], groupBy: ['program', 'category'] }),
      'loyalty.tier': search(LoyaltyTier, { fields: ['name'], groupBy: ['program'] }),
      'loyalty.card': search(LoyaltyCard, {
        fields: ['code', 'partner.name'],
        filters: { holding: { label: 'With points', domain: { points: { gt: 0 } } } },
        groupBy: ['program', 'tier'],
      }),
      'loyalty.promotion': search(LoyaltyPromotion, {
        fields: ['name', 'code'],
        filters: { running: { label: 'Running', domain: { state: 'running' }, group: 'state' } },
        groupBy: ['state', 'kind'],
      }),
      'loyalty.voucher': search(LoyaltyVoucher, {
        fields: ['code', 'partner.name', 'note'],
        filters: {
          holding: { label: 'With a balance', domain: { balance: { gt: 0 } } },
          wallets: { label: 'Wallets', domain: { kind: 'wallet' }, group: 'kind' },
          gift_cards: { label: 'Gift cards', domain: { kind: 'gift_card' }, group: 'kind' },
        },
        groupBy: ['kind', 'partner'],
      }),
      'loyalty.voucher.entry': search(LoyaltyVoucherEntry, {
        fields: ['note', 'voucher.code'],
        groupBy: ['voucher', 'kind', 'date:month'],
      }),
      'loyalty.entry': search(LoyaltyEntry, {
        fields: ['note', 'card.code'],
        filters: {
          earned: { label: 'Earned', domain: { kind: 'earn' }, group: 'kind' },
          expired: { label: 'Expired', domain: { kind: 'expire' }, group: 'kind' },
          adjustments: { label: 'Adjustments', domain: { kind: 'adjust' }, group: 'kind' },
          spent: { label: 'Spent', domain: { kind: 'redeem' }, group: 'kind' },
        },
        groupBy: ['card', 'kind', 'date:month'],
      }),
    },
  });
}

export const loyalty: ReturnType<typeof defineModule> = loyaltyModule();
