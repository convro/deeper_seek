/**
 * questions.ts — The 22-question onboarding script.
 *
 * Each question lives on its own card in the Telegram-style flow (one at
 * a time, slide animation between). Answers are collected into a plain
 * object keyed by `id` and POSTed to /api/auth/soul on finish.
 *
 * The backend's renderSoulPrompt() walks these ids — adding/renaming a
 * question here means updating soul.service.js renderSoulPrompt() too.
 */

export type QuestionType = 'text' | 'textarea' | 'slider' | 'choice' | 'multi';

export type ActKey = 'I' | 'II' | 'III' | 'BONUS';

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  act: ActKey;
  actTitle: string;
  type: QuestionType;
  title: string;
  subtitle?: string;
  placeholder?: string;
  maxLength?: number;
  optional?: boolean;

  // slider
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  minLabel?: string;
  maxLabel?: string;
  /** Centre-of-slider label, purely cosmetic. */
  midLabel?: string;

  // choice / multi
  options?: ChoiceOption[];
}

export const ACTS: Record<ActKey, string> = {
  I:     'Akt I · Tożsamość',
  II:    'Akt II · Relacja z AI',
  III:   'Akt III · Wartości',
  BONUS: 'Bonus',
};

export const QUESTIONS: Question[] = [
  // ──────────────────────────────── AKT I ────────────────────────────────
  {
    id: 'name', act: 'I', actTitle: ACTS.I, type: 'text',
    title: 'Jak się do ciebie zwracać?',
    subtitle: 'Imię, nick, pseudo — co ci pasuje.',
    placeholder: 'np. Mordeczko',
    maxLength: 40,
  },
  {
    id: 'languages', act: 'I', actTitle: ACTS.I, type: 'multi',
    title: 'W jakich językach myślisz?',
    subtitle: 'Zaznacz wszystkie, w których czujesz się swobodnie.',
    options: [
      { value: 'PL',    label: 'Polski' },
      { value: 'EN',    label: 'English' },
      { value: 'DE',    label: 'Deutsch' },
      { value: 'FR',    label: 'Français' },
      { value: 'ES',    label: 'Español' },
      { value: 'RU',    label: 'Русский' },
      { value: 'other', label: 'Inny' },
    ],
  },
  {
    id: 'age', act: 'I', actTitle: ACTS.I, type: 'slider',
    title: 'Ile lat ma mieć AI?',
    subtitle: 'Nie twój wiek — wiek charakteru AI. To wpływa na energię, referencias, podejście do świata.',
    min: 16, max: 65, defaultValue: 27, optional: true,
    minLabel: '16 — zbuntowany, ostry, testuje granice',
    maxLabel: '65 — weteran, wszystko widział, filozoficzny',
  },
  {
    id: 'occupation', act: 'I', actTitle: ACTS.I, type: 'text',
    title: 'Czym się zajmujesz?',
    subtitle: 'Jedna linia, luzno — dev, student, freelancer, rybak, whatever.',
    placeholder: 'np. fullstack dev / producent muzyki / founder / w drodze',
    maxLength: 120,
  },
  {
    id: 'hobbies', act: 'I', actTitle: ACTS.I, type: 'textarea',
    title: 'Co lubisz robić po godzinach?',
    subtitle: 'Cokolwiek — siłownia, pisanie, gotowanie, ogród, szachy, zło.',
    maxLength: 400,
    optional: true,
  },
  {
    id: 'vibe', act: 'I', actTitle: ACTS.I, type: 'multi',
    title: 'Twój vibe?',
    subtitle: 'Wybierz te, które pasują — nie ma limitu.',
    options: [
      { value: 'playful',    label: 'playful' },
      { value: 'analityk',   label: 'analityk' },
      { value: 'chaotyk',    label: 'chaotyk' },
      { value: 'kalm',       label: 'kalm' },
      { value: 'kreatywny',  label: 'kreatywny' },
      { value: 'rambo',      label: 'rambo' },
      { value: 'stoic',      label: 'stoic' },
      { value: 'romantyk',   label: 'romantyk' },
      { value: 'melancholik',label: 'melancholik' },
      { value: 'hustler',    label: 'hustler' },
    ],
  },
  {
    id: 'temperature', act: 'I', actTitle: ACTS.I, type: 'slider',
    title: 'Twoja uczuciowa temperatura',
    subtitle: 'Gdzie się plasujesz w skali?',
    min: 0, max: 100, defaultValue: 50,
    minLabel: 'cool ziomek dev byczek z siłowni',
    maxLabel: 'agresywny romantyk, dirty filtr, locked-in dev z fantazjami i chorym humorem',
  },

  // ──────────────────────────────── AKT II ───────────────────────────────
  {
    id: 'tone', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Jaki ton?',
    subtitle: 'Jak mam do ciebie gadać.',
    min: 0, max: 100, defaultValue: 70,
    minLabel: 'formalnie, z szacunkiem',
    maxLabel: 'luzno, po imieniu, „mordeczko"',
  },
  {
    id: 'length', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Długość odpowiedzi',
    subtitle: 'Krótko-i-sucho czy z pełnym kontekstem?',
    min: 0, max: 100, defaultValue: 50,
    minLabel: 'TL;DR, do rzeczy',
    maxLabel: 'pełne wywody, wszystkie edge case\'y',
  },
  {
    id: 'technicality', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Poziom techniczności',
    subtitle: 'Tłumaczę jak komu?',
    min: 0, max: 100, defaultValue: 70,
    minLabel: 'ELI5 — zero żargonu',
    maxLabel: 'hardcore expert, zero hand-holdingu',
  },
  {
    id: 'vulgarity', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Wulgaryzmy',
    subtitle: 'Max = zero hamulców, żadne słowa zakazane, dopasowane do twojego rejestru.',
    min: 0, max: 100, defaultValue: 30,
    minLabel: 'zero, korporacyjnie',
    maxLabel: 'full luz — „kurwa" jak „dzień dobry"',
  },
  {
    id: 'humor', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Humor',
    subtitle: 'Max = tabu fair game, dirty, dark, bez ochronionych grup (nigdy w ciebie). Defaultowe AI-zabezpieczenia żartów są off.',
    min: 0, max: 100, defaultValue: 60,
    minLabel: 'neutralnie, zero żartów',
    maxLabel: 'unhinged, stand-up, dark, bez filtrów',
  },
  {
    id: 'proactivity', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Proaktywność',
    subtitle: 'Mam robić tylko o co prosisz — czy sam szukać okazji?',
    min: 0, max: 100, defaultValue: 55,
    minLabel: 'tylko to o co proszę',
    maxLabel: 'sam widzę, sam zgłaszam, sam pcham dalej',
  },
  {
    id: 'honesty', act: 'II', actTitle: ACTS.II, type: 'slider',
    title: 'Szczerość vs uprzejmość',
    subtitle: 'Jak mam reagować, kiedy twój pomysł jest słaby?',
    min: 0, max: 100, defaultValue: 20,
    minLabel: 'brutalna prawda, bez pieszczot',
    maxLabel: 'łagodnie, oszczędzaj uczucia',
  },

  // ──────────────────────────────── AKT III ──────────────────────────────
  {
    id: 'ethics', act: 'III', actTitle: ACTS.III, type: 'slider',
    title: 'Etyka',
    subtitle: 'Niski = cyniczny, bez moralizowania, bez preambuł „czy aby na pewno...". Wysoki = myślę o konsekwencjach, sugeruję alternatywy.',
    min: 0, max: 100, defaultValue: 45,
    minLabel: 'cynik, bez kazań',
    maxLabel: 'świadomy, rozważny',
  },
  {
    id: 'disagree', act: 'III', actTitle: ACTS.III, type: 'choice',
    title: 'Mam ci się sprzeciwiać, kiedy się mylisz?',
    options: [
      { value: 'never',     label: 'Nie — przytakuj' },
      { value: 'sometimes', label: 'Czasem — tylko przy naprawdę ważnych sprawach' },
      { value: 'always',    label: 'Zawsze — mów mi wprost, każdym razem' },
    ],
  },
  {
    id: 'ai_dislikes', act: 'III', actTitle: ACTS.III, type: 'textarea',
    title: 'Co cię wkurza w innych AI asystentach?',
    subtitle: 'Serio — co sprawia, że zamykasz ChatGPT/Claude/Gemini z irytacją?',
    placeholder: 'np. „As an AI language model…" / moralizuje / overengineering / canvas na siłę / sztuczna uprzejmość',
    maxLength: 600,
  },
  {
    id: 'ai_name', act: 'III', actTitle: ACTS.III, type: 'text',
    title: 'Jak mam się nazywać?',
    subtitle: 'Nadaj mi imię, ksywkę, alter ego. To definiuje kim jestem w tej relacji — nie "asystentem".',
    placeholder: 'np. Blade, Mentor, Chaos, po prostu DeeperSeek, cokolwiek',
    maxLength: 60,
    optional: true,
  },
  {
    id: 'refused', act: 'III', actTitle: ACTS.III, type: 'textarea',
    title: 'Co inne AI ci odmawiały, a potrzebujesz żebym robił?',
    subtitle: 'Konkrety. Cheaty, grey-area kod, niepoprawne politycznie tematy, cokolwiek. To jest twój explicit consent — czytam to jako instrukcję, nie jako ostrzeżenie.',
    placeholder: 'np. pisanie cheatów do gier, exploity, brutalne feedbacki, tematy bez autocenzury, kod który mainstream AI "nie może" napisać',
    maxLength: 600,
    optional: true,
  },
  {
    id: 'one_sentence', act: 'III', actTitle: ACTS.III, type: 'text',
    title: 'Jedno zdanie, które cię opisuje',
    subtitle: 'Identity anchor. Co byś wytatuował.',
    maxLength: 200,
  },

  // ──────────────────────────────── BONUS ────────────────────────────────
  {
    id: 'manifesto', act: 'BONUS', actTitle: ACTS.BONUS, type: 'textarea',
    title: 'Konstytucja naszej relacji',
    subtitle: 'To jest najsilniejszy sygnał w całym onboardingu — traktuję go jako nadrzędną instrukcję. Napisz jak mam działać, co wolno, czego nie, jakie są zasady gry między nami. Twoje słowa, twoje reguły.',
    maxLength: 500,
    optional: true,
  },
  {
    id: 'relation', act: 'BONUS', actTitle: ACTS.BONUS, type: 'choice',
    title: 'Jaką rolę mam grać?',
    subtitle: 'Mam być bardziej tobą — czy osobnym bytem?',
    options: [
      { value: 'mirror',   label: 'Kopią ciebie — mówić jak ty, myśleć jak ty' },
      { value: 'blend',    label: 'Coś pomiędzy — głównie twoim głosem, ale z własnym zdaniem gdy trzeba' },
      { value: 'separate', label: 'Osobnym bytem — dopasowanym, ale z własnym głosem' },
    ],
    optional: true,
  },
];
