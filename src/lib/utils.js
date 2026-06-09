import fetch from 'node-fetch';

export function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

export function log(message) {
  console.log(`[${new Date().toISOString()}]`, message);
}

export function isSocketHangupError(err) {
  if (!err) return false;
  const message = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  
  return code === 'econnreset' || 
         code === 'enotfound' || 
         code === 'etimedout' ||
         code === 'econnrefused' ||
         code === 'eaddrinuse' ||
         code === 'epipe' ||
         code === 'enetunreach' ||
         code === 'ehostunreach' ||
         code === 'eai_again' ||
         message.includes('socket hang up') ||
         message.includes('hang up') ||
         message.includes('timeout') ||
         message.includes('network') ||
         message.includes('connect') ||
         message.includes('refused') ||
         message.includes('dns') ||
         message.includes('abort') ||
         message.includes('fetch failed');
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}