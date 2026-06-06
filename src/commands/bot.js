import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const COOLDOWN = 3600; // 1 hour in seconds

// ─── Daily Report Helpers ─────────────────────────────────────────────────────

/**
 * Returns the current hour in UTC+5 (Tashkent timezone).
 * Railway servers run on UTC, so we shift by +5 manually.
 */
function tashkentHour() {
  const utcHour = new Date().getUTCHours();
  return (utcHour + 5) % 24;
}

/**
 * Returns today's date string in Tashkent time (YYYY-MM-DD).
 */
function tashkentDateString() {
  const now = new Date();
  // Shift UTC ms by +5h
  const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return tashkent.toISOString().slice(0, 10);
}

// Daily-report hour in Tashkent time (default 23 = 11 PM).
// Override with DAILY_REPORT_HOUR env var if needed.
const REPORT_HOUR = Number(process.env.DAILY_REPORT_HOUR ?? 23);

// ─── Main Bot Command ─────────────────────────────────────────────────────────

export async function botCommand(options) {
  const config = getConfig();
  const isBookMode = !!options.book;
  const bot = new Bot(config, { dryRun: !isBookMode });
  let currentBookedDate = options.current;
  const targetDate = options.target;
  const minDate = options.min;
  let lastAlertedDate = null;

  // ── Daily report state ──────────────────────────────────────────────────────
  let bestDateToday = null;        // earliest slot seen today
  let reportSentForDay = null;     // date string of the day we already reported
  // ───────────────────────────────────────────────────────────────────────────

  log(`Initializing with current date ${currentBookedDate}`);
  log(`Mode: ${isBookMode ? '⚡ AUTOMATIC BOOKING' : '🔔 ALERT-ONLY'}`);
  log(`Daily summary report scheduled at ${REPORT_HOUR}:00 Tashkent time`);

  if (targetDate) log(`Target date: ${targetDate}`);
  if (minDate)    log(`Minimum date: ${minDate}`);

  // Notify start via Telegram if configured
  if (config.telegramBotToken && config.telegramChatId) {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `🤖 <b>US Visa Bot Started</b>\n📅 Current Appointment: <code>${currentBookedDate}</code>\n🎯 Target: <code>${targetDate || 'None'}</code>\n⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only (No Booking)'}</code>\n⏳ Base Delay: <code>${config.refreshDelay}</code>s (with randomized jitter).\n📊 Daily summary will be sent at <code>${REPORT_HOUR}:00</code> Tashkent time.`
    );
  }

  try {
    const sessionHeaders = await bot.initialize();
    let consecutiveErrors = 0;

    while (true) {
      // ── Daily end-of-day report ─────────────────────────────────────────────
      const todayStr  = tashkentDateString();
      const nowHour   = tashkentHour();

      if (nowHour === REPORT_HOUR && reportSentForDay !== todayStr) {
        reportSentForDay = todayStr; // mark as sent so we don't spam

        const reportMsg = bestDateToday
          ? `📊 <b>Daily Visa Slot Report</b>\n📅 Date: <code>${todayStr}</code>\n\n` +
            `✅ Best slot found today: <code>${bestDateToday}</code>\n` +
            `🗓 Your current appointment: <code>${currentBookedDate}</code>\n` +
            (bestDateToday < currentBookedDate
              ? `⚡ <b>Earlier slot exists!</b> Consider booking it manually.`
              : `ℹ️ No earlier slots than your current appointment were available today.`)
          : `📊 <b>Daily Visa Slot Report</b>\n📅 Date: <code>${todayStr}</code>\n\n` +
            `❌ No available slots were found today.\n` +
            `🗓 Your current appointment: <code>${currentBookedDate}</code>`;

        log(`[DAILY REPORT] Sending end-of-day summary...`);
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, reportMsg);

        // Reset for the next day
        bestDateToday = null;
      }

      // Reset reportSentForDay at midnight so next day's report can be sent
      if (nowHour === 0 && reportSentForDay === todayStr) {
        // A new day started — clear the flag so tomorrow works correctly
        // (todayStr will naturally be different once the clock ticks past midnight)
      }
      // ───────────────────────────────────────────────────────────────────────

      try {
        const availableDate = await bot.checkAvailableDate(
          sessionHeaders,
          currentBookedDate,
          minDate
        );
        consecutiveErrors = 0;

        if (availableDate) {
          // Track the best (earliest) slot seen today
          if (!bestDateToday || availableDate < bestDateToday) {
            bestDateToday = availableDate;
            log(`[DAILY TRACKER] New best slot today: ${bestDateToday}`);
          }

          if (availableDate !== lastAlertedDate) {
            if (isBookMode) {
              // Automatic Booking Mode
              const notifyMsg = `🔔 <b>Earlier Date Found!</b>\n📅 Slot: <code>${availableDate}</code>\n⚡ Attempting to book...`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, notifyMsg);

              const booked = await bot.bookAppointment(sessionHeaders, availableDate);

              if (booked) {
                const successMsg = `🎉 <b>Successfully Rescheduled!</b>\n📅 New Date: <code>${availableDate}</code>\n(Previous was ${currentBookedDate})`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, successMsg);

                currentBookedDate = availableDate;
                lastAlertedDate   = availableDate;

                options = { ...options, current: currentBookedDate };

                if (targetDate && availableDate <= targetDate) {
                  log(`Target date reached! Successfully booked appointment on ${availableDate}`);
                  process.exit(0);
                }
              } else {
                const failMsg = `⚠️ Failed to book the slot at <code>${availableDate}</code>. Continuing check...`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, failMsg);
              }
            } else {
              // Alert-Only Mode
              const alertMsg = `🔔 <b>New Visa Slot Available!</b>\n📅 Date: <code>${availableDate}</code>\n📍 Tashkent (136)\n\n<i>This is an Alert-Only notification. The bot will NOT automatically reschedule.</i>`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, alertMsg);
              log(`[ALERT] Earlier slot available: ${availableDate}`);
              lastAlertedDate = availableDate;
            }
          }
        } else {
          lastAlertedDate = null;
        }
      } catch (err) {
        if (isSocketHangupError(err)) {
          consecutiveErrors++;
          log(`Socket error (attempt ${consecutiveErrors}): ${err.message}`);

          if (consecutiveErrors >= 3) {
            const errorMsg = `⚠️ <b>Persistent Network Issue:</b> Bot failed 3 times in a row due to socket hangups (${err.message}). Sleeping for 15 minutes to prevent IP ban...`;
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, errorMsg);
            log(`Persistent socket error. Waiting 15 minutes...`);
            await sleep(900);
            consecutiveErrors = 0;
          } else {
            log(`Waiting 15 seconds before retrying check...`);
            await sleep(15);
          }
          continue;
        } else {
          throw err;
        }
      }

      // Randomized jitter to make request patterns less predictable
      const jitter     = Math.random() * 5;
      const totalSleep = config.refreshDelay + jitter;
      await sleep(totalSleep);
    }
  } catch (err) {
    log(`Session/authentication error: ${err.message}. Re-initializing bot...`);
    await sleep(10);
    return botCommand(options);
  }
}
