/** Messages of the Projects screens (namespace `project`), in English and Bangla. */
export const messages: Readonly<Record<string, object>> = {
  en: {
    structure: {
      title: 'Structure',
      loading: 'Loading the structure…',
      empty: 'No phases or work packages yet. Add them below to see the plan as a tree.',
      phase: 'Phase',
      workPackage: 'Work package',
      task: 'Task',
      milestone: 'Milestone',
      waiting: 'Waiting',
      outside: 'Tasks outside any phase',
      progressOf: 'Progress of {{name}}',
    },
  },
  bn: {
    structure: {
      title: 'কাঠামো',
      loading: 'কাঠামো লোড হচ্ছে…',
      empty: 'এখনও কোনো ধাপ বা কাজের প্যাকেজ নেই। পরিকল্পনাটি গাছের মতো দেখতে নিচে যোগ করুন।',
      phase: 'ধাপ',
      workPackage: 'কাজের প্যাকেজ',
      task: 'কাজ',
      milestone: 'মাইলফলক',
      waiting: 'অপেক্ষমাণ',
      outside: 'কোনো ধাপের বাইরের কাজ',
      progressOf: '{{name}}-এর অগ্রগতি',
    },
  },
};
