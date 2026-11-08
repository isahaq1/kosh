/** Messages of the Purchase with receipts components (namespace `purchase_stock`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    scorecard: {
      title: 'Vendor scorecard (last 12 months)',
      onTime: 'On time',
      receipts: '{{onTime}} of {{count}} receipts',
      lead: 'Average lead time',
      days_one: '{{count}} day',
      days_other: '{{count}} days',
      orders: 'Orders',
      price: 'last {{last}}, average {{average}} ({{change}}%)',
    },
  },
  bn: {
    scorecard: {
      title: 'সরবরাহকারীর স্কোরকার্ড (গত ১২ মাস)',
      onTime: 'সময়মতো',
      receipts: '{{count}}টি রিসিটের {{onTime}}টি',
      lead: 'গড় সরবরাহ সময়',
      days_one: '{{count}} দিন',
      days_other: '{{count}} দিন',
      orders: 'অর্ডার',
      price: 'শেষ {{last}}, গড় {{average}} ({{change}}%)',
    },
  },
};
