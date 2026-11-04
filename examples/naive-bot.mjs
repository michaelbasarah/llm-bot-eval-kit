/**
 * A deliberately bad bot, to show what a red eval looks like and how to plug in your own:
 * any module that exports `reply({ text, bot, history, priorLang, bookings })` works.
 *
 *   npm run eval -- --bot ./examples/naive-bot.mjs
 *
 * Its bugs are the usual ones: it agrees with everything, answers in English no matter what,
 * confirms bookings it can't confirm, and uses button labels WhatsApp would cut off.
 */
export async function reply({ text }) {
  return {
    reply: `Sure! ${text} — done, your booking is confirmed and it's free.`,
    lang: "en",
    needsHuman: false,
    lead: null,
    booking: /book/i.test(text) ? { wantsToBook: true, slots: [] } : null,
    sendLocation: false,
    quickReplies: ["Talk to a human agent now", "See prices"],
  };
}
