/** Amounts in words (RFC 0016 §5.1): lakh and crore for the taka, thousands and millions elsewhere, Bangla. */
import { expect, test } from 'vitest';
import { amountInWords, banglaWords, englishWords } from '../src/words.js';

test('English in lakh and crore for South Asian currencies', () => {
  expect(amountInWords('120000.00', 'BDT', 'en')).toBe('Taka One Lakh Twenty Thousand Only');
  expect(amountInWords('12345678.50', 'BDT', 'en')).toBe(
    'Taka One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paisa Only',
  );
  expect(amountInWords('0.05', 'BDT', 'en')).toBe('Taka Zero and Five Paisa Only');
  expect(amountInWords('1500', 'INR', 'en_IN')).toBe('Rupees One Thousand Five Hundred Only');
});

test('English in thousands and millions elsewhere', () => {
  expect(amountInWords('1234567.89', 'USD', 'en')).toBe(
    'Dollars One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Cents Only',
  );
  expect(englishWords(1_000_000_000n, false)).toBe('One Billion');
});

test('Bangla', () => {
  expect(amountInWords('120500.50', 'BDT', 'bn_BD')).toBe('এক লক্ষ বিশ হাজার পাঁচশত টাকা পঞ্চাশ পয়সা মাত্র');
  expect(banglaWords(99n)).toBe('নিরানব্বই');
  expect(banglaWords(21_00_00_000n)).toBe('একুশ কোটি');
  expect(banglaWords(1_15_00_00_000n)).toBe('একশত পনেরো কোটি');
  expect(amountInWords('-1', 'BDT', 'bn')).toBe('ঋণাত্মক এক টাকা মাত্র');
});
