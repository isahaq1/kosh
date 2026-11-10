/** Messages of the Products screens (namespace `product`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    grid: {
      open: 'Add variants from a template…',
      title: 'Variants from a template',
      description: 'Pick a template, type the quantities and one line is added per variant.',
      search: 'Template',
      placeholder: 'Type to search the templates',
      none: 'No template matches.',
      quantity: 'Quantity',
      empty: 'No such variant',
      add: 'Add {{count}} lines',
      add_one: 'Add 1 line',
      cancel: 'Cancel',
      saveFirst: 'Save the record first, then add variants.',
    },
  },
  bn: {
    grid: {
      open: 'টেমপ্লেট থেকে ভ্যারিয়েন্ট যোগ করুন…',
      title: 'টেমপ্লেট থেকে ভ্যারিয়েন্ট',
      description: 'একটি টেমপ্লেট বেছে নিন, পরিমাণ লিখুন; প্রতিটি ভ্যারিয়েন্টে একটি লাইন যোগ হবে।',
      search: 'টেমপ্লেট',
      placeholder: 'টেমপ্লেট খুঁজতে লিখুন',
      none: 'কোনো টেমপ্লেট মেলেনি।',
      quantity: 'পরিমাণ',
      empty: 'এমন ভ্যারিয়েন্ট নেই',
      add: '{{count}}টি লাইন যোগ করুন',
      add_one: '১টি লাইন যোগ করুন',
      cancel: 'বাতিল',
      saveFirst: 'আগে রেকর্ড সংরক্ষণ করুন, তারপর ভ্যারিয়েন্ট যোগ করুন।',
    },
  },
};
