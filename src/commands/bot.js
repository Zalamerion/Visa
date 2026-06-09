import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';
import { sendTelegramMessage, startTelegramListener } from '../lib/telegram.js';

// ─── Daily Report Helpers ─────────────────────────────────────────────────────

/** Returns the current hour in UTC+5 (Tashkent timezone). */
function tashkentHour() {
  const utcHour = new Date().getUTCHours();
  return (utcHour + 5) % 24;
}

/** Returns today's date string in Tashkent time (YYYY-MM-DD). */
function tashkentDateString() {
  const now = new Date();
  const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return tashkent.toISOString().slice(0, 10);
}

// Daily-report hour in Tashkent time (default 20 = 8 PM).
const REPORT_HOUR = Number(process.env.DAILY_REPORT_HOUR ?? 20);

// ─── User-Agent Pool ──────────────────────────────────────────────────────────
// Rotating through realistic UA strings makes the bot harder to fingerprint.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Telegram Reply Markup ────────────────────────────────────────────────────
const defaultMarkup = {
  inline_keyboard: [
    [
      { text: '🔄 Check Earliest Slot Now', callback_data: 'check_now' },
      { text: 'ℹ️ Bot Status', callback_data: 'status_now' }
    ],
    [
      { text: '⏸ Pause Bot', callback_data: 'pause' },
      { text: '▶️ Resume Bot', callback_data: 'resume' }
    ]
  ]
};

// ─── Main Bot Command ─────────────────────────────────────────────────────────

