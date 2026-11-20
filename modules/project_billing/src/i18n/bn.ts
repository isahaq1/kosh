/** Bangla for the module's labels, keyed by their English text (RFC 0023 §3.1; `pnpm i18n:extract`). */
export const bn: Readonly<Record<string, string>> = {
  'A milestone has a price above zero.': 'মাইলফলকের দাম শূন্যের বেশি হতে হবে।',
  'A milestone on a billing statement does not change.': 'বিলিং বিবরণীতে থাকা মাইলফলক বদলানো যায় না।',
  'A posted recognition does not change.': 'পোস্ট করা স্বীকৃতি বদলানো যায় না।',
  'A rate is not negative.': 'রেট ঋণাত্মক হয় না।',
  'A rate names a person, a role or a kind of task (the card has the rate for everyone else).':
    'একটি রেটে একজন ব্যক্তি, একটি ভূমিকা বা এক ধরনের কাজ থাকতে হবে (বাকি সবার রেট কার্ডেই আছে)।',
  Active: 'সক্রিয়',
  Amount: 'পরিমাণ (টাকা)',
  'An hour of anyone no line names; empty: such an hour has no rate and cannot be approved.':
    'যাঁর নাম কোনো লাইনে নেই তাঁর এক ঘণ্টা; খালি: এমন ঘণ্টার কোনো রেট নেই এবং অনুমোদন করা যায় না।',
  'An invoiced statement does not change.': 'ইনভয়েস হওয়া বিবরণী বদলানো যায় না।',
  Approval: 'অনুমোদন',
  Approve: 'অনুমোদন করুন',
  Approved: 'অনুমোদিত',
  'Approved billable hours and reached milestones that are on no posted invoice yet, at what they sell for.':
    'অনুমোদিত বিলযোগ্য ঘণ্টা ও অর্জিত মাইলফলক, যা এখনো কোনো পোস্ট করা ইনভয়েসে নেই, বিক্রয় মূল্যে।',
  'Approved billable hours on the phase’s tasks at their rate, and reached milestones tied to its tasks.':
    'ধাপের কাজগুলোর অনুমোদিত বিলযোগ্য ঘণ্টা তাদের রেটে, এবং এর কাজের সাথে যুক্ত অর্জিত মাইলফলক।',
  'Approved by': 'অনুমোদন করেছেন',
  'Approved hours are reopened by a Projects manager, and not once they are on a billing statement.':
    'অনুমোদিত ঘণ্টা প্রজেক্ট ম্যানেজার আবার খুলতে পারেন, তবে বিলিং বিবরণীতে উঠে গেলে নয়।',
  'Approved hours of this day and before; reached milestones whatever their day.':
    'এই দিন ও তার আগের অনুমোদিত ঘণ্টা; অর্জিত মাইলফলক যে দিনেরই হোক।',
  'Before taxes: one invoice line of this amount when the milestone is reached.':
    'কর বাদে: মাইলফলক অর্জিত হলে এই পরিমাণের একটি ইনভয়েস লাইন।',
  Billable: 'বিলযোগ্য',
  'Billed per hour': 'প্রতি ঘণ্টায় বিল',
  'Billed to the customer': 'গ্রাহককে বিল করা হয়',
  Billing: 'বিলিং',
  'Billing milestone': 'বিলিং মাইলফলক',
  'Billing milestone reached': 'বিলিং মাইলফলক অর্জিত',
  'Billing milestones': 'বিলিং মাইলফলক',
  'Billing Milestones': 'বিলিং মাইলফলক',
  'Billing statement': 'বিলিং বিবরণী',
  'Billing statement {{name}}': 'বিলিং বিবরণী {{name}}',
  'Billing statement invoiced': 'বিলিং বিবরণী ইনভয়েস হয়েছে',
  'Billing statements': 'বিলিং বিবরণী',
  'Book the work in progress of every billed project on that day as revenue, reversed the day after?':
    'ওই দিনে প্রতিটি বিল করা প্রজেক্টের চলমান কাজ আয় হিসেবে বুক করবেন, পরের দিন উল্টানোসহ?',
  'Cancel its invoice first (a posted invoice is corrected by a credit note).':
    'আগে এর ইনভয়েস বাতিল করুন (পোস্ট করা ইনভয়েস ক্রেডিট নোট দিয়ে সংশোধন হয়)।',
  Cancelled: 'বাতিল',
  Card: 'কার্ড',
  Company: 'কোম্পানি',
  'Created At': 'তৈরির সময়',
  'Created By': 'তৈরি করেছেন',
  Customer: 'গ্রাহক',
  Date: 'তারিখ',
  Discard: 'বাদ দিন',
  'Display Name': 'প্রদর্শিত নাম',
  Draft: 'খসড়া',
  'Draft until it is invoiced; cancelled when it was discarded, or released after its invoice was cancelled.':
    'ইনভয়েস না হওয়া পর্যন্ত খসড়া; বাদ দিলে, অথবা ইনভয়েস বাতিলের পর ছেড়ে দিলে বাতিল।',
  Earned: 'অর্জিত আয়',
  'Earned less labour cost (costs booked in Accounting are the project’s, not a phase’s).':
    'অর্জিত আয় থেকে শ্রম খরচ বাদ (হিসাবে বুক করা খরচ প্রজেক্টের, ধাপের নয়)।',
  'Empty: the project’s service.': 'খালি: প্রজেক্টের সেবা।',
  Entry: 'এন্ট্রি',
  Expected: 'প্রত্যাশিত',
  'From the project’s rate card on the day it was approved; a later change of the card does not move it.':
    'অনুমোদনের দিনে প্রজেক্টের রেট কার্ড থেকে; পরে কার্ড বদলালে এটি বদলায় না।',
  Hours: 'ঘণ্টা',
  'Hours are approved or refused by a Projects manager, never one’s own; a refusal says why; on a billed project every hour needs a rate (the project’s rate card).':
    'ঘণ্টা অনুমোদন বা প্রত্যাখ্যান করেন প্রজেক্ট ম্যানেজার, নিজের ঘণ্টা কখনো নয়; প্রত্যাখ্যানে কারণ লিখতে হয়; বিল করা প্রজেক্টে প্রতিটি ঘণ্টার রেট লাগে (প্রজেক্টের রেট কার্ড)।',
  'Hours to approve': 'অনুমোদনের অপেক্ষায় ঘণ্টা',
  'Hours up to': 'যে দিন পর্যন্ত ঘণ্টা',
  ID: 'আইডি',
  'In the books': 'হিসাবের খাতায়',
  Invoice: 'ইনভয়েস',
  'Invoice the project’s approved hours up to that day and its reached milestones?':
    'ওই দিন পর্যন্ত প্রজেক্টের অনুমোদিত ঘণ্টা ও অর্জিত মাইলফলক ইনভয়েস করবেন?',
  Invoiced: 'ইনভয়েস হয়েছে',
  'Invoiced as': 'যে নামে ইনভয়েস হয়',
  'Invoiced revenue': 'ইনভয়েস করা আয়',
  'Invoiced revenue and work in progress, less labour and booked costs.':
    'ইনভয়েস করা আয় ও চলমান কাজ, শ্রম ও বুক করা খরচ বাদে।',
  'It is on a billing statement: release the statement first.':
    'এটি একটি বিলিং বিবরণীতে আছে: আগে বিবরণীটি ছেড়ে দিন।',
  'Its approved hours and reached milestones are invoiced through billing statements.':
    'এর অনুমোদিত ঘণ্টা ও অর্জিত মাইলফলক বিলিং বিবরণীর মাধ্যমে ইনভয়েস হয়।',
  'Its task is not done yet.': 'এর কাজ এখনো শেষ হয়নি।',
  'Kind of task': 'কাজের ধরন',
  'Labour cost': 'শ্রম খরচ',
  Lines: 'লাইন',
  'Make the invoice': 'ইনভয়েস তৈরি করুন',
  'Make the invoice gathers the project’s approved billable hours up to the day and its reached milestones; each is invoiced once.':
    '‘ইনভয়েস তৈরি করুন’ ওই দিন পর্যন্ত প্রজেক্টের অনুমোদিত বিলযোগ্য ঘণ্টা ও অর্জিত মাইলফলক একত্র করে; প্রতিটি একবারই ইনভয়েস হয়।',
  'Margin %': 'মার্জিন %',
  Milestone: 'মাইলফলক',
  Milestones: 'মাইলফলক',
  Name: 'নাম',
  'New billing statement': 'নতুন বিলিং বিবরণী',
  'Not reached after all': 'আসলে অর্জিত হয়নি',
  Note: 'নোট',
  'Nothing to invoice: no approved billable hours up to that day, and no reached milestone.':
    'ইনভয়েস করার কিছু নেই: ওই দিন পর্যন্ত কোনো অনুমোদিত বিলযোগ্য ঘণ্টা নেই, কোনো অর্জিত মাইলফলকও নেই।',
  'Off: time the customer does not pay for (it still costs, and still needs approving).':
    'বন্ধ: যে সময়ের জন্য গ্রাহক টাকা দেন না (তবু খরচ হয়, এবং অনুমোদন লাগে)।',
  On: 'তারিখ',
  'Optional: with a task, the milestone cannot be reached before the task is done.':
    'ঐচ্ছিক: কাজ দেওয়া থাকলে, কাজ শেষ হওয়ার আগে মাইলফলক অর্জিত ধরা যায় না।',
  'Page {{page}} of {{pages}}': 'পৃষ্ঠা {{page}} / {{pages}}',
  'Per hour': 'প্রতি ঘণ্টায়',
  Person: 'ব্যক্তি',
  Posted: 'পোস্ট করা',
  'Posted customer invoices and credit notes on the project’s cost centre, before taxes.':
    'প্রজেক্টের কস্ট সেন্টারে পোস্ট করা গ্রাহক ইনভয়েস ও ক্রেডিট নোট, কর বাদে।',
  'Posted: its entry is in the books on the day, and reversed the day after.':
    'পোস্ট করা: এর এন্ট্রি ওই দিনে খাতায় আছে, এবং পরের দিন উল্টানো হয়েছে।',
  Price: 'দাম',
  Profit: 'লাভ',
  'Profit as a share of invoiced revenue and work in progress.':
    'ইনভয়েস করা আয় ও চলমান কাজের অংশ হিসেবে লাভ।',
  Project: 'প্রজেক্ট',
  'Project billing': 'প্রজেক্ট বিলিং',
  'Project billing (rate cards, milestones, statements)': 'প্রজেক্ট বিলিং (রেট কার্ড, মাইলফলক, বিবরণী)',
  Rate: 'রেট',
  'Rate card': 'রেট কার্ড',
  'Rate cards': 'রেট কার্ড',
  'Rate cards (with their rates)': 'রেট কার্ড (রেটসহ)',
  'Rate for everyone else': 'বাকি সবার রেট',
  Rates: 'রেট',
  'Rates › Kind of task': 'রেট › কাজের ধরন',
  'Rates › Per hour': 'রেট › প্রতি ঘণ্টায়',
  'Rates › Person': 'রেট › ব্যক্তি',
  'Rates › Role': 'রেট › ভূমিকা',
  Reached: 'অর্জিত',
  'Reached on': 'অর্জনের তারিখ',
  'Reached when this task is done': 'এই কাজ শেষ হলে অর্জিত',
  'Reached, not invoiced': 'অর্জিত, ইনভয়েস হয়নি',
  'Reached: delivered, and on the project’s next billing statement.':
    'অর্জিত: সরবরাহ হয়েছে, এবং প্রজেক্টের পরের বিলিং বিবরণীতে উঠবে।',
  Recognise: 'স্বীকৃতি দিন',
  Recognised: 'স্বীকৃত',
  'Recognised work': 'স্বীকৃত কাজ',
  Recognition: 'স্বীকৃতি',
  'Records must reference shared records or records of their own company.':
    'রেকর্ডকে শেয়ার করা রেকর্ড বা নিজের কোম্পানির রেকর্ড নির্দেশ করতে হবে।',
  Reference: 'রেফারেন্স',
  Refuse: 'প্রত্যাখ্যান করুন',
  Refused: 'প্রত্যাখ্যাত',
  Release: 'ছেড়ে দিন',
  'Release its hours and milestones, so that they can be invoiced again? Its invoice must be cancelled.':
    'এর ঘণ্টা ও মাইলফলক ছেড়ে দেবেন, যাতে আবার ইনভয়েস করা যায়? এর ইনভয়েস বাতিল থাকতে হবে।',
  Reopen: 'আবার খুলুন',
  'Revenue is already recognised on that day.': 'ওই দিনের আয় ইতিমধ্যে স্বীকৃত হয়েছে।',
  'Revenue recognised': 'আয় স্বীকৃত হয়েছে',
  'Revenue recognition': 'আয় স্বীকৃতি',
  'Revenue recognition {{name}}': 'আয় স্বীকৃতি {{name}}',
  'Reversed by': 'যে এন্ট্রি দিয়ে উল্টানো',
  Role: 'ভূমিকা',
  Sequence: 'ক্রম',
  State: 'অবস্থা',
  Submit: 'জমা দিন',
  Submitted: 'জমা দেওয়া হয়েছে',
  'Submitted and approved hours do not change: reopen them first.':
    'জমা দেওয়া ও অনুমোদিত ঘণ্টা বদলানো যায় না: আগে আবার খুলুন।',
  'Submitted by the person, approved or refused by a Projects manager; only approved hours are invoiced.':
    'ব্যক্তি জমা দেন, প্রজেক্ট ম্যানেজার অনুমোদন বা প্রত্যাখ্যান করেন; শুধু অনুমোদিত ঘণ্টাই ইনভয়েস হয়।',
  Task: 'কাজ',
  'The hours on the phase’s tasks at each person’s cost.': 'ধাপের কাজগুলোর ঘণ্টা, প্রত্যেকের খরচের হারে।',
  'The most specific line wins: a person before a role, a role before a kind of task.':
    'সবচেয়ে নির্দিষ্ট লাইনটি প্রযোজ্য: ভূমিকার আগে ব্যক্তি, কাজের ধরনের আগে ভূমিকা।',
  'The most specific rate wins: a person before a role, a role before a kind of task; then the rate for everyone else.':
    'সবচেয়ে নির্দিষ্ট রেটটি প্রযোজ্য: ভূমিকার আগে ব্যক্তি, কাজের ধরনের আগে ভূমিকা; তারপর বাকি সবার রেট।',
  'The service on the invoice lines: its income account and its sales taxes.':
    'ইনভয়েস লাইনের সেবা: এর আয়ের হিসাব ও বিক্রয় কর।',
  'The work in progress of every billed project on that day, booked as revenue.':
    'ওই দিনে প্রতিটি বিল করা প্রজেক্টের চলমান কাজ, আয় হিসেবে বুক করা।',
  Time: 'সময়',
  'Time and milestones together: what the invoice was made for.':
    'সময় ও মাইলফলক একসাথে: যে পরিমাণের ইনভয়েস তৈরি হয়েছে।',
  Timesheets: 'টাইমশিট',
  'To bill': 'বিল করতে হবে',
  'To reach': 'অর্জন বাকি',
  'To submit': 'জমা দিতে হবে',
  'Total before taxes': 'কর বাদে মোট',
  'Updated At': 'হালনাগাদের সময়',
  'Updated By': 'হালনাগাদ করেছেন',
  'Usually the last day of a month: work approved up to this day and not on a posted invoice.':
    'সাধারণত মাসের শেষ দিন: এই দিন পর্যন্ত অনুমোদিত কাজ, যা কোনো পোস্ট করা ইনভয়েসে নেই।',
  'What an hour is sold for; frozen on each hour when it is approved.':
    'এক ঘণ্টা যে দামে বিক্রি হয়; অনুমোদনের সময় প্রতিটি ঘণ্টায় স্থির হয়ে যায়।',
  'Why refused': 'প্রত্যাখ্যানের কারণ',
  'Work approved up to the day and on no posted invoice is booked as revenue on that day — accrued income against income, on each project’s cost centre — and reversed the day after, so the invoices that follow are not counted twice.':
    'ওই দিন পর্যন্ত অনুমোদিত, কোনো পোস্ট করা ইনভয়েসে নেই এমন কাজ ওই দিনে আয় হিসেবে বুক হয় — প্রাপ্য আয়ের বিপরীতে আয়, প্রতিটি প্রজেক্টের কস্ট সেন্টারে — এবং পরের দিন উল্টানো হয়, যাতে পরের ইনভয়েস দুবার গণনা না হয়।',
  'Work done': 'যে কাজ হয়েছে',
  'Work in progress': 'চলমান কাজ',
};
