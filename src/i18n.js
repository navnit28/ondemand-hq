// i18n.js — EN/AR localisation readiness: extracted UI strings + bilingual
// status terms. RTL-safe: Arabic strings render with dir="rtl" via the helpers.
// Language auto-follows the browser (ar* → Arabic) and can be forced with
// localStorage.odaLang = 'en' | 'ar'.

export const LANG = (() => {
  try {
    const forced = window.localStorage?.getItem('odaLang');
    if (forced === 'ar' || forced === 'en') return forced;
    return (navigator.language || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  } catch { return 'en'; }
})();

export const isRTL = LANG === 'ar';

// Bilingual swirl terms (BUILD spec §1) — cycled during first-token wait.
export const SWIRL_TERMS = [
  { en: 'Analysing', ar: 'تحليل' },
  { en: 'Orchestrating', ar: 'تنسيق' },
  { en: 'Researching', ar: 'بحث' },
  { en: 'Verifying', ar: 'تحقق' },
  { en: 'Preparing', ar: 'تجهيز' },
  { en: 'Intelligence', ar: 'ذكاء' },
  { en: 'Innovation', ar: 'ابتكار' },
  { en: 'Sovereignty', ar: 'سيادة' },
  { en: 'Knowledge', ar: 'معرفة' },
  { en: 'Impact', ar: 'أثر' },
  { en: 'Future', ar: 'المستقبل' },
  { en: 'Collaboration', ar: 'تعاون' },
];

const STRINGS = {
  en: {
    greeting: 'What are we producing today?',
    newChat: 'New chat',
    quickStart: 'Quick start',
    record: 'Record a voice note',
    stopRecording: 'Stop recording',
    cancelRecording: 'Cancel',
    pauseRecording: 'Pause',
    resumeRecording: 'Resume',
    transcribing: 'Transcribing…',
    editTranscript: 'Edit the transcript, then send',
    listen: 'Listen',
    regenerateAudio: 'Regenerate audio',
    play: 'Play',
    pause: 'Pause',
    stop: 'Stop',
    speed: 'Speed',
    voice: 'Voice',
    download: 'Download',
    preparing: 'Preparing…',
    retry: 'Retry',
    debugMode: 'Debug',
    standardMode: 'Standard',
    offline: 'You appear to be offline — your draft is kept locally and nothing has been lost. Reconnect to continue.',
    micDenied: 'Microphone access was denied. Enable it in your browser settings to record.',
    micUnavailable: 'No microphone was found on this device.',
    speechUnavailable: 'Speech services are not enabled on this workspace yet.',
  },
  ar: {
    greeting: 'ماذا ننتج اليوم؟',
    newChat: 'محادثة جديدة',
    quickStart: 'بداية سريعة',
    record: 'تسجيل ملاحظة صوتية',
    stopRecording: 'إيقاف التسجيل',
    cancelRecording: 'إلغاء',
    pauseRecording: 'إيقاف مؤقت',
    resumeRecording: 'استئناف',
    transcribing: 'جارٍ التفريغ…',
    editTranscript: 'حرّر النص ثم أرسل',
    listen: 'استماع',
    regenerateAudio: 'إعادة توليد الصوت',
    play: 'تشغيل',
    pause: 'إيقاف مؤقت',
    stop: 'إيقاف',
    speed: 'السرعة',
    voice: 'الصوت',
    download: 'تنزيل',
    preparing: 'جارٍ التجهيز…',
    retry: 'إعادة المحاولة',
    debugMode: 'تصحيح',
    standardMode: 'قياسي',
    offline: 'يبدو أنك غير متصل — تم حفظ مسودتك محلياً ولن تفقد شيئاً. أعد الاتصال للمتابعة.',
    micDenied: 'تم رفض الوصول إلى الميكروفون. فعّله من إعدادات المتصفح للتسجيل.',
    micUnavailable: 'لم يتم العثور على ميكروفون على هذا الجهاز.',
    speechUnavailable: 'خدمات الصوت غير مفعّلة في مساحة العمل هذه بعد.',
  },
};

export function t(key) {
  return (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key] || key;
}

// Workstream-2 bilingual loader word pool — mission + tech pairs (seeded + extended)
export const LOADER_WORDS = [
  { en: 'Development', ar: 'تنمية' },
  { en: 'Empowerment', ar: 'تمكين' },
  { en: 'Partnership', ar: 'شراكة' },
  { en: 'Impact', ar: 'أثر' },
  { en: 'Prosperity', ar: 'ازدهار' },
  { en: 'Humanity', ar: 'إنسانية' },
  { en: 'Analysing', ar: 'تحليل' },
  { en: 'Generating', ar: 'توليد' },
  { en: 'Thinking', ar: 'تفكير' },
  { en: 'Data', ar: 'بيانات' },
  { en: 'AI', ar: 'ذكاء اصطناعي' },
  { en: 'Verifying', ar: 'تحقق' },
  { en: 'Sustainability', ar: 'استدامة' },
  { en: 'Innovation', ar: 'ابتكار' },
  { en: 'Knowledge', ar: 'معرفة' },
  { en: 'Sourcing', ar: 'مصادر' },
  { en: 'Building', ar: 'بناء' },
  { en: 'Translating', ar: 'ترجمة' },
];
