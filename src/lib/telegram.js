import fetch from 'node-fetch';
import { log } from './utils.js';

/**
 * Sends a message to a Telegram chat using the Telegram Bot API.
 * @param {string} token Telegram Bot Token
 * @param {string} chatId Telegram Chat ID
 * @param {string} message Message to send (supports basic HTML)
 * @param {object} replyMarkup Optional inline keyboard or other reply markup
 */
export async function sendTelegramMessage(token, chatId, message, replyMarkup = null) {
  if (!token || !chatId) {
    log('Telegram token or chat ID is not configured. Skipping notification.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`Telegram API returned an error: ${errorText}`);
    } else {
      log('Telegram notification sent successfully.');
    }
  } catch (error) {
    log(`Failed to send Telegram message: ${error.message}`);
  }
}

/**
 * Long polls Telegram updates to listen for command messages or callback query events.
 * @param {string} token Telegram Bot Token
 * @param {string} chatId Telegram Chat ID
 * @param {function} onCommand Callback function when status/check command is triggered
 */
export async function startTelegramListener(token, chatId, onCommand) {
  if (!token || !chatId) {
    log('Telegram credentials missing, listener will not start.');
    return;
  }

  let offset = 0;

  // Initialize offset by fetching recent updates to skip old commands sent when bot was offline
  try {
    const initRes = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`);
    if (initRes.ok) {
      const data = await initRes.json();
      if (data.ok && data.result.length > 0) {
        offset = data.result[data.result.length - 1].update_id + 1;
      }
    }
  } catch (err) {
    log(`Telegram listener init error: ${err.message}`);
  }

  log('Telegram updates listener started (polling)...');

  while (true) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`, {
        headers: { 'Connection': 'keep-alive' }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            offset = update.update_id + 1;

            // Handle Callback Queries (from inline keyboard buttons)
            if (update.callback_query) {
              const query = update.callback_query;
              if (String(query.message.chat.id) === String(chatId)) {
                // Acknowledge the callback query so the loading spinner on the button stops
                await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ callback_query_id: query.id })
                }).catch(() => {});

                log(`Telegram action clicked: ${query.data}`);
                // Trigger callback
                onCommand(query.data).catch(err => log(`Error handling callback: ${err.message}`));
              }
            }

            // Handle Standard Text Commands
            if (update.message && String(update.message.chat.id) === String(chatId)) {
              const text = update.message.text?.trim().toLowerCase();
              if (text === '/status' || text === '/check') {
                log(`Telegram text command received: ${text}`);
                const cmd = text === '/status' ? 'status_now' : 'check_now';
                onCommand(cmd).catch(err => log(`Error handling text command: ${err.message}`));
              }
            }
          }
        }
      }
    } catch (e) {
      log(`Error in Telegram listener: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
