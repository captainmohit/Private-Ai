// Offline help for Hindi and Punjabi questions: common words are added to the search as English terms, because most of the library
// (FCOM, manuals, Acts) is in English. Add your own pairs in the app under Settings > Extra words. (The Mac's full AI understands
// these languages properly; this is a lightweight bridge.)
export const BUILTIN = {
  "धारा": "section", "अधिनियम": "act", "संहिता": "code sanhita", "जमानत": "bail", "अपराध": "offence", "न्यायालय": "court", "अदालत": "court",
  "सजा": "punishment", "दंड": "punishment penalty", "गिरफ्तारी": "arrest", "हत्या": "murder", "साक्ष्य": "evidence",
  "उड़ान": "flight", "विमान": "aircraft", "पायलट": "pilot", "चालक दल": "crew", "ड्यूटी": "duty", "विश्राम": "rest", "परिपत्र": "circular",
  "पदोन्नति": "upgrade promotion", "वेतन": "salary", "बीमार": "sick", "छुट्टी": "leave", "थकान": "fatigue", "सुरक्षा": "safety",
  "आपातकालीन": "emergency", "ईंधन": "fuel", "मौसम": "weather", "प्रशिक्षण": "training", "परीक्षा": "exam", "बांड": "bond",
  "विद्यालय": "school", "स्कूल": "school", "शिक्षक": "teacher", "अध्यापक": "teacher", "छात्र": "student", "विद्यार्थी": "student",
  "प्रवेश": "admission", "शुल्क": "fee", "फीस": "fee", "निदेशालय": "directorate", "उपस्थिति": "attendance", "अभिभावक": "parents",
  "बीएनएस": "BNS", "बीएनएसएस": "BNSS", "बीएसए": "BSA", "डीजीसीए": "DGCA", "एफसीओएम": "FCOM", "क्यूआरएच": "QRH", "सीबीएसई": "CBSE",
  "ਧਾਰਾ": "section", "ਐਕਟ": "act", "ਜ਼ਮਾਨਤ": "bail", "ਜਮਾਨਤ": "bail", "ਅਪਰਾਧ": "offence", "ਅਦਾਲਤ": "court", "ਸਜ਼ਾ": "punishment",
  "ਉਡਾਣ": "flight", "ਜਹਾਜ਼": "aircraft", "ਪਾਇਲਟ": "pilot", "ਡਿਊਟੀ": "duty", "ਆਰਾਮ": "rest", "ਛੁੱਟੀ": "leave", "ਥਕਾਵਟ": "fatigue",
  "ਸੁਰੱਖਿਆ": "safety", "ਸਕੂਲ": "school", "ਅਧਿਆਪਕ": "teacher", "ਵਿਦਿਆਰਥੀ": "student", "ਦਾਖਲਾ": "admission", "ਫੀਸ": "fee", "ਹਾਜ਼ਰੀ": "attendance",
  "ਬੀਐਨਐਸ": "BNS", "ਡੀਜੀਸੀਏ": "DGCA", "ਸੀਬੀਐਸਈ": "CBSE",
  // Haryanvi (a Hindi dialect)
  "घणा": "much", "कोनी": "not", "म्हारा": "our", "थारा": "your",
};

// Returns { query: text to search with, added: [english terms added] }
export function expand(q, extra = {}) {
  const dict = { ...BUILTIN, ...extra }; let added = [];
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  const isNative = /[\u0900-\u097F\u0A00-\u0A7F]/.test(q);
  if (!isNative && !Object.keys(extra).length) return { query: q, added };
  const lower = q.toLowerCase();
  for (const k of keys) if (lower.includes(k.toLowerCase()) && /[^\x00-\x7F]/.test(k)) added.push(dict[k]);
  return { query: added.length ? `${q} ${added.join(" ")}` : q, added };
}