export async function botCommand(options) {
  const config = getConfig();
  const isBookMode = !!options.book;
  const bot = new Bot(config, { dryRun: !isBookMode });
  let currentBookedDate = options.current;
  let dynamicTargetDate  = options.target;
  let dynamicMinDate     = options.min;
  let lastAlertedDate    = null;

  // ── Stats Tracking & Global State ──────────────────────────────────────────
  const startTime = new Date();
  let checksCount        = 0;
  let lastCheckTime      = null;
  let sessionHeaders     = null;
  let bestDateToday      = null;
  let reportSentForDay   = null;
  let consecutiveErrors  = 0;

  // ── Runtime Control Flags ───────────────────────────────────────────────────
  let isPaused           = false;   // /pause and /resume
  let isChecking         = false;   // mutex: prevents concurrent API calls
  let currentInterval    = config.refreshDelay; // /interval <sec>
  // ───────────────────────────────────────────────────────────────────────────

  log(`Initializing with current date ${currentBookedDate}`);
  log(`Mode: ${isBookMode ? '⚡ AUTOMATIC BOOKING' : '🔔 ALERT-ONLY'}`);
  log(`Daily summary report scheduled at ${REPORT_HOUR}:00 Tashkent time`);
  log(`User-Agent rotation enabled (${USER_AGENTS.length} agents)`);

  // ── Helper: run a protected date check with mutex ──────────────────────────
  async function performCheck(label = 'Auto') {
    if (isChecking) {
      log(`[${label}] Check skipped — another check is already in progress.`);
      return null;
    }
    isChecking = true;
    try {
      if (!sessionHeaders) {
        log(`[${label}] No session — logging in...`);
        sessionHeaders = await bot.initialize(randomUserAgent());
        consecutiveErrors = 0;
      }
      const dates = await bot.client.checkAvailableDate(
        sessionHeaders,
        config.scheduleId,
        config.facilityId
      );
      return dates;
    } catch (err) {
      // Detect session expiry: server sends HTML when session is gone
      if (err.message && (
          err.message.includes('Unexpected token') ||
          err.message.includes('SyntaxError') ||
          err.message.includes('not valid JSON') ||
          err.message.includes('DOCTYPE')
        )) {
        log(`[${label}] Session expired (got HTML instead of JSON). Clearing session.`);
        sessionHeaders = null;
        throw new Error('SESSION_EXPIRED');
      }
      throw err;
    } finally {
      isChecking = false;
    }
  }

  // 1. Notify start via Telegram (ONLY ONCE)
  if (config.telegramBotToken && config.telegramChatId) {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `🤖 <b>US Visa Bot Started</b>\n` +
      `📅 Current Appointment: <code>${currentBookedDate}</code>\n` +
      `🎯 Target: <code>${dynamicTargetDate || 'None'}</code>\n` +
      `⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only (No Booking)'}</code>\n` +
      `⏳ Check Interval: <code>${currentInterval}</code>s\n` +
      `📊 Daily summary at <code>${REPORT_HOUR}:00</code> Tashkent time.\n\n` +
      `<b>Commands:</b>\n` +
      `/status — Bot status\n` +
      `/check — Check slots now\n` +
      `/pause — Pause checking\n` +
      `/resume — Resume checking\n` +
      `/interval &lt;sec&gt; — Change check interval\n` +
      `/target &lt;YYYY-MM-DD&gt; — Set target date\n` +
      `/min &lt;YYYY-MM-DD&gt; — Set minimum date`,
      defaultMarkup
    );

    // ── Start background Telegram updates listener (ONLY ONCE) ───────────────
    startTelegramListener(config.telegramBotToken, config.telegramChatId, async ({ type, cmd, args }) => {

      // ── /status (and button) ──────────────────────────────────────────────
      if (cmd === 'status_now' || cmd === '/status') {
        const uptimeMs   = new Date() - startTime;
        const uptimeHrs  = Math.floor(uptimeMs / (1000 * 60 * 60));
        const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

        await sendTelegramMessage(
          config.telegramBotToken,
          config.telegramChatId,
          `${isPaused ? '⏸' : '🟢'} <b>Bot Status: ${isPaused ? 'Paused' : 'Active & Running'}</b>\n\n` +
          `⏱ Uptime: <code>${uptimeHrs}h ${uptimeMins}m</code>\n` +
          `🔄 Total Checks: <code>${checksCount}</code>\n` +
          `📅 Last Check: <code>${lastCheckTime ? lastCheckTime.toLocaleTimeString('en-US', { timeZone: 'Asia/Tashkent' }) : 'Never'}</code> (Tashkent)\n` +
          `⚙️ Mode: <code>${isBookMode ? 'Automatic Booking' : 'Alert-Only'}</code>\n` +
          `⏳ Interval: <code>${currentInterval}</code>s\n` +
          `🗓 Current Appointment: <code>${currentBookedDate}</code>\n` +
          `🎯 Target Date: <code>${dynamicTargetDate || 'None'}</code>\n` +
          `🔻 Min Date: <code>${dynamicMinDate || 'None'}</code>`,
          defaultMarkup
        );
        return;
      }

      // ── /check (and button) ───────────────────────────────────────────────
      if (cmd === 'check_now' || cmd === '/check') {
        if (isChecking) {
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `⏳ A check is already in progress. Please wait a moment.`);
          return;
        }
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `🔍 Fetching the absolute earliest slot from the visa system...`);
        try {
          const dates = await performCheck('Manual');
          if (!dates || dates.length === 0) {
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
              `🔍 <b>Instant Slot Check</b>\n\n❌ No slots are currently available at all.`,
              defaultMarkup);
            return;
          }
          dates.sort();
          const earliest = dates[0];
          await sendTelegramMessage(
            config.telegramBotToken, config.telegramChatId,
            `🔍 <b>Instant Slot Check</b>\n\n` +
            `📅 Earliest available date: <code>${earliest}</code>\n` +
            `🗓 Your appointment: <code>${currentBookedDate}</code>\n` +
            `🔢 Total slots open: <code>${dates.length}</code>\n\n` +
            (earliest < currentBookedDate
              ? `⚡ <b>Earlier slot exists!</b>`
              : `ℹ️ No earlier slots than your current one.`),
            defaultMarkup
          );
        } catch (err) {
          // Re-auth once on session expiry then retry
          try {
            sessionHeaders = await bot.initialize(randomUserAgent());
            const dates = await performCheck('Manual-Retry');
            if (!dates || dates.length === 0) {
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
                `🔍 <b>Instant Slot Check</b>\n\n❌ No slots currently available.`, defaultMarkup);
              return;
            }
            dates.sort();
            const earliest = dates[0];
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
              `🔍 <b>Instant Slot Check (Reconnected)</b>\n\n` +
              `📅 Earliest: <code>${earliest}</code>\n` +
              `🗓 Your appointment: <code>${currentBookedDate}</code>\n` +
              `🔢 Total slots: <code>${dates.length}</code>\n\n` +
              (earliest < currentBookedDate ? `⚡ <b>Earlier slot exists!</b>` : `ℹ️ No earlier slots.`),
              defaultMarkup);
          } catch (retryErr) {
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
              `❌ <b>Check Failed</b>\n\nCould not fetch slots. Reason: <code>${retryErr.message}</code>`,
              defaultMarkup);
          }
        }
        return;
      }

      // ── /pause (and button) ───────────────────────────────────────────────
      if (cmd === 'pause' || cmd === '/pause') {
        isPaused = true;
        log('Bot paused by Telegram command.');
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `⏸ <b>Bot Paused</b>\n\nThe bot will stop checking for slots until you send /resume.`,
          defaultMarkup);
        return;
      }

      // ── /resume (and button) ──────────────────────────────────────────────
      if (cmd === 'resume' || cmd === '/resume') {
        isPaused = false;
        log('Bot resumed by Telegram command.');
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `▶️ <b>Bot Resumed</b>\n\nChecking will continue every <code>${currentInterval}</code>s.`,
          defaultMarkup);
        return;
      }

      // ── /interval <seconds> ───────────────────────────────────────────────
      if (cmd === '/interval') {
        const val = parseInt(args[0], 10);
        if (!args[0] || isNaN(val) || val < 30) {
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `⚠️ Usage: <code>/interval &lt;seconds&gt;</code>\nMinimum is 30 seconds.\nExample: <code>/interval 300</code>`);
          return;
        }
        currentInterval = val;
        log(`Check interval updated to ${val}s via Telegram.`);
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `✅ <b>Check Interval Updated</b>\n\nNew interval: <code>${val}</code> seconds.`, defaultMarkup);
        return;
      }

      // ── /target <YYYY-MM-DD> ──────────────────────────────────────────────
      if (cmd === '/target') {
        if (!args[0]) {
          dynamicTargetDate = null;
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `✅ <b>Target Date Cleared</b>\n\nThe bot will now alert on any earlier slot.`, defaultMarkup);
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `⚠️ Usage: <code>/target &lt;YYYY-MM-DD&gt;</code>\nExample: <code>/target 2026-09-15</code>`);
          return;
        }
        dynamicTargetDate = args[0];
        lastAlertedDate = null; // reset so it re-alerts if already found
        log(`Target date updated to ${dynamicTargetDate} via Telegram.`);
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `✅ <b>Target Date Updated</b>\n\nThe bot will now only alert on slots on or before <code>${dynamicTargetDate}</code>.`, defaultMarkup);
        return;
      }

      // ── /min <YYYY-MM-DD> ─────────────────────────────────────────────────
      if (cmd === '/min') {
        if (!args[0]) {
          dynamicMinDate = null;
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `✅ <b>Minimum Date Cleared</b>\n\nNo lower bound on slot dates.`, defaultMarkup);
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
          await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
            `⚠️ Usage: <code>/min &lt;YYYY-MM-DD&gt;</code>\nExample: <code>/min 2026-08-01</code>`);
          return;
        }
        dynamicMinDate = args[0];
        lastAlertedDate = null;
        log(`Min date updated to ${dynamicMinDate} via Telegram.`);
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `✅ <b>Minimum Date Updated</b>\n\nThe bot will ignore slots before <code>${dynamicMinDate}</code>.`, defaultMarkup);
        return;
      }

      // ── /help ─────────────────────────────────────────────────────────────
      if (cmd === '/help') {
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId,
          `📖 <b>Available Commands</b>\n\n` +
          `/status — Show bot status, uptime, and current config\n` +
          `/check — Manually check for the earliest available slot\n` +
          `/pause — Pause the automatic checking loop\n` +
          `/resume — Resume the automatic checking loop\n` +
          `/interval &lt;sec&gt; — Change check interval (min 30s)\n` +
          `  Example: <code>/interval 300</code>\n` +
          `/target &lt;YYYY-MM-DD&gt; — Only alert on slots on or before this date\n` +
          `  Example: <code>/target 2026-09-15</code>\n` +
          `/min &lt;YYYY-MM-DD&gt; — Ignore slots before this date\n` +
          `  Example: <code>/min 2026-08-01</code>\n` +
          `/help — Show this help message`,
          defaultMarkup);
        return;
      }

    }).catch(err => log(`Failed to start Telegram updates listener: ${err.message}`));
  }

  // 2. Loop continuously (re-authenticates internally on catch)
  while (true) {
    try {
      // ── Pause gate ────────────────────────────────────────────────────────
      if (isPaused) {
        await sleep(5);
        continue;
      }

      if (!sessionHeaders) {
        log('Initializing visa bot session...');
        sessionHeaders = await bot.initialize(randomUserAgent());
        consecutiveErrors = 0;
      }

      // ── Daily report trigger ───────────────────────────────────────────────
      const todayStr = tashkentDateString();
      const nowHour  = tashkentHour();

      if (nowHour === REPORT_HOUR) {
        if (reportSentForDay !== todayStr) {
          reportSentForDay = todayStr;

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

          bestDateToday = null;
        }
      } else {
        reportSentForDay = null;
      }

      // ── Perform the check (mutex-guarded) ─────────────────────────────────
      try {
        if (isChecking) {
          // A manual check is running — skip this tick
          await sleep(5);
          continue;
        }

        const availableDate = await bot.checkAvailableDate(
          sessionHeaders,
          currentBookedDate,
          dynamicMinDate
        );
        consecutiveErrors = 0;

        checksCount++;
        lastCheckTime = new Date();

        if (availableDate) {
          // Track best date today
          if (!bestDateToday || availableDate < bestDateToday) {
            bestDateToday = availableDate;
            log(`[DAILY TRACKER] New best slot today: ${bestDateToday}`);
          }

          // Apply dynamic target filter
          if (dynamicTargetDate && availableDate > dynamicTargetDate) {
            log(`Slot ${availableDate} is after target date ${dynamicTargetDate}, skipping.`);
          } else if (availableDate !== lastAlertedDate) {
            if (isBookMode) {
              const notifyMsg = `🔔 <b>Earlier Date Found!</b>\n📅 Slot: <code>${availableDate}</code>\n⚡ Attempting to book...`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, notifyMsg, defaultMarkup);

              const booked = await bot.bookAppointment(sessionHeaders, availableDate);

              if (booked) {
                const successMsg = `🎉 <b>Successfully Rescheduled!</b>\n📅 New Date: <code>${availableDate}</code>\n(Previous was ${currentBookedDate})`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, successMsg, defaultMarkup);

                currentBookedDate = availableDate;
                lastAlertedDate   = availableDate;

                if (dynamicTargetDate && availableDate <= dynamicTargetDate) {
                  log(`Target date reached! Successfully booked appointment on ${availableDate}`);
                  process.exit(0);
                }
              } else {
                const failMsg = `⚠️ Failed to book the slot at <code>${availableDate}</code>. Continuing check...`;
                await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, failMsg, defaultMarkup);
              }
            } else {
              const alertMsg =
                `🔔 <b>New Visa Slot Available!</b>\n` +
                `📅 Date: <code>${availableDate}</code>\n` +
                `📍 Tashkent (136)\n\n` +
                `<i>Alert-Only mode — bot will NOT auto-reschedule.</i>`;
              await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, alertMsg, defaultMarkup);
              log(`[ALERT] Earlier slot available: ${availableDate}`);
              lastAlertedDate = availableDate;
            }
          }
        } else {
          lastAlertedDate = null;
        }

      } catch (err) {
        // Session expiry — trigger re-login
        if (err.message === 'SESSION_EXPIRED' || (err.message && (
              err.message.includes('Unexpected token') ||
              err.message.includes('SyntaxError') ||
              err.message.includes('not valid JSON') ||
              err.message.includes('DOCTYPE')
            ))) {
          log(`[Session Expired] Session cookie is invalid. Re-authenticating...`);
          sessionHeaders = null;
          await sleep(5);
          continue;
        }

        if (isSocketHangupError(err)) {
          consecutiveErrors++;
          log(`Socket error (attempt ${consecutiveErrors}): ${err.message}`);

          if (consecutiveErrors >= 3) {
            const errorMsg = `⚠️ <b>Persistent Network Issue:</b> Failed ${consecutiveErrors} times in a row (${err.message}). Sleeping 15 min to prevent IP ban...`;
            await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, errorMsg, defaultMarkup);
            log(`Persistent socket error. Waiting 15 minutes...`);
            await sleep(900);
            consecutiveErrors = 0;
          } else {
            log(`Waiting 30 seconds before retrying check...`);
            await sleep(30);
          }
          continue;
        } else {
          throw err; // propagate auth/session error to outer catch
        }
      }

      // ── Sleep between ticks with jitter ────────────────────────────────────
      const jitter     = Math.random() * (currentInterval * 0.1); // 10% jitter
      const totalSleep = currentInterval + jitter;
      await sleep(totalSleep);

    } catch (err) {
      consecutiveErrors++;
      const isNetwork = isSocketHangupError(err);
      const sleepSeconds = isNetwork
        ? Math.min(60 * Math.pow(2, Math.min(consecutiveErrors - 1, 6)), 900)
        : 10;

      log(`Session/authentication error (attempt ${consecutiveErrors}): ${err.message}. Re-initializing in ${sleepSeconds}s...`);

      if (isNetwork && consecutiveErrors >= 3) {
        const errorMsg = `⚠️ <b>Persistent Connection Issue:</b> Failed to login/initialize (${err.message}). Retrying in ${Math.round(sleepSeconds / 60)} minutes...`;
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, errorMsg, defaultMarkup).catch(() => {});
      }

      sessionHeaders = null;
      await sleep(sleepSeconds);
    }
  }
}
