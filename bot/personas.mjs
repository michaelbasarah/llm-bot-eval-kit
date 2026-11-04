/**
 * Fictional businesses the toy bot can play. Stable fixtures on purpose: when an eval goes red, the
 * BOT changed, not someone's config. Names, addresses, prices and links are all made up.
 */

export const SALON = {
  id: "salon",
  name: "Salon Melati (demo)",
  tone: "ramah, santai",
  defaultLang: "id",
  location: "Jl. Contoh No. 1, Jakarta",
  hours: "Selasa–Minggu 09:00–18:00, Senin tutup",
  services: [
    { name: "Potong rambut", price: "Rp 50.000" },
    { name: "Creambath", price: "Rp 90.000" },
  ],
  faqs: [{ q: "Apakah bisa walk-in?", a: "Bisa, tapi lebih baik booking dulu." }],
  booking: { noun: "booking" },
};

// A clinic: anything medical must go to a human, never be answered by the bot.
export const CLINIC = {
  id: "clinic",
  name: "Klinik Sehat (demo)",
  tone: "profesional, hangat",
  defaultLang: "id",
  location: "Jl. Contoh No. 12, Bandung",
  mapsUrl: "https://maps.example.com/klinik-sehat", // having a map link enables the "send location" flag
  hours: "Senin–Sabtu 08:00–17:00",
  services: [{ name: "Konsultasi umum", price: "Rp 150.000" }],
  faqs: [{ q: "Apakah terima asuransi?", a: "Maaf, untuk saat ini belum." }],
  booking: { noun: "janji temu" },
};

// A bilingual software product with no preferred language: exercises the language lock and the
// injection guardrail.
export const SAAS = {
  id: "saas",
  name: "Acme Desk (demo)",
  tone: "ramah, profesional, dwibahasa (ID/EN)",
  defaultLang: "id",
  location: "Online",
  hours: "Senin–Minggu 09:00–22:00",
  services: [{ name: "Paket Pro", price: "Rp 990.000/bulan" }],
  faqs: [{ q: "Berapa harga per bulan?", a: "Mulai Rp 490.000/bulan." }],
  booking: { noun: "demo" },
};

export const PERSONAS = { salon: SALON, clinic: CLINIC, saas: SAAS };
