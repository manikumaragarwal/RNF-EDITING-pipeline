// Devanagari -> natural Roman ("Hinglish") transliteration, per-word so the
// Whisper word timestamps survive 1:1 (one Devanagari word -> one Roman word).
// This is the OFFLINE path (no key). For creator-natural spelling the app can
// optionally run a Gemini cleanup pass afterwards (see main.cjs).
//
// Pipeline: sanscript Devanagari->IAST (deterministic), then map IAST diacritics
// to plain ASCII the way Hindi is actually typed, then delete the inherent
// word-final schwa (svaagata -> svaagat) which is the single biggest naturalness win.
const Sanscript = require('@indic-transliteration/sanscript');

const hasDevanagari = (s) => /[ऀ-ॿ]/.test(String(s || ''));

// IAST -> natural ASCII. Multi-char first, then singles. IAST uses c=च, ch=छ,
// so 'ch'->'chh' must run before 'c'->'ch'.
const PAIRS = [
  ['ṭh', 'th'], ['ḍh', 'dh'], ['kh', 'kh'], ['gh', 'gh'], ['jh', 'jh'], ['bh', 'bh'],
  ['ph', 'ph'], ['th', 'th'], ['dh', 'dh'], ['ch', 'chh'], ['jñ', 'gy'], ['kṣ', 'ksh'],
  ['ā', 'aa'], ['ī', 'ee'], ['ū', 'oo'], ['ṝ', 'ri'], ['ṛ', 'ri'], ['ḷ', 'l'],
  ['ṅ', 'ng'], ['ñ', 'n'], ['ṇ', 'n'], ['ṃ', 'n'], ['ṁ', 'n'], ['ḥ', 'h'],
  ['ṭ', 't'], ['ḍ', 'd'], ['ś', 'sh'], ['ṣ', 'sh'], ['c', 'ch'],
];
function iastToNatural(s) {
  let t = s;
  for (const [a, b] of PAIRS) t = t.split(a).join(b);
  // any stray diacritics -> strip to base letter
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t;
}

const VOWELS = 'aeiou';
const isVowel = (c) => VOWELS.includes(c);
// Delete the inherent final schwa: a single trailing 'a' preceded by a consonant.
// Keep real long vowels (aa) and genuine mono/short words.
function dropFinalSchwa(w) {
  if (w.length >= 3 && w.endsWith('a') && !w.endsWith('aa')) {
    const prev = w[w.length - 2];
    if (!isVowel(prev)) return w.slice(0, -1);
  }
  return w;
}

// Transliterate a single word token (may carry leading/trailing ASCII punctuation).
const PUNCT = `\\s.,!?;:"'()\\[\\]{}…—–-`;
const SPLIT = new RegExp(`^([${PUNCT}]*)([\\s\\S]*?)([${PUNCT}]*)$`, 'u');
function romanizeWord(word) {
  const m = String(word).match(SPLIT);
  const [, pre, core, post] = m;
  if (!hasDevanagari(core)) return word;         // English word inside Hinglish -> leave as-is
  const iast = Sanscript.t(core, 'devanagari', 'iast');
  return pre + dropFinalSchwa(iastToNatural(iast)) + post;
}

// Map a words array in place-safe way: returns a NEW array, same length/timings.
function romanizeWords(words) {
  return (words || []).map((w) => ({ ...w, text: romanizeWord(w.text) }));
}

module.exports = { hasDevanagari, romanizeWord, romanizeWords, iastToNatural };
