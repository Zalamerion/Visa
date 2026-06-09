import cheerio from 'cheerio';
import { log, fetchWithTimeout } from './utils.js';
import { getBaseUri } from './config.js';

/**
 * Builds a browser-realistic header set for a given User-Agent.
 * Connection: keep-alive — browsers never send 'close' for XHR / page loads.
 * Accept-Language and sec-fetch-* are checked by Cloudflare during fingerprinting.
 */
function buildCommonHeaders(userAgent) {
  return {
    'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',  // NEVER 'close' — Cloudflare flags this
  };
}

/**
 * Builds the headers specifically used for XHR/JSON API calls.
 * sec-fetch-* headers are included in every real browser XHR.
 */
function buildXhrHeaders(sessionHeaders) {
  return {
    ...sessionHeaders,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    // Remove Connection:close if it crept in from session headers
    'Connection': 'keep-alive',
  };
}

export class VisaHttpClient {
  constructor(countryCode, email, password) {
    this.baseUri = getBaseUri(countryCode);
    this.email = email;
    this.password = password;
    this._sessionUserAgent = null;
  }

  // ── Public API methods ───────────────────────────────────────────────────────

  async login(userAgent) {
    log(`Logging in with UA: ${(userAgent || 'default').slice(0, 60)}...`);
    this._sessionUserAgent = userAgent;

    const anonymousHeaders = await this._anonymousRequest(`${this.baseUri}/users/sign_in`, {}, userAgent)
      .then(response => this._extractHeaders(response, userAgent));

    const loginData = {
      'utf8': '✓',
      'user[email]': this.email,
      'user[password]': this.password,
      'policy_confirmed': '1',
      'commit': 'Sign In'
    };

    return this._submitForm(`${this.baseUri}/users/sign_in`, anonymousHeaders, loginData)
      .then(res => ({
        ...anonymousHeaders,
        'Cookie': this._extractRelevantCookies(res)
      }));
  }

  async checkAvailableDate(headers, scheduleId, facilityId) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment/days/${facilityId}.json?appointments[expedite]=false`;
    const referer = `${this.baseUri}/schedule/${scheduleId}/appointment`;
    return this._jsonRequest(url, headers, referer)
      .then(data => data.map(item => item.date));
  }

  async checkAvailableTime(headers, scheduleId, facilityId, date) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;
    const referer = `${this.baseUri}/schedule/${scheduleId}/appointment`;
    return this._jsonRequest(url, headers, referer)
      .then(data => data['business_times'][0] || data['available_times'][0]);
  }

  async book(headers, scheduleId, facilityId, date, time) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment`;

    const bookingHeaders = await this._anonymousRequest(url, headers, this._sessionUserAgent)
      .then(response => this._extractHeaders(response, this._sessionUserAgent));

    const bookingData = {
      'utf8': '✓',
      'authenticity_token': bookingHeaders['X-CSRF-Token'],
      'confirmed_limit_message': '1',
      'use_consulate_appointment_capacity': 'true',
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    };

    return this._submitFormWithRedirect(url, bookingHeaders, bookingData);
  }

  // ── Private request methods ──────────────────────────────────────────────────

  async _anonymousRequest(url, headers = {}, userAgent) {
    return fetchWithTimeout(url, {
      headers: {
        'User-Agent': userAgent || '',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        ...headers
      }
    }, 20000);
  }

  /**
   * JSON XHR request — uses realistic browser headers for the AJAX call.
   * NOTE: 'cache' is a browser Fetch API option and is ignored by node-fetch.
   *       We use Cache-Control header instead.
   * @param {string} referer — the page URL the request is made from (important for Cloudflare)
   */
  async _jsonRequest(url, headers = {}, referer = null) {
    return fetchWithTimeout(url, {
      headers: {
        ...buildXhrHeaders(headers),
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...(referer ? { 'Referer': referer } : {})
      }
    }, 20000)
      .then(async r => {
        const text = await r.text();
        // Detect session expiry: server redirects to HTML login page
        if (text.includes('<!DOCTYPE') || text.includes('<html')) {
          throw new Error('SESSION_EXPIRED: Server returned HTML instead of JSON');
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`SESSION_EXPIRED: Invalid JSON response — ${text.slice(0, 80)}`);
        }
      })
      .then(r => this._handleErrors(r));
  }

  async _submitForm(url, headers = {}, formData = {}) {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
      body: new URLSearchParams(formData)
    }, 20000);
  }

  async _submitFormWithRedirect(url, headers = {}, formData = {}) {
    return fetchWithTimeout(url, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams(formData)
    }, 30000);
  }

  // ── Private utility methods ──────────────────────────────────────────────────

  async _extractHeaders(res, userAgent) {
    const cookies = this._extractRelevantCookies(res);
    const html = await res.text();
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content');

    if (!csrfToken) {
      throw new Error('SESSION_EXPIRED: No CSRF token found in response HTML');
    }

    return {
      ...buildCommonHeaders(userAgent || this._sessionUserAgent),
      'Cookie': cookies,
      'X-CSRF-Token': csrfToken,
      'Referer': this.baseUri,
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
  }

  _extractRelevantCookies(res) {
    const raw = res.headers.get('set-cookie');
    if (!raw) return '';
    const parsedCookies = this._parseCookies(raw);
    return `_yatri_session=${parsedCookies['_yatri_session'] || ''}`;
  }

  _parseCookies(cookies) {
    const parsedCookies = {};
    cookies.split(';').map(c => c.trim()).forEach(c => {
      const [name, value] = c.split('=', 2);
      parsedCookies[name] = value;
    });
    return parsedCookies;
  }

  _handleErrors(response) {
    const errorMessage = response['error'];
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return response;
  }
}
