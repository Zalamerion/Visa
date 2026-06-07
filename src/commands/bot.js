import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';
import { sendTelegramMessage, startTelegramListener } from '../lib/telegram.js';

const COOLDOWN = 3600; // 1 hour in seconds

// ─── Daily Report Helpers ─────────────────────────────────────────────────────

/**
 * Returns the current hour in UTC+5 (Tashkent timezone).
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
  const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return tashkent.toISOString().slice(0, 10);
}

// Daily-report hour in Tashkent time (default 20 = 8 PM).
const REPORT_HOUR = Number(process.env.DAILY_REPORT_HOUR ?? 20);

// ─── Telegram Reply Markup ────────────────────────────────────────────────────
const defaultMarkup = {
  inline_keyboard: [
    [
      { text: '🔄 Check Earliest Slot Now', callback_data: 'check_now' },
      { text: 'ℹ️ Bot Status', callback_data: 'status_now' }
    ]
  ]
};

// ─── Main Bot Command ─────────────────────────────────────────────────────────

export async function botCommand(options) {
  const config = getConfig();
  const isBookMode = !!options.book;
  const bot = new Bot(config, { dryRun: !isBookMode });
  let currentBookedDate = options.current;
  const targetDate = options.target;
  const minDate = options.min;
  let lastAlertedDate = null;

  // ── Stats Tracking & Global State (Persisted) ──────────────────────────────
  const startTime = new Date();
  let checksCount = 0;
  let lastCheckTime = null;
  let sessionHeaders = null;
  let bestDateToday = null;
  let reportSentForDay = null;
  let isCheckingManually = false;
  // ───────────────────────────────────────────────────────────────────────────

  log(`Initializing with current date ${currentBookedDate}`);
  log(`Mode: ${isBookMode ? '⚡ AUTOMATIC BOOKING' : '🔔 ALERT-ONLY'}`);
  log(`Daily summary report scheduled at ${REPORT_HOUR}:00 Tashkent time`);

  // 1. Notify start via Telegram (ONLY ONCE)
  if (config.telegramBotToken && config.telegramChatId) {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `🤖 <b>US Visa Bot Started</b>\n📅 Current Appointment: <code>${currentBookedDate}</code>\n🎯 Target: <code>${targetDate || 'None'}</code>\n⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only (No Booking)'}</code>\n⏳ Base Delay: <code>${config.refreshDelay}</code>s (with randomized jitter).\n📊 Daily summary scheduled at <code>${REPORT_HOUR}:00</code> Tashkent time.`,
      defaultMarkup
    );

    // Start background Telegram updates listener (ONLY ONCE)
    startTelegramListener(config.telegramBotToken, config.telegramChatId, async (command) => {
      if (command === 'status_now') {
        const uptimeMs = new Date() - startTime;
        const uptimeHrs = Math.floor(uptimeMs / (1000 * 60 * 60));
        const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

        const statusMsg = `🟢 <b>Bot Status: Active & Running</b>\n\n` +
                          `⏱ Uptime: <code>${uptimeHrs}h ${uptimeMins}m</code>\n` +
                          `🔄 Total Checks: <code>${checksCount}</code>\n` +
                          `📅 Last Check: <code>${lastCheckTime ? lastCheckTime.toLocaleTimeString('en-US', { timeZone: 'Asia/Tashkent' }) : 'Never'}</code> (Tashkent time)\n` +
                          `⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only'}</code>\n` +
                          `⏳ Interval: <code>${config.refreshDelay}</code>s`;

        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, statusMsg, defaultMarkup);
      } else if (command === 'check_now') {
        if (isCheckingManually) {
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, `⏳ A check is already in progress. Please wait a moment.`);
          return;
        }

        isCheckingManually = true;
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, `🔍 Fetching the absolute earliest slot from the visa system...`);

        try {
          if (!sessionHeaders) {
            sessionHeaders = await bot.initialize();
          }

          const dates = await bot.client.checkAvailableDate(sessionHeaders, config.scheduleId, config.facilityId);
          isCheckingManually = false;

          if (!dates || dates.length === 0) {
            await sendTelegramMessage(
              config.telegramBotToken,
              config.telegramChatId,
              `🔍 <b>Instant Slot Check</b>\n\n❌ No slots are currently available at all.`,
              defaultMarkup
            );
            return;
          }

          dates.sort();
          const earliest = dates[0];

          const msg = `🔍 <b>Instant Slot Check</b>\n\n` +
                      `📅 Earliest available date: <code>${earliest}</code>\n` +
                      `🗓 Your appointment: <code>${currentBookedDate}</code>\n` +
                      `🔢 Total slots open: <code>${dates.length}</code>\n\n` +
                      (earliest < currentBookedDate
                        ? `⚡ <b>Earlier slot exists!</b>`
                        : `ℹ️ No earlier slots available than your current one.`);

          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, msg, defaultMarkup);
        } catch (err) {
          isCheckingManually = false;
          log(`Manual check failed: ${err.message}`);

          // Try re-authenticating once on failure
          try {
            sessionHeaders = await bot.initialize();
            const dates = await bot.client.checkAvailableDate(sessionHeaders, config.scheduleId, config.facilityId);
            
            if (!dates || dates.length === 0) {
              await sendTelegramMessage(
                config.telegramBotToken,
                config.telegramChatId,
                `🔍 <b>Instant Slot Check</b>\n\n❌ No slots are currently available.`,
                defaultMarkup
              );
              return;
            }

            dates.sort();
            const earliest = dates[0];
            const msg = `🔍 <b>Instant Slot Check (Reconnected)</b>\n\n` +
                        `📅 Earliest available date: <code>${earliest}</code>\n` +
                        `🗓 Your appointment: <code>${currentBookedDate}</code>\n` +
                        `🔢 Total slots open: <code>${dates.length}</code>\n\n` +
                        (earliest < currentBookedDate
                          ? `⚡ <b>Earlier slot exists!</b>`
                          : `ℹ️ No earlier slots available.`);

            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, msg, defaultMarkup);
          } catch (retryErr) {
            await sendTelegramMessage(
              config.telegramBotToken,
              config.telegramChatId,
              `❌ <b>Check Failed</b>\n\nCould not fetch slots. Reason: <code>${retryErr.message}</code>`,
              defaultMarkup
            );
          }
        }
      }
    }).catch(err => log(`Failed to start Telegram updates listener: ${err.message}`));
  }

  // 2. Loop continuously (re-authenticates internally on catch)
  while (true) {
    try {
      if (!sessionHeaders) {
        log('Initializing visa bot session...');
        sessionHeaders = await bot.initialize();
      }

      // ── Daily report trigger ───────────────────────────────────────────────
      const todayStr = tashkentDateString();
      const nowHour  = tashkentHour();

      if (nowHour === REPORT_HOUR) {
        if (reportSentForDay !== todayStr) {
          reportSentForDay = todayStr; // mark as sent for today

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
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, reportMsg, defaultMarkup);

          bestDateToday = null; // Reset for next day
        }
      } else {
        // Reset when the hour passes so tomorrow's summary can trigger
        reportSentForDay = null;
      }
      // ───────────────────────────────────────────────────────────────────────

      // ── Perform the check ──────────────────────────────────────────────────
      try {
        const availableDate = await bot.checkAvailableDate(
          sessionHeaders,
          currentBookedDate,
          minDate
        );
        consecutiveErrors = 0;

        checksCount++;
        lastCheckTime = new Date();

        if (availableDate) {
          if (!bestDateToday || availableDate < bestDateToday) {
            bestDateToday = availableDate;
            log(`[DAILY TRACKER] New best slot today: ${bestDateToday}`);
          }

          if (availableDate !== lastAlertedDate) {
            if (isBookMode) {
              const notifyMsg = `🔔 <b>Earlier Date Found!</b>\n📅 Slot: <code>${availableDate}</code>\n⚡ Attempting to book...`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, notifyMsg, defaultMarkup);

              const booked = await bot.bookAppointment(sessionHeaders, availableDate);

              if (booked) {
                const successMsg = `🎉 <b>Successfully Rescheduled!</b>\n📅 New Date: <code>${availableDate}</code>\n(Previous was ${currentBookedDate})`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, successMsg, defaultMarkup);

                currentBookedDate = availableDate;
                lastAlertedDate   = availableDate;

                options = { ...options, current: currentBookedDate };

                if (targetDate && availableDate <= targetDate) {
                  log(`Target date reached! Successfully booked appointment on ${availableDate}`);
                  process.exit(0);
                }
              } else {
                const failMsg = `⚠️ Failed to book the slot at <code>${availableDate}</code>. Continuing check...`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, failMsg, defaultMarkup);
              }
            } else {
              const alertMsg = `🔔 <b>New Visa Slot Available!</b>\n📅 Date: <code>${availableDate}</code>\n📍 Tashkent (136)\n\n<i>This is an Alert-Only notification. The bot will NOT automatically reschedule.</i>`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, alertMsg, defaultMarkup);
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
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, errorMsg, defaultMarkup);
            log(`Persistent socket error. Waiting 15 minutes...`);
            await sleep(900);
            consecutiveErrors = 0;
          } else {
            log(`Waiting 15 seconds before retrying check...`);
            await sleep(15);
          }
          continue; // Continue inside the same loop with the same sessionHeaders
        } else {
          throw err; // propagate auth/session error to outer catch block to re-login
        }
      }

      // ── Sleep between ticks ────────────────────────────────────────────────
      const jitter     = Math.random() * 5;
      const totalSleep = config.refreshDelay + jitter;
      await sleep(totalSleep);

    } catch (err) {
      log(`Session/authentication error: ${err.message}. Re-initializing session in 10 seconds...`);
      sessionHeaders = null; // Clear so that it logins again on the next loop iteration
      await sleep(10);
    }
  }
}
