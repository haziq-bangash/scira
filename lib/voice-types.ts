// Centralized voice configuration for the application

export type VoiceType = 
  | "English"
  | "French"
  | "German"
  | "Italian"
  | "Portuguese"
  | "Russian"
  | "Japanese"
  | "Korean"
  | "Chinese"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Czech"
  | "Greek"
  | "Hungarian";

export type VoiceGender = "MALE" | "FEMALE";

export interface VoiceOption {
  value: VoiceType;
  label: string;
  description: string;
}

// Voice picker options with descriptions
export const VOICE_OPTIONS: VoiceOption[] = [
  { value: "English", label: "English", description: "Warm, friendly" },
  { value: "French", label: "French", description: "Energetic, upbeat" },
  { value: "German", label: "German", description: "Authoritative, strong" },
  { value: "Italian", label: "Italian", description: "Expressive, warm" },
  { value: "Portuguese", label: "Portuguese", description: "Friendly, clear" },
  { value: "Russian", label: "Russian", description: "Confident, clear" },
  { value: "Japanese", label: "Japanese", description: "Polite, clear" },
  { value: "Korean", label: "Korean", description: "Friendly, energetic" },
  { value: "Chinese", label: "Chinese", description: "Clear, professional" },
  { value: "Turkish", label: "Turkish", description: "Warm, engaging" },
  { value: "Dutch", label: "Dutch", description: "Friendly, direct" },
  { value: "Polish", label: "Polish", description: "Clear, warm" },
  { value: "Czech", label: "Czech", description: "Friendly, precise" },
  { value: "Greek", label: "Greek", description: "Warm, expressive" },
  { value: "Hungarian", label: "Hungarian", description: "Melodic, clear" },
];

// Helper to validate if a string is a valid VoiceType
export function isVoiceType(value: string): value is VoiceType {
  return VOICE_OPTIONS.some(voice => voice.value === value);
}

// Voice IDs for ElevenLabs TTS (using multilingual voices)
export const VOICE_IDS: Record<VoiceGender, Record<VoiceType, string>> = {
  FEMALE: {
    English: 'jqcCZkN6Knx8BJ5TBdYR',
    French: 'kVQrtkfBI5wqyVK1NLZa',
    German: '7eVMgwCnXydb3CikjV7a',
    Italian: 'VF9jh6iUlVsOIpSPkT8P',
    Portuguese: 'GDzHdQOi6jjf8zaXhCYD',
    Russian: 'AB9XsbSA4eLG12t2myjN',
    Japanese: '8PfKHL4nZToWC3pbz9U9',
    Korean: 'uyVNoMrnUku1dZyVEXwD',
    Chinese: '9lHjugDhwqoxA5MhX0az',
    Turkish: 'aEJD8mYP0nuof1XHShVY',
    Dutch: 'XJa38TJgDqYhj5mYbSJA',
    Polish: 'aAY9hMI6VU335JUszdRs',
    Czech: 'SZXidiHhq5QYe3jRboSZ',
    Greek: 'Jv2zcgjn9Qu0uNMKJjb1',
    Hungarian: 'xjlfQQ3ynqiEyRpArrT8',
  },
  MALE: {
    English: 'iP95p4xoKVk53GoZ742B',
    French: 'dDpKZ6xv1gpboV4okVbc',
    German: 'bAFkvitDGeDMmqo9gJzO',
    Italian: '2OoHspMHbpIu5oiMaqDy',
    Portuguese: '3Je7qW9yPOhc47iG41pH',
    Russian: 's0phbFBBp708ZeIy8oGx',
    Japanese: 'nHEVPT3LS1V37bXZNr82',
    Korean: 'CxErO97xpQgQXYmapDKX',
    Chinese: 'fQj4gJSexpu8RDE2Ii5m',
    Turkish: 'UtI8LSMMDNx2i47tnKLQ',
    Dutch: 'G53Wkf3yrsXvhoQsmslL',
    Polish: 'V5GZ9rfeV9jjKZE5NkT7',
    Czech: 'uYFJyGaibp4N2VwYQshk',
    Greek: 'TN3alZndDSA8GYZSOf3r',
    Hungarian: '7B7mSWflzRSaO1yGeJH6',
  },
};

// Deepgram Nova-2 language codes
export const DEEPGRAM_LANGUAGE_CODES: Record<VoiceType, string> = {
  English: 'en',
  French: 'fr',
  German: 'de',
  Italian: 'it',
  Portuguese: 'pt-BR',
  Russian: 'ru',
  Japanese: 'ja',
  Korean: 'ko',
  Chinese: 'zh',
  Turkish: 'tr',
  Dutch: 'nl',
  Polish: 'pl',
  Czech: 'cs',
  Greek: 'el',
  Hungarian: 'hu',
};

// First message templates in each language
export const FIRST_MESSAGE_TEMPLATES: Record<VoiceType, string> = {
  English: `Hello! I'm Rovo, your AI assistant. How can I assist you today?`,
  French: `Bonjour! Je suis Rovo, votre assistant IA. Comment puis-je vous aider aujourd'hui?`,
  German: `Hallo! Ich bin Rovo, Ihr KI-Assistent. Wie kann ich Ihnen heute helfen?`,
  Italian: `Ciao! Sono Rovo, il tuo assistente AI. Come posso aiutarti oggi?`,
  Portuguese: `Olá! Eu sou Rovo, seu assistente de IA. Como posso ajudá-lo hoje?`,
  Russian: `Здравствуйте! Я Рово, ваш ИИ-ассистент. Чем я могу вам помочь сегодня?`,
  Japanese: `こんにちは！私はRovoです、あなたのAIアシスタントです。今日はどのようにお手伝いできますか？`,
  Korean: `안녕하세요! 저는 Rovo입니다, 당신의 AI 어시스턴트입니다. 오늘 어떻게 도와드릴까요?`,
  Chinese: `你好！我是Rovo，您的AI助手。今天我能为您做些什么？`,
  Turkish: `Merhaba! Ben Rovo, yapay zeka asistanınızım. Bugün size nasıl yardımcı olabilirim?`,
  Dutch: `Hallo! Ik ben Rovo, je AI-assistent. Hoe kan ik je vandaag helpen?`,
  Polish: `Cześć! Jestem Rovo, twój asystent AI. Jak mogę ci dzisiaj pomóc?`,
  Czech: `Ahoj! Jsem Rovo, váš AI asistent. Jak vám dnes mohu pomoci?`,
  Greek: `Γεια σας! Είμαι ο Rovo, ο AI βοηθός σας. Πώς μπορώ να σας βοηθήσω σήμερα;`,
  Hungarian: `Helló! Rovo vagyok, az AI asszisztensed. Hogyan segíthetek ma?`,
};
