#!/usr/bin/env node

import readline from 'readline';
import { botCommand } from './commands/bot.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config(); // Load .env if present (local dev)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'saved_config.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ask(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

/**
 * Returns true when all required env vars are already set
 * (Railway / any non-interactive cloud environment).
 */
function getMissingEnvConfigs() {
  const required = [
    'EMAIL',
    'PASSWORD',
    'COUNTRY_CODE',
    'SCHEDULE_ID',
    'FACILITY_ID',
    'CURRENT_DATE',
  ];
  return required.filter((k) => !process.env[k]);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const missing = getMissingEnvConfigs();

  // ── Railway / CI / non-interactive mode ────────────────────────────────────
  // If every required env var is already present we skip the wizard entirely
  // and start the bot immediately. This is the path used on Railway.
  if (missing.length === 0) {
    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║   🚀  US Visa Bot — Cloud Mode        ║');
    console.log('╚═══════════════════════════════════════╝\n');
    console.log('✅ All environment variables detected — skipping interactive setup.');
    console.log(`   EMAIL:        ${process.env.EMAIL}`);
    console.log(`   SCHEDULE_ID:  ${process.env.SCHEDULE_ID}`);
    console.log(`   FACILITY_ID:  ${process.env.FACILITY_ID}`);
    console.log(`   COUNTRY_CODE: ${process.env.COUNTRY_CODE}`);
    console.log(`   CURRENT_DATE: ${process.env.CURRENT_DATE}`);
    console.log(`   REFRESH_DELAY:${process.env.REFRESH_DELAY || '5'}s`);
    console.log(`   TELEGRAM:     ${process.env.TELEGRAM_BOT_TOKEN ? '✅ configured' : '❌ not set'}\n`);

    await startBot({
      email:           process.env.EMAIL,
      password:        process.env.PASSWORD,
      countryCode:     process.env.COUNTRY_CODE,
      scheduleId:      process.env.SCHEDULE_ID,
      facilityId:      process.env.FACILITY_ID,
      currentDate:     process.env.CURRENT_DATE,
      telegramBotToken:process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId:  process.env.TELEGRAM_CHAT_ID,
      refreshDelay:    process.env.REFRESH_DELAY || '5',
      bookMode:        process.env.BOOK_MODE === 'true',
    });
    return;
  }

  // Log exactly what is missing if we're not starting in cloud mode
  console.log(`⚠️ Missing environment variables for Cloud Mode: ${missing.join(', ')}`);


  // ── Local interactive wizard ───────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║        🇺🇸  US Visa Bot Setup         ║');
  console.log('╚═══════════════════════════════════════╝\n');

  const saved = loadSavedConfig();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Show saved config and ask to reuse
  if (Object.keys(saved).length > 0) {
    console.log('📂 Found saved configuration:');
    console.log(`   Email:        ${saved.email || '(not set)'}`);
    console.log(`   Schedule ID:  ${saved.scheduleId || '(not set)'}`);
    console.log(`   Facility ID:  ${saved.facilityId || '(not set)'}`);
    console.log(`   Country:      ${saved.countryCode || '(not set)'}`);
    console.log(`   Telegram:     ${saved.telegramChatId ? '✅ configured' : '❌ not set'}`);
    console.log('');

    const reuse = await ask(rl, '↩️  Use saved config? (yes/no)', 'yes');
    if (reuse.toLowerCase() === 'yes' || reuse.toLowerCase() === 'y') {
      rl.close();
      await startBot(saved);
      return;
    }
    console.log('');
  }

  console.log('📋 Please enter your configuration:\n');

  // Credentials
  console.log('── Login Credentials ───────────────────');
  const email    = await ask(rl, '📧 Email', saved.email || process.env.EMAIL);
  const password = await ask(rl, '🔑 Password', saved.password || process.env.PASSWORD);

  // Visa details
  console.log('\n── Visa Appointment Details ────────────');
  const countryCode  = await ask(rl, '🌍 Country Code (e.g. uz for Uzbekistan)', saved.countryCode || process.env.COUNTRY_CODE || 'uz');
  const scheduleId   = await ask(rl, '🗓  Schedule ID (from URL)', saved.scheduleId || process.env.SCHEDULE_ID);
  const facilityId   = await ask(rl, '🏛  Facility ID (136 = Tashkent)', saved.facilityId || process.env.FACILITY_ID || '136');
  const currentDate  = await ask(rl, '📅 Your current appointment date (YYYY-MM-DD)', saved.currentDate || process.env.CURRENT_DATE);

  // Telegram
  console.log('\n── Telegram Notifications ──────────────');
  const telegramToken  = await ask(rl, '🤖 Telegram Bot Token', saved.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = await ask(rl, '💬 Telegram Chat ID', saved.telegramChatId || process.env.TELEGRAM_CHAT_ID);

  // Options
  console.log('\n── Bot Options ─────────────────────────');
  const refreshDelay = await ask(rl, '⏳ Check interval in seconds', saved.refreshDelay || process.env.REFRESH_DELAY || '5');
  const bookMode     = await ask(rl, '⚡ Auto-book when slot found? (yes/no)', 'no');

  rl.close();

  const config = {
    email,
    password,
    countryCode,
    scheduleId,
    facilityId,
    currentDate,
    telegramBotToken: telegramToken,
    telegramChatId,
    refreshDelay,
    bookMode: bookMode.toLowerCase() === 'yes' || bookMode.toLowerCase() === 'y',
  };

  // Save config for next run (without password for security)
  const configToSave = { ...config };
  delete configToSave.password;
  saveConfig(configToSave);

  console.log('\n✅ Configuration saved! Starting bot...\n');
  await startBot(config);
}

// ─── startBot ────────────────────────────────────────────────────────────────

async function startBot(config) {
  // Push everything into process.env so lib/config.js can read it
  if (config.email)            process.env.EMAIL            = config.email;
  if (config.password)         process.env.PASSWORD         = config.password;
  if (config.countryCode)      process.env.COUNTRY_CODE     = config.countryCode;
  if (config.scheduleId)       process.env.SCHEDULE_ID      = config.scheduleId;
  if (config.facilityId)       process.env.FACILITY_ID      = config.facilityId;
  if (config.refreshDelay)     process.env.REFRESH_DELAY    = String(config.refreshDelay);
  if (config.telegramBotToken) process.env.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  if (config.telegramChatId)   process.env.TELEGRAM_CHAT_ID   = config.telegramChatId;

  // Prompt for password only if still not set (local interactive fallback)
  if (!process.env.PASSWORD) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question('🔑 Enter your password: ', (pw) => {
        process.env.PASSWORD = pw.trim();
        rl.close();
        resolve();
      });
    });
  }

  // Prompt for current date if still not set (local interactive fallback)
  if (!config.currentDate) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question('📅 Enter your current appointment date (YYYY-MM-DD): ', (d) => {
        config.currentDate = d.trim();
        rl.close();
        resolve();
      });
    });
  }

  await botCommand({
    current: config.currentDate,
    book:    config.bookMode || false,
    target:  undefined,
    min:     undefined,
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
