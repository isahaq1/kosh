/**
 * Amounts in words for documents (RFC 0016 §5.1): `{{amountTotal|words}}` on an invoice writes "Taka One Lakh Twenty
 * Thousand Only", or in Bangla "এক লক্ষ বিশ হাজার টাকা মাত্র". South Asian currencies count in lakh and crore,
 * the others in thousands and millions. Exact: the amount is decimal text, never a float.
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99 in Bangla: each number has its own word. */
const BN = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'পনেরো',
  'ষোলো',
  'সতেরো',
  'আঠারো',
  'উনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'একত্রিশ',
  'বত্রিশ',
  'তেত্রিশ',
  'চৌত্রিশ',
  'পঁয়ত্রিশ',
  'ছত্রিশ',
  'সাঁইত্রিশ',
  'আটত্রিশ',
  'ঊনচল্লিশ',
  'চল্লিশ',
  'একচল্লিশ',
  'বিয়াল্লিশ',
  'তেতাল্লিশ',
  'চুয়াল্লিশ',
  'পঁয়তাল্লিশ',
  'ছেচল্লিশ',
  'সাতচল্লিশ',
  'আটচল্লিশ',
  'ঊনপঞ্চাশ',
  'পঞ্চাশ',
  'একান্ন',
  'বায়ান্ন',
  'তিপ্পান্ন',
  'চুয়ান্ন',
  'পঞ্চান্ন',
  'ছাপ্পান্ন',
  'সাতান্ন',
  'আটান্ন',
  'ঊনষাট',
  'ষাট',
  'একষট্টি',
  'বাষট্টি',
  'তেষট্টি',
  'চৌষট্টি',
  'পঁয়ষট্টি',
  'ছেষট্টি',
  'সাতষট্টি',
  'আটষট্টি',
  'ঊনসত্তর',
  'সত্তর',
  'একাত্তর',
  'বাহাত্তর',
  'তিয়াত্তর',
  'চুয়াত্তর',
  'পঁচাত্তর',
  'ছিয়াত্তর',
  'সাতাত্তর',
  'আটাত্তর',
  'ঊনআশি',
  'আশি',
  'একাশি',
  'বিরাশি',
  'তিরাশি',
  'চুরাশি',
  'পঁচাশি',
  'ছিয়াশি',
  'সাতাশি',
  'আটাশি',
  'ঊননব্বই',
  'নব্বই',
  'একানব্বই',
  'বিরানব্বই',
  'তিরানব্বই',
  'চুরানব্বই',
  'পঁচানব্বই',
  'ছিয়ানব্বই',
  'সাতানব্বই',
  'আটানব্বই',
  'নিরানব্বই',
];

/** Currencies counted in lakh and crore. */
const SOUTH_ASIAN = new Set(['BDT', 'INR', 'PKR', 'NPR', 'LKR']);

const UNITS: Readonly<Record<string, { en: [string, string]; bn: [string, string] }>> = {
  BDT: { en: ['Taka', 'Paisa'], bn: ['টাকা', 'পয়সা'] },
  INR: { en: ['Rupees', 'Paise'], bn: ['রুপি', 'পয়সা'] },
  PKR: { en: ['Rupees', 'Paisa'], bn: ['রুপি', 'পয়সা'] },
  USD: { en: ['Dollars', 'Cents'], bn: ['ডলার', 'সেন্ট'] },
  EUR: { en: ['Euros', 'Cents'], bn: ['ইউরো', 'সেন্ট'] },
  GBP: { en: ['Pounds', 'Pence'], bn: ['পাউন্ড', 'পেনি'] },
};

function under1000(value: number): string {
  const parts: string[] = [];
  let n = value;
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] as string);
    n %= 10;
  }
  if (n > 0) parts.push(ONES[n] as string);
  return parts.join(' ');
}

/** A whole number in English words, by lakh and crore or by thousands. */
export function englishWords(value: bigint, southAsian: boolean): string {
  if (value === 0n) return 'Zero';
  const parts: string[] = [];
  let n = value;
  const scales: readonly [bigint, string][] = southAsian
    ? [
        [10_000_000n, 'Crore'],
        [100_000n, 'Lakh'],
        [1_000n, 'Thousand'],
      ]
    : [
        [1_000_000_000_000n, 'Trillion'],
        [1_000_000_000n, 'Billion'],
        [1_000_000n, 'Million'],
        [1_000n, 'Thousand'],
      ];
  for (const [scale, name] of scales) {
    if (n < scale) continue;
    const count = n / scale;
    n %= scale;
    // Above the largest scale (crores of crores), the count is itself in words.
    parts.push(
      `${count >= 1000n ? englishWords(count, southAsian) : under1000(Number(count))} ${name}`,
    );
  }
  if (n > 0n) parts.push(under1000(Number(n)));
  return parts.join(' ');
}

/** A whole number in Bangla words (always lakh and crore, as Bangla counts). */
export function banglaWords(value: bigint): string {
  if (value === 0n) return BN[0] as string;
  const parts: string[] = [];
  let n = value;
  for (const [scale, name] of [
    [10_000_000n, 'কোটি'],
    [100_000n, 'লক্ষ'],
    [1_000n, 'হাজার'],
    [100n, 'শত'],
  ] as const) {
    if (n < scale) continue;
    const count = n / scale;
    n %= scale;
    const words = count >= 100n ? banglaWords(count) : (BN[Number(count)] as string);
    parts.push(scale === 100n ? `${words}${name}` : `${words} ${name}`);
  }
  if (n > 0n) parts.push(BN[Number(n)] as string);
  return parts.join(' ');
}

/** An amount (decimal text) of `currency` in words, in English or Bangla, ending "Only" / "মাত্র". */
export function amountInWords(amount: string, currency: string, lang: string): string {
  const negative = amount.trim().startsWith('-');
  const [whole = '0', fraction = ''] = amount.trim().replace(/^[-+]/, '').split('.');
  const major = BigInt(whole === '' ? '0' : whole);
  const minor = BigInt(`${fraction}00`.slice(0, 2));
  const bangla = lang.startsWith('bn');
  const units = UNITS[currency]?.[bangla ? 'bn' : 'en'] ?? [currency, bangla ? 'পয়সা' : 'Cents'];
  if (bangla) {
    const parts = [`${banglaWords(major)} ${units[0]}`];
    if (minor > 0n) parts.push(`${banglaWords(minor)} ${units[1]}`);
    return `${negative ? 'ঋণাত্মক ' : ''}${parts.join(' ')} মাত্র`;
  }
  const southAsian = SOUTH_ASIAN.has(currency);
  const parts = [`${units[0]} ${englishWords(major, southAsian)}`];
  if (minor > 0n) parts.push(`and ${englishWords(minor, southAsian)} ${units[1]}`);
  return `${negative ? 'Minus ' : ''}${parts.join(' ')} Only`;
}
