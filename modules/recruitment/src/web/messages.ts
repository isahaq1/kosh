/** Messages of the Hiring screens (namespace `recruitment`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    hire: {
      button: 'Hire',
      title: 'Hire {{name}}',
      explain:
        'They become an employee in Workforce with the opening’s position and department, move to the hired stage, and the opening closes when everyone it was for is hired.',
      confirm: 'Hire',
    },
    cv: {
      button: 'Read the CV',
      title: 'The CV of {{name}}',
      explain:
        'The AI assistant read {{file}} and proposes this. Check it against the CV, tick what to keep: nothing is saved until you do.',
      keep: 'Keep what is ticked',
      nothing: 'The assistant found nothing to propose in the CV.',
      heading: 'From the CV ({{file}}), read by the AI assistant:',
      experience: 'Years of experience',
      education: 'Education',
      skills: 'Skills',
      fields: { name: 'Candidate', email: 'Email', phone: 'Phone', notes: 'Add to the notes' },
    },
  },
  bn: {
    hire: {
      button: 'নিয়োগ দিন',
      title: '{{name}}-কে নিয়োগ দিন',
      explain:
        'তিনি পদ ও বিভাগসহ ওয়ার্কফোর্সে কর্মী হবেন, নিয়োগপ্রাপ্ত ধাপে যাবেন, এবং যত জনের জন্য পদটি ছিল সবাই নিয়োগ পেলে পদটি বন্ধ হবে।',
      confirm: 'নিয়োগ দিন',
    },
    cv: {
      button: 'সিভি পড়ুন',
      title: '{{name}}-এর সিভি',
      explain:
        'এআই সহকারী {{file}} পড়ে এটি প্রস্তাব করছে। সিভির সঙ্গে মিলিয়ে দেখুন, যা রাখবেন তাতে টিক দিন: আপনি না রাখা পর্যন্ত কিছুই সংরক্ষিত হয় না।',
      keep: 'টিক দেওয়াগুলো রাখুন',
      nothing: 'সহকারী সিভিতে প্রস্তাব করার মতো কিছু পায়নি।',
      heading: 'সিভি ({{file}}) থেকে, এআই সহকারীর পড়া:',
      experience: 'অভিজ্ঞতার বছর',
      education: 'শিক্ষা',
      skills: 'দক্ষতা',
      fields: { name: 'প্রার্থী', email: 'ইমেইল', phone: 'ফোন', notes: 'নোটে যোগ করুন' },
    },
  },
};
