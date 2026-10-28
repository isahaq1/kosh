/** Messages of the Integrations app (namespace `integrations`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    tools: {
      title: 'Webhook tools',
      ping: 'Send a test event',
      pinged: 'A test event is on its way: see Deliveries.',
      rotate: 'New signing secret',
      events: 'Events you can subscribe to',
      eventsHint:
        'Put the events in the Events field, separated by spaces. A record’s payload is what the webhook’s user may read.',
      replay: 'Send again',
      replayed: 'Sent again: a new delivery is in Deliveries.',
    },
    endpoint: {
      title: 'Inbound webhook',
      url: 'URL to give the provider',
      urlHint: 'Calls are checked with the secret; refused ones stay in Inbound calls.',
      rotate: 'New secret',
      hooks: 'Endpoints the installed apps offer',
      hooksHint: 'Put one of them in the Endpoint field.',
      none: 'No installed app offers an inbound webhook.',
    },
    inbound: {
      replay: 'Handle again',
      replayed: 'Queued: the outcome appears here shortly.',
    },
  },
  bn: {
    tools: {
      title: 'ওয়েবহুক সরঞ্জাম',
      ping: 'পরীক্ষামূলক ইভেন্ট পাঠান',
      pinged: 'পরীক্ষামূলক ইভেন্ট পাঠানো হচ্ছে: ডেলিভারি দেখুন।',
      rotate: 'নতুন স্বাক্ষর গোপন কী',
      events: 'যেসব ইভেন্টে সাবস্ক্রাইব করা যায়',
      eventsHint:
        'ইভেন্টগুলো ইভেন্ট ঘরে ফাঁকা জায়গা দিয়ে আলাদা করে লিখুন। রেকর্ডের তথ্য ওয়েবহুকের ব্যবহারকারী যা পড়তে পারেন ততটুকুই।',
      replay: 'আবার পাঠান',
      replayed: 'আবার পাঠানো হয়েছে: ডেলিভারিতে নতুন একটি আছে।',
    },
    endpoint: {
      title: 'ইনবাউন্ড ওয়েবহুক',
      url: 'প্রোভাইডারকে দেওয়ার URL',
      urlHint: 'প্রতিটি কল গোপন কী দিয়ে যাচাই হয়; প্রত্যাখ্যাত কল ইনবাউন্ড কলে থাকে।',
      rotate: 'নতুন গোপন কী',
      hooks: 'ইনস্টল করা অ্যাপগুলোর এন্ডপয়েন্ট',
      hooksHint: 'এর একটি এন্ডপয়েন্ট ঘরে লিখুন।',
      none: 'কোনো ইনস্টল করা অ্যাপ ইনবাউন্ড ওয়েবহুক দেয় না।',
    },
    inbound: {
      replay: 'আবার প্রক্রিয়া করুন',
      replayed: 'সারিতে আছে: ফলাফল শীঘ্রই এখানে দেখা যাবে।',
    },
  },
};
