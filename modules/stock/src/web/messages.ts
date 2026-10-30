/** Messages of the Stockroom screens (namespace `stock`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    scan: {
      title: 'Scan',
      barcode: 'Barcode',
      quantity: 'Quantity',
      add: 'Add',
      camera: 'Use the camera',
      stop: 'Stop the camera',
      counted: '{{product}}: {{counted}} counted',
    },
  },
  bn: {
    scan: {
      title: 'স্ক্যান',
      barcode: 'বারকোড',
      quantity: 'পরিমাণ',
      add: 'যোগ করুন',
      camera: 'ক্যামেরা ব্যবহার করুন',
      stop: 'ক্যামেরা বন্ধ করুন',
      counted: '{{product}}: {{counted}} গণনা হয়েছে',
    },
  },
};
