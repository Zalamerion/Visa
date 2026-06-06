import fetch from 'node-fetch';
import { log } from './utils.js';

/**
 * Sends a message to a Telegram chat using the Telegram Bot API.
 * @param {string} token Telegram Bot Token
 * @param {string} chatId Telegram Chat ID
 * @param {string} message Message to send (supports basic HTML)
 */
export async function sendTelegramMessage(token, chatId, message) {
  if (!token || !chatId) {
    log('Telegram token or chat ID is not configured. Skipping notification.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
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
