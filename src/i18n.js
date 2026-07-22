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
  const base = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key];
  if (base) return base;
  // voice-mode strings live in VOICE_STRINGS as {key: {en, ar}} (additive 2026-07-20)
  const v = typeof VOICE_STRINGS !== 'undefined' ? VOICE_STRINGS[key] : null;
  if (v) return v[LANG] || v.en;
  return key;
}

export function getLang() { return LANG; }

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

// ODA World Intelligence voice mode (additive 2026-07-20)
export const VOICE_STRINGS = {
  'voice.speak': { en: 'Speak with ODA', ar: 'تحدث مع المكتب' },
  'voice.exit': { en: 'Exit voice mode', ar: 'إنهاء الوضع الصوتي' },
  'voice.captions': { en: 'Captions mode', ar: 'وضع الترجمة النصية' },
  'voice.interrupt': { en: 'Tap to interrupt', ar: 'اضغط للمقاطعة' },
  'voice.langOverride': { en: 'Language override', ar: 'تجاوز اللغة' },
  'voice.langAuto': { en: 'Auto language', ar: 'لغة تلقائية' },
  'voice.retry': { en: 'Retry', ar: 'إعادة المحاولة' },
  'voice.fallback': { en: 'fallback model', ar: 'نموذج احتياطي' },
  'voice.micDenied': { en: 'Microphone unavailable — check browser permission, then try again.', ar: 'الميكروفون غير متاح — تحقق من إذن المتصفح ثم حاول مجددًا.' },
  'voice.error': { en: 'Voice conversation unavailable — the world view remains fully usable.', ar: 'المحادثة الصوتية غير متاحة — تظل خريطة العالم قابلة للاستخدام بالكامل.' },
  'voice.privacy': { en: 'Microphone audio is streamed to OpenAI\'s Realtime service to power the live conversation. Transcript and retention behaviour follow your OpenAI account configuration.', ar: 'يُبَثّ صوت الميكروفون إلى خدمة OpenAI Realtime لتشغيل المحادثة المباشرة. يتبع سلوك النصوص والاحتفاظ بالبيانات إعدادات حساب OpenAI الخاص بك.' },
  'voice.state.Idle': { en: 'Idle', ar: 'خامل' },
  'voice.state.Activating': { en: 'Activating…', ar: 'جارٍ التفعيل…' },
  'voice.state.Listening': { en: 'Listening', ar: 'يستمع' },
  'voice.state.Understanding': { en: 'Understanding…', ar: 'جارٍ الفهم…' },
  'voice.state.Retrieving': { en: 'Retrieving…', ar: 'جارٍ الاسترجاع…' },
  'voice.state.Responding': { en: 'Responding', ar: 'يجيب' },
  'voice.state.Interrupted': { en: 'Interrupted', ar: 'تمت المقاطعة' },
  'voice.state.Reconnecting': { en: 'Reconnecting…', ar: 'جارٍ إعادة الاتصال…' },
  'voice.state.Error': { en: 'Error', ar: 'خطأ' },
  'voice.state.Ended': { en: 'Ended', ar: 'انتهى' },
};
