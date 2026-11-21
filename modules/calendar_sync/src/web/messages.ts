/** Messages of Agenda › My other calendars (namespace `calendarSync`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    title: 'My other calendars',
    intro:
      'Keep Agenda and your Google or Microsoft 365 calendar in step: your own events here appear there, and what you add there appears here.',
    loading: 'Loading…',
    mine: 'Connected',
    none: 'No calendar is connected yet.',
    never: 'Not synced yet',
    lastSynced: 'Last synced {{when}}',
    syncNow: 'Sync now',
    syncNamed: 'Sync {{name}} now',
    disconnect: 'Disconnect',
    disconnectNamed: 'Disconnect {{name}}',
    connect: 'Connect a calendar',
    connectTo: 'Connect {{name}}',
    notConfigured: 'Not set up on this server yet.',
    notReady:
      'Calendar sync is not set up on this server: an administrator sets KOSH_SECRETS_KEY, and registers the app with Google or Microsoft.',
    connected: 'The calendar is connected, and was synced.',
    refused:
      'The calendar was not connected. Try again; the permission may have been refused or taken too long.',
    what: 'What comes from your other calendar is private here: others see only that you are busy. Disconnecting leaves the events where they are, on both sides. Attendees, rooms and reminders are not carried.',
  },
  bn: {
    title: 'আমার অন্য ক্যালেন্ডার',
    intro:
      'Agenda এবং আপনার Google বা Microsoft 365 ক্যালেন্ডার মিলিয়ে রাখুন: এখানকার আপনার নিজের ইভেন্ট সেখানে দেখা যায়, আর সেখানে যা যোগ করেন তা এখানে দেখা যায়।',
    loading: 'লোড হচ্ছে…',
    mine: 'সংযুক্ত',
    none: 'এখনো কোনো ক্যালেন্ডার সংযুক্ত নেই।',
    never: 'এখনো সিঙ্ক হয়নি',
    lastSynced: 'শেষ সিঙ্ক {{when}}',
    syncNow: 'এখন সিঙ্ক করুন',
    syncNamed: '{{name}} এখন সিঙ্ক করুন',
    disconnect: 'সংযোগ বিচ্ছিন্ন করুন',
    disconnectNamed: '{{name}}-এর সংযোগ বিচ্ছিন্ন করুন',
    connect: 'ক্যালেন্ডার সংযুক্ত করুন',
    connectTo: '{{name}} সংযুক্ত করুন',
    notConfigured: 'এই সার্ভারে এখনো সেট আপ করা হয়নি।',
    notReady:
      'এই সার্ভারে ক্যালেন্ডার সিঙ্ক সেট আপ করা নেই: একজন অ্যাডমিনিস্ট্রেটর KOSH_SECRETS_KEY সেট করবেন এবং Google বা Microsoft-এ অ্যাপটি নিবন্ধন করবেন।',
    connected: 'ক্যালেন্ডার সংযুক্ত হয়েছে এবং সিঙ্ক করা হয়েছে।',
    refused: 'ক্যালেন্ডার সংযুক্ত হয়নি। আবার চেষ্টা করুন; অনুমতি প্রত্যাখ্যাত হয়ে থাকতে পারে বা বেশি সময় লেগেছে।',
    what: 'আপনার অন্য ক্যালেন্ডার থেকে যা আসে তা এখানে ব্যক্তিগত: অন্যরা শুধু দেখেন আপনি ব্যস্ত। সংযোগ বিচ্ছিন্ন করলে ইভেন্টগুলো দুই দিকেই যেখানে আছে সেখানেই থাকে। অংশগ্রহণকারী, কক্ষ ও রিমাইন্ডার বহন করা হয় না।',
  },
};
