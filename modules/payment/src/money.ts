/** Amounts in a currency's subunits, as payment providers take them (`'1500.00'` INR ↔ 150000). */

/** Currencies without subunits, and with three decimals (Stripe's and Razorpay's lists). */
const ZERO = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Decimal places of a currency's subunit. */
export function decimalsOf(currency: string): number {
  const code = currency.toUpperCase();
  return ZERO.has(code) ? 0 : THREE.has(code) ? 3 : 2;
}
/** `'1500.00'` INR → 150000. */
export function toSubunits(amount: string, currency: string): number {
  const d = decimalsOf(currency);
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(`${whole}${fraction.padEnd(d, '0').slice(0, d)}`);
}
/** 150000 INR → `'1500.00'`. */
export function fromSubunits(subunits: number, currency: string): string {
  const d = decimalsOf(currency);
  return (subunits / 10 ** d).toFixed(d);
}
