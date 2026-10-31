/** Messages of the Event Hub screens (namespace `event`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    checkin: {
      title: 'Check-in',
      code: 'Ticket code',
      go: 'Check in',
      camera: 'Scan with the camera',
      stop: 'Stop the camera',
      done: '{{name}} checked in {{ticket}}',
    },
  },
  bn: {
    checkin: {
      title: 'চেক-ইন',
      code: 'টিকিট কোড',
      go: 'চেক-ইন করুন',
      camera: 'ক্যামেরায় স্ক্যান করুন',
      stop: 'ক্যামেরা বন্ধ করুন',
      done: '{{name}} চেক-ইন হয়েছে {{ticket}}',
    },
  },
};
