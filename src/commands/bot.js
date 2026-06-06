import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const COOLDOWN = 3600; // 1 hour in seconds

export async function botCommand(options) {
  const config = getConfig();
  // If user did not pass --book, run in dry-run mode (do not actually book)
  const isBookMode = !!options.book;
  const bot = new Bot(config, { dryRun: !isBookMode });
  let currentBookedDate = options.current;
  const targetDate = options.target;
  const minDate = options.min;
  let lastAlertedDate = null;

  log(`Initializing with current date ${currentBookedDate}`);
  log(`Mode: ${isBookMode ? '⚡ AUTOMATIC BOOKING' : '🔔 ALERT-ONLY'}`);

  if (targetDate) {
    log(`Target date: ${targetDate}`);
  }

  if (minDate) {
    log(`Minimum date: ${minDate}`);
  }

  // Notify start via Telegram if configured
  if (config.telegramBotToken && config.telegramChatId) {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `🤖 <b>US Visa Bot Started</b>\n📅 Current Appointment: <code>${currentBookedDate}</code>\n🎯 Target: <code>${targetDate || 'None'}</code>\n⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only (No Booking)'}</code>\n⏳ Base Delay: <code>${config.refreshDelay}</code>s (with randomized jitter).`
    );
  }

  try {
    const sessionHeaders = await bot.initialize();
    let consecutiveErrors = 0;

    while (true) {
      try {
        const availableDate = await bot.checkAvailableDate(
          sessionHeaders,
          currentBookedDate,
          minDate
        );
        consecutiveErrors = 0; // Reset consecutive errors on success

        if (availableDate) {
          if (availableDate !== lastAlertedDate) {
            if (isBookMode) {
              // Automatic Booking Mode
              const notifyMsg = `🔔 <b>Earlier Date Found!</b>\n📅 Slot: <code>${availableDate}</code>\n⚡ Attempting to book...`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, notifyMsg);

              const booked = await bot.bookAppointment(sessionHeaders, availableDate);

              if (booked) {
                const successMsg = `🎉 <b>Successfully Rescheduled!</b>\n📅 New Date: <code>${availableDate}</code>\n(Previous was ${currentBookedDate})`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, successMsg);

                // Update current date to the new available date
                currentBookedDate = availableDate;
                lastAlertedDate = availableDate;

                options = {
                  ...options,
                  current: currentBookedDate
                };

                if (targetDate && availableDate <= targetDate) {
                  log(`Target date reached! Successfully booked appointment on ${availableDate}`);
                  process.exit(0);
                }
              } else {
                const failMsg = `⚠️ Failed to book the slot at <code>${availableDate}</code>. Continuing check...`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, failMsg);
              }
            } else {
              // Alert-Only Mode (Prevent spam: only notifies if the available date is new/changed)
              const alertMsg = `🔔 <b>New Visa Slot Available!</b>\n📅 Date: <code>${availableDate}</code>\n📍 Tashkent (136)\n\n<i>This is an Alert-Only notification. The bot will NOT automatically reschedule.</i>`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, alertMsg);
              log(`[ALERT] Earlier slot available: ${availableDate}`);
              lastAlertedDate = availableDate;
            }
          }
        } else {
          // Reset lastAlertedDate if no slots are available anymore, allowing alerts if a slot reappears
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
            await sleep(900); // Wait 15 minutes
            consecutiveErrors = 0; // Reset error count after long sleep
          } else {
            log(`Waiting 15 seconds before retrying check...`);
            await sleep(15); // Wait a short 15 seconds before retrying
          }
          continue; // Keep checking using same session without logging in again
        } else {
          // Propagate authentication/session errors to trigger a re-login/re-initialization
          throw err;
        }
      }

      // Add randomized jitter (0 to 5 seconds) to make the request patterns less predictable
      const jitter = Math.random() * 5;
      const totalSleep = config.refreshDelay + jitter;
      await sleep(totalSleep);
    }
  } catch (err) {
    log(`Session/authentication error: ${err.message}. Re-initializing bot...`);
    // Wait 10 seconds before re-logging in to prevent rapid auth loops
    await sleep(10);
    return botCommand(options);
  }
}
