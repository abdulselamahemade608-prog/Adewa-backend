'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { ethers } = require('ethers');

const app = express();
app.use(express.json({ limit: '1mb' }));

// =========================================================
// CONFIG  (set these in Vercel -> Settings -> Environment Variables)
// =========================================================

const env = process.env;

const BOT_TOKEN = env.BOT_TOKEN;
const DATABASE_URL = env.DATABASE_URL;
const WEBHOOK_SECRET = env.WEBHOOK_SECRET || 'adewa_webhook_secret';

// Admin Telegram IDs, comma separated
const ADMIN_IDS = String(env.ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

const MINI_APP_URL = env.MINI_APP_URL || 'https://abdulselamahemade608-prog.github.io/Adewa/';
const WEBHOOK_URL = env.WEBHOOK_URL || 'https://backend-rho-tan-62.vercel.app/telegram/webhook';
const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || 'https://abdulselamahemade608-prog.github.io';

// Payout
const PAYOUT_PRIVATE_KEY = env.PAYOUT_PRIVATE_KEY || ''; // hot wallet (keep small balance!)
const BSC_RPC = env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const PROOF_CHAT_ID = env.PROOF_CHAT_ID || '';           // proof group chat id, e.g. -100123...
const EXPLORER_TX = env.EXPLORER_TX_URL || 'https://bscscan.com/tx/';
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_ABI = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN is not configured.');
if (!DATABASE_URL) console.warn('WARNING: DATABASE_URL is not configured.');

// Editable from the admin panel
const DEFAULTS = {
  coins_per_ad: 20,
  daily_ad_limit: 20,
  ad_cooldown_seconds: 15,
  min_ad_seconds: 5,
  invite_bonus: 500,
  coins_per_usdt: 10000,
  min_withdraw_usdt: 1,
  withdraw_fee_usdt: 0.01
};

// =========================================================
// POSTGRES + SCHEMA
// =========================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

let dbReady = null;

function initDatabase() {
  if (dbReady) return dbReady;

  dbReady = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS fraud_users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT '',
        first_name TEXT NOT NULL DEFAULT '',
        ip_hash TEXT NOT NULL DEFAULT '',
        device_hash TEXT NOT NULL DEFAULT '',
        vpn_detected BOOLEAN NOT NULL DEFAULT FALSE,
        proxy_detected BOOLEAN NOT NULL DEFAULT FALSE,
        risk_score INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        ban_reason TEXT NOT NULL DEFAULT '',
        verification_message_sent BOOLEAN NOT NULL DEFAULT FALSE,
        ban_message_sent BOOLEAN NOT NULL DEFAULT FALSE,
        whitelisted BOOLEAN NOT NULL DEFAULT FALSE,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        request_count INTEGER NOT NULL DEFAULT 0
      )`,
      `ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS verification_message_sent BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS ban_message_sent BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS whitelisted BOOLEAN NOT NULL DEFAULT FALSE`,

      `CREATE TABLE IF NOT EXISTS user_balance (
        telegram_id BIGINT PRIMARY KEY,
        coins BIGINT NOT NULL DEFAULT 0,
        ads_coins BIGINT NOT NULL DEFAULT 0,
        invite_coins BIGINT NOT NULL DEFAULT 0,
        task_coins BIGINT NOT NULL DEFAULT 0,
        total_ads INTEGER NOT NULL DEFAULT 0,
        ads_today INTEGER NOT NULL DEFAULT 0,
        ads_day DATE,
        last_ad_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,

      `CREATE TABLE IF NOT EXISTS ad_sessions (
        token TEXT PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,

      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS referrals (
        invitee_id BIGINT PRIMARY KEY,
        inviter_id BIGINT NOT NULL,
        rewarded BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,

      // New table for USDT payouts (the old Birr "withdrawals" table is no longer used)
      `CREATE TABLE IF NOT EXISTS payouts (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        address TEXT NOT NULL,
        coins BIGINT NOT NULL,
        usdt NUMERIC(18,6) NOT NULL,
        fee NUMERIC(18,6) NOT NULL DEFAULT 0,
        net NUMERIC(18,6) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_hash TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ
      )`
    ];

    for (const q of statements) await pool.query(q);

    for (const [k, v] of Object.entries(DEFAULTS)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [k, String(v)]
      );
    }

    console.log('Database initialized.');
  })().catch((error) => {
    dbReady = null;
    console.error('Database initialization error:', error);
    throw error;
  });

  return dbReady;
}

// =========================================================
// SMALL HELPERS
// =========================================================

const sha256 = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');

// 0.0263 -> "0.0263", 1.5 -> "1.5"
const fmt = (n) => parseFloat(Number(n).toFixed(6)).toString();

const coinsToMicro = (coins, rate) => Math.floor((Number(coins) * 1e6) / rate);

const microToStr = (micro) => (micro / 1e6).toFixed(6);

function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

async function getSettings() {
  const s = { ...DEFAULTS };
  const r = await pool.query('SELECT key, value FROM app_settings');
  for (const row of r.rows) {
    const n = Number(row.value);
    if (Number.isFinite(n) && row.key in DEFAULTS) s[row.key] = n;
  }
  return s;
}

async function userName(id) {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(first_name,''), NULLIF(username,''), 'User') AS n
     FROM fraud_users WHERE telegram_id = $1`,
    [id]
  );
  return r.rows[0]?.n || 'User';
}

// =========================================================
// TELEGRAM API
// =========================================================

async function telegram(method, data = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing.');

  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram API error: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    await telegram('sendMessage', { chat_id: chatId, text, ...extra });
    return true;
  } catch (error) {
    console.error('sendMessage error:', error.message);
    return false;
  }
}

const BAN_TEXT = {
  vpn: '🚫 VPN/Proxy detected.\n\nYour account has been permanently banned from Adewa.',
  multi: '🚫 Multiple accounts detected.\n\nYour account has been permanently banned from Adewa.',
  other: '🚫 Your account has been permanently banned from Adewa.'
};

const sendBanMessage = (chatId, type) => sendTelegramMessage(chatId, BAN_TEXT[type] || BAN_TEXT.other);

function getBanType(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('vpn') || r.includes('proxy') || r.includes('tor')) return 'vpn';
  if (r.includes('multiple') || r.includes('multi account')) return 'multi';
  return 'other';
}

let botUsername = null;

async function getBotUsername() {
  if (botUsername) return botUsername;
  const r = await telegram('getMe');
  botUsername = r.result.username;
  return botUsername;
}

// =========================================================
// TELEGRAM initData VERIFICATION
// =========================================================

function verifyInitData(initData) {
  if (!initData) return { ok: false, reason: 'Missing Telegram initData' };
  if (!BOT_TOKEN) return { ok: false, reason: 'BOT_TOKEN is missing' };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'Missing hash' };
    params.delete('hash');

    const checkString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(calc, 'hex');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid Telegram signature' };
    }

    const authDate = Number(params.get('auth_date'));
    if (!authDate) return { ok: false, reason: 'Missing auth_date' };
    if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'Telegram initData expired' };

    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return { ok: false, reason: 'Invalid Telegram user' };

    return { ok: true, user };
  } catch (error) {
    console.error('initData verification error:', error);
    return { ok: false, reason: 'Invalid initData' };
  }
}

// =========================================================
// VPN / MULTI-ACCOUNT DETECTION
// =========================================================

async function detectVPNProxy(ip) {
  const result = { vpn: false, proxy: false, tor: false, detected: false };
  if (!ip) return result;

  const clean = String(ip).replace(/^::ffff:/, '').trim();

  if (
    clean === '127.0.0.1' || clean === '::1' ||
    clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('172.16.')
  ) return result;

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return result;

    const data = await response.json();
    if (!data || data.success === false) return result;

    const sec = data.security || {};
    result.vpn = sec.vpn === true;
    result.proxy = sec.proxy === true;
    result.tor = sec.tor === true;
    result.detected = result.vpn || result.proxy || result.tor;
    return result;
  } catch (error) {
    console.error('VPN detection error:', error.message);
    return result;
  }
}

async function detectMultiAccount(telegramId, ipHash, deviceHash) {
  if (deviceHash) {
    const d = await pool.query(
      `SELECT 1 FROM fraud_users WHERE device_hash = $1 AND telegram_id <> $2 LIMIT 1`,
      [deviceHash, telegramId]
    );
    if (d.rows.length) {
      return { detected: true, reason: 'Multiple Telegram accounts detected on the same device.' };
    }
  }

  if (ipHash && deviceHash) {
    const i = await pool.query(
      `SELECT device_hash FROM fraud_users
       WHERE ip_hash = $1 AND telegram_id <> $2 AND status = 'verified' LIMIT 1`,
      [ipHash, telegramId]
    );
    if (i.rows.length && i.rows[0].device_hash && i.rows[0].device_hash !== deviceHash) {
      return { detected: true, reason: 'Multiple Telegram accounts detected from the same IP address.' };
    }
  }

  return { detected: false, reason: '' };
}

async function saveUser(u, { status, reason = '', vpn = false, proxy = false, risk = 0 }) {
  await pool.query(
    `INSERT INTO fraud_users
       (telegram_id, username, first_name, ip_hash, device_hash, vpn_detected, proxy_detected,
        risk_score, status, ban_reason, last_seen, request_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),1)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       ip_hash = EXCLUDED.ip_hash,
       device_hash = EXCLUDED.device_hash,
       vpn_detected = EXCLUDED.vpn_detected,
       proxy_detected = EXCLUDED.proxy_detected,
       risk_score = EXCLUDED.risk_score,
       status = EXCLUDED.status,
       ban_reason = EXCLUDED.ban_reason,
       last_seen = NOW(),
       request_count = fraud_users.request_count + 1`,
    [u.id, u.username, u.first, u.ipHash, u.deviceHash, vpn, proxy, risk, status, reason]
  );
}

async function banAndNotify(u, reason, type, vpn = false, proxy = false) {
  await saveUser(u, { status: 'banned', reason, vpn, proxy, risk: 100 });
  await sendBanMessage(u.id, type);
  await pool.query('UPDATE fraud_users SET ban_message_sent = TRUE WHERE telegram_id = $1', [u.id]);
}

// =========================================================
// CORS
// =========================================================

app.use((req, res, next) => {
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-device');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// =========================================================
// WEBHOOK SETUP + BASIC ROUTES
// =========================================================

let webhookPromise = null;

function setupWebhook() {
  if (webhookPromise) return webhookPromise;

  webhookPromise = telegram('setWebhook', {
    url: WEBHOOK_URL,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  }).catch((error) => {
    webhookPromise = null;
    console.error('setWebhook error:', error.message);
    throw error;
  });

  return webhookPromise;
}

app.get('/', async (req, res) => {
  try { await setupWebhook(); } catch (e) { /* logged above */ }
  res.json({ ok: true, app: 'Adewa Telegram Mini App', status: 'online' });
});

// =========================================================
// REFERRALS
// =========================================================

// Saves "who invited me" when a NEW user opens /start ref_<inviterId>
async function captureReferral(inviteeId, text) {
  const m = String(text || '').match(/^\/start\s+ref_(\d+)\s*$/);
  if (!m || !inviteeId) return;

  const inviterId = Number(m[1]);
  if (inviterId === Number(inviteeId)) return;

  const known = await pool.query('SELECT 1 FROM fraud_users WHERE telegram_id = $1', [inviteeId]);
  if (known.rows.length) return;

  await pool.query(
    `INSERT INTO referrals (invitee_id, inviter_id) VALUES ($1, $2) ON CONFLICT (invitee_id) DO NOTHING`,
    [inviteeId, inviterId]
  );
}

// =========================================================
// TELEGRAM WEBHOOK (messages + admin approve/reject buttons)
// =========================================================

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!chatId) return;

  // ---- /ban <id>  /unban <id>  (admin only) ----
  const cmd = text.match(/^\/(ban|unban)(?:@\w+)?(?:\s+(\S+))?\s*$/i);

  if (cmd) {
    if (!ADMIN_IDS.includes(String(message.from?.id || ''))) return;

    const target = cmd[2] || '';
    if (!/^\d+$/.test(target)) {
      await sendTelegramMessage(chatId, 'Usage:\n/ban 123456789\n/unban 123456789');
      return;
    }

    const found = await setBan(Number(target), cmd[1].toLowerCase() === 'ban');
    await sendTelegramMessage(chatId, found ? `Done: user ${target}.` : `User ${target} not found.`);
    return;
  }

  // ---- /start ----
  if (text === '/start' || text.startsWith('/start ')) {
    const userId = message.from?.id;

    await captureReferral(userId, text).catch((e) => console.error('REFERRAL ERROR:', e));

    if (userId) {
      const b = await pool.query(
        `SELECT status, ban_reason FROM fraud_users WHERE telegram_id = $1 LIMIT 1`,
        [userId]
      );
      if (b.rows.length && b.rows[0].status === 'banned') {
        await sendBanMessage(chatId, getBanType(b.rows[0].ban_reason));
        return;
      }
    }

    await telegram('sendMessage', {
      chat_id: chatId,
      text: `👋 Hello ${message.from?.first_name || 'friend'}!\n\nWelcome to the Adewa Mini App.`,
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Open Adewa', web_app: { url: MINI_APP_URL } }]]
      }
    });
  }
}

async function handleCallback(cb) {
  const answer = (text, alert = false) =>
    telegram('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});

  const m = /^wd:(approve|reject):(\d+)$/.exec(cb.data || '');
  if (!m) return answer();

  if (!ADMIN_IDS.includes(String(cb.from?.id))) return answer('Not allowed.', true);

  await answer('Working...');

  const r = await decideWithdrawal(Number(m[2]), m[1]);

  if (cb.message) {
    await telegram('editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: `${cb.message.text}\n\n${r.ok ? '✅' : '⚠️'} ${r.message}`
    }).catch(() => {});
  }
}

app.post('/telegram/webhook', async (req, res) => {
  try {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }

    await initDatabase();

    const update = req.body || {};

    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (error) {
    console.error('Webhook error:', error);
  }

  res.sendStatus(200);
});

// =========================================================
// AUTH (security check: VPN / multi-account)
// =========================================================

app.post('/api/auth', async (req, res) => {
  try {
    await initDatabase();

    const v = verifyInitData(req.headers['x-init-data']);

    if (!v.ok) {
      return res.status(401).json({ ok: false, status: 'invalid', message: v.reason });
    }

    const deviceId = String(req.headers['x-device'] || '').trim();

    const u = {
      id: Number(v.user.id),
      username: v.user.username || '',
      first: v.user.first_name || '',
      ipHash: sha256(getClientIP(req)),
      deviceHash: deviceId ? sha256(deviceId) : ''
    };

    const existing = await pool.query('SELECT * FROM fraud_users WHERE telegram_id = $1 LIMIT 1', [u.id]);
    const row = existing.rows[0];

    // ---- already banned ----
    if (row && row.status === 'banned') {
      if (!row.ban_message_sent) {
        await sendBanMessage(u.id, getBanType(row.ban_reason));
        await pool.query('UPDATE fraud_users SET ban_message_sent = TRUE WHERE telegram_id = $1', [u.id]);
      }
      return res.status(403).json({
        ok: false,
        status: 'banned',
        reason: row.ban_reason,
        message: 'Your account has been permanently banned.'
      });
    }

    // ---- checks (skipped for whitelisted users and admins) ----
    const skip = (row && row.whitelisted === true) || ADMIN_IDS.includes(String(u.id));

    const net = skip ? { detected: false } : await detectVPNProxy(getClientIP(req));
    const multi = skip ? { detected: false } : await detectMultiAccount(u.id, u.ipHash, u.deviceHash);

    if (net.detected) {
      const reason = net.vpn ? 'VPN detected' : net.proxy ? 'Proxy detected' : 'Tor detected';
      await banAndNotify(u, reason, 'vpn', net.vpn || net.tor, net.proxy);
      return res.status(403).json({ ok: false, status: 'banned', reason, message: 'VPN/Proxy detected.' });
    }

    if (multi.detected) {
      await banAndNotify(u, multi.reason, 'multi');
      return res.status(403).json({ ok: false, status: 'banned', reason: multi.reason, message: 'Multiple accounts detected.' });
    }

    // ---- verified ----
    await saveUser(u, { status: 'verified' });

    const sent = await pool.query(
      'SELECT verification_message_sent FROM fraud_users WHERE telegram_id = $1',
      [u.id]
    );

    if (!sent.rows[0]?.verification_message_sent) {
      const ok = await sendTelegramMessage(u.id, '✅ Verification completed successfully.');
      if (ok) {
        await pool.query(
          'UPDATE fraud_users SET verification_message_sent = TRUE WHERE telegram_id = $1',
          [u.id]
        );
      }
    }

    return res.json({ ok: true, status: 'verified', message: 'Verified.' });
  } catch (error) {
    console.error('AUTH ERROR:', error);
    return res.status(500).json({ ok: false, status: 'error', message: 'Verification server error.' });
  }
});

// =========================================================
// ROUTE HELPERS (auth + error handling)
// =========================================================

// Verifies Telegram initData AND that the user passed /api/auth
async function requireUser(req, res) {
  const v = verifyInitData(req.headers['x-init-data']);

  if (!v.ok) {
    res.status(401).json({ ok: false, status: 'invalid', message: v.reason });
    return null;
  }

  const id = Number(v.user.id);
  const r = await pool.query('SELECT status FROM fraud_users WHERE telegram_id = $1 LIMIT 1', [id]);
  const status = r.rows[0]?.status;

  if (status === 'banned') {
    res.status(403).json({ ok: false, status: 'banned', message: 'Your account has been permanently banned.' });
    return null;
  }

  if (status !== 'verified') {
    res.status(403).json({ ok: false, status: 'not_verified', message: 'Please complete verification first.' });
    return null;
  }

  return id;
}

async function requireAdmin(req, res) {
  const id = await requireUser(req, res);
  if (!id) return null;

  if (!ADMIN_IDS.includes(String(id))) {
    res.status(403).json({ ok: false, message: 'Not allowed.' });
    return null;
  }

  return id;
}

function route(path, handler, admin = false) {
  app.post(path, async (req, res) => {
    try {
      await initDatabase();
      const id = admin ? await requireAdmin(req, res) : await requireUser(req, res);
      if (!id) return;
      await handler(id, req, res);
    } catch (error) {
      console.error(path, error);
      if (!res.headersSent) res.status(500).json({ ok: false, message: 'Server error.' });
    }
  });
}

// =========================================================
// EARNING
// =========================================================

const ADDIS_TODAY = `(NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date`;

async function getEarnState(telegramId, st) {
  await pool.query(
    'INSERT INTO user_balance (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
    [telegramId]
  );

  const r = await pool.query(
    `SELECT coins, ads_coins, invite_coins, task_coins, total_ads,
       CASE WHEN ads_day = ${ADDIS_TODAY} THEN ads_today ELSE 0 END AS ads_today,
       GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
         last_ad_at + ($2::int * INTERVAL '1 second') - NOW()
       ))))::int AS cooldown_left
     FROM user_balance WHERE telegram_id = $1`,
    [telegramId, st.ad_cooldown_seconds]
  );

  const x = r.rows[0];

  return {
    coins: Number(x.coins),
    ads_coins: Number(x.ads_coins),
    invite_coins: Number(x.invite_coins),
    task_coins: Number(x.task_coins),
    total_ads: Number(x.total_ads),
    ads_today: Number(x.ads_today),
    daily_ad_limit: st.daily_ad_limit,
    coins_per_ad: st.coins_per_ad,
    cooldown_left: Number(x.cooldown_left || 0)
  };
}

route('/api/me', async (id, req, res) => {
  const st = await getSettings();
  const state = await getEarnState(id, st);

  res.json({
    ok: true,
    state,
    coins_per_usdt: st.coins_per_usdt,
    is_admin: ADMIN_IDS.includes(String(id))
  });
});

route('/api/ads/start', async (id, req, res) => {
  const st = await getSettings();
  const state = await getEarnState(id, st);

  if (state.ads_today >= st.daily_ad_limit) {
    return res.status(429).json({ ok: false, code: 'daily_limit', message: 'Daily ad limit reached. Come back tomorrow.', state });
  }

  if (state.cooldown_left > 0) {
    return res.status(429).json({ ok: false, code: 'cooldown', message: `Please wait ${state.cooldown_left}s.`, state });
  }

  const token = crypto.randomBytes(16).toString('hex');

  await pool.query('INSERT INTO ad_sessions (token, telegram_id) VALUES ($1, $2)', [token, id]);

  res.json({ ok: true, token });
});

route('/api/ads/claim', async (id, req, res) => {
  const token = String(req.body?.token || '');
  const provider = ['adsgram', 'monetag'].includes(req.body?.provider) ? req.body.provider : '';

  if (!token || !provider) {
    return res.status(400).json({ ok: false, message: 'Invalid request.' });
  }

  const st = await getSettings();
  const client = await pool.connect();
  let inviter = null;

  try {
    await client.query('BEGIN');

    const fail = async (status, message, code) => {
      await client.query('ROLLBACK');
      return res.status(status).json({ ok: false, code, message });
    };

    // Lock the ad session (one-time use)
    const s = await client.query(
      `SELECT used, EXTRACT(EPOCH FROM (NOW() - created_at)) AS age
       FROM ad_sessions WHERE token = $1 AND telegram_id = $2 FOR UPDATE`,
      [token, id]
    );

    if (!s.rows.length) return fail(400, 'Ad session not found.');
    if (s.rows[0].used) return fail(400, 'Reward already claimed.');

    const age = Number(s.rows[0].age);
    if (age < st.min_ad_seconds) return fail(400, 'Ad was not watched completely.');
    if (age > 600) return fail(400, 'Ad session expired.');

    // Lock the balance row, re-check limit + cooldown
    await client.query(
      'INSERT INTO user_balance (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
      [id]
    );

    const b = await client.query(
      `SELECT CASE WHEN ads_day = ${ADDIS_TODAY} THEN ads_today ELSE 0 END AS ads_today,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - last_ad_at)), 999999) AS since_last
       FROM user_balance WHERE telegram_id = $1 FOR UPDATE`,
      [id]
    );

    const adsToday = Number(b.rows[0].ads_today);

    if (adsToday >= st.daily_ad_limit) return fail(429, 'Daily ad limit reached.', 'daily_limit');
    if (Number(b.rows[0].since_last) < st.ad_cooldown_seconds) return fail(429, 'Please wait before the next ad.', 'cooldown');

    // Pay
    await client.query('UPDATE ad_sessions SET used = TRUE, provider = $2 WHERE token = $1', [token, provider]);

    await client.query(
      `UPDATE user_balance SET
         coins = coins + $2, ads_coins = ads_coins + $2,
         total_ads = total_ads + 1, ads_today = $3,
         ads_day = ${ADDIS_TODAY}, last_ad_at = NOW()
       WHERE telegram_id = $1`,
      [id, st.coins_per_ad, adsToday + 1]
    );

    // Invite bonus: paid once, when the invited user completes a first ad
    const ref = await client.query(
      `UPDATE referrals SET rewarded = TRUE
       WHERE invitee_id = $1 AND rewarded = FALSE RETURNING inviter_id`,
      [id]
    );

    if (ref.rows.length) {
      inviter = ref.rows[0].inviter_id;

      await client.query(
        `INSERT INTO user_balance (telegram_id, coins, invite_coins)
         VALUES ($1, $2::bigint, $2::bigint)
         ON CONFLICT (telegram_id) DO UPDATE SET
           coins = user_balance.coins + $2::bigint,
           invite_coins = user_balance.invite_coins + $2::bigint`,
        [inviter, Math.floor(st.invite_bonus)]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (res.headersSent) return; // a validation failure already answered

  if (inviter) {
    sendTelegramMessage(inviter, `🎉 Your friend joined! +${Math.floor(st.invite_bonus)} coins added.`);
  }

  const state = await getEarnState(id, st);
  res.json({ ok: true, reward: st.coins_per_ad, state });
});

// =========================================================
// INVITE
// =========================================================

route('/api/invite', async (id, req, res) => {
  const bot = await getBotUsername();
  const st = await getSettings();

  const r = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE rewarded)::int AS done
     FROM referrals WHERE inviter_id = $1`,
    [id]
  );

  res.json({
    ok: true,
    link: `https://t.me/${bot}?start=ref_${id}`,
    total: r.rows[0].total,
    done: r.rows[0].done,
    reward: Math.floor(st.invite_bonus)
  });
});

// =========================================================
// WALLET + WITHDRAW REQUEST (USDT BEP20)
// =========================================================

route('/api/wallet', async (id, req, res) => {
  const st = await getSettings();
  const state = await getEarnState(id, st);

  const hist = await pool.query(
    `SELECT id, net, status, tx_hash FROM payouts
     WHERE telegram_id = $1 ORDER BY id DESC LIMIT 10`,
    [id]
  );

  res.json({
    ok: true,
    coins: state.coins,
    usdt: coinsToMicro(state.coins, st.coins_per_usdt) / 1e6,
    min: st.min_withdraw_usdt,
    fee: st.withdraw_fee_usdt,
    explorer: EXPLORER_TX,
    history: hist.rows.map((r) => ({ ...r, net: Number(r.net) }))
  });
});

async function notifyAdmins(w) {
  const name = await userName(w.telegram_id);

  const text =
    `💸 New withdrawal #${w.id}\n\n` +
    `👤 ${name} (${w.telegram_id})\n` +
    `💵 ${fmt(w.usdt)} USDT - ${fmt(w.fee)} fee = ${fmt(w.net)} USDT\n` +
    `📦 ${w.address}`;

  const kb = {
    inline_keyboard: [[
      { text: '✅ Approve & Pay', callback_data: `wd:approve:${w.id}` },
      { text: '❌ Reject', callback_data: `wd:reject:${w.id}` }
    ]]
  };

  await Promise.all(ADMIN_IDS.map((a) => sendTelegramMessage(a, text, { reply_markup: kb })));
}

route('/api/withdraw', async (id, req, res) => {
  const address = String(req.body?.address || '').trim();

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ ok: false, message: 'Invalid BEP20 address.' });
  }

  const st = await getSettings();
  const feeMicro = Math.round(st.withdraw_fee_usdt * 1e6);
  const minMicro = Math.round(st.min_withdraw_usdt * 1e6);

  const client = await pool.connect();
  let created = null;

  try {
    await client.query('BEGIN');

    await client.query(
      'INSERT INTO user_balance (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
      [id]
    );

    const bal = await client.query(
      'SELECT coins FROM user_balance WHERE telegram_id = $1 FOR UPDATE',
      [id]
    );

    const open = await client.query(
      `SELECT 1 FROM payouts WHERE telegram_id = $1 AND status IN ('pending','processing') LIMIT 1`,
      [id]
    );

    if (open.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: 'You already have a pending withdrawal.' });
    }

    const grossMicro = coinsToMicro(bal.rows[0].coins, st.coins_per_usdt);

    if (grossMicro < Math.max(minMicro, feeMicro + 1)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        message: `Minimum withdrawal is ${fmt(Math.max(st.min_withdraw_usdt, st.withdraw_fee_usdt))} USDT.`
      });
    }

    const coinsUsed = Math.ceil((grossMicro * st.coins_per_usdt) / 1e6);

    await client.query('UPDATE user_balance SET coins = coins - $2 WHERE telegram_id = $1', [id, coinsUsed]);

    const ins = await client.query(
      `INSERT INTO payouts (telegram_id, address, coins, usdt, fee, net)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, ethers.getAddress(address), coinsUsed, microToStr(grossMicro), microToStr(feeMicro), microToStr(grossMicro - feeMicro)]
    );

    created = ins.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  notifyAdmins(created).catch((e) => console.error('notifyAdmins error:', e));

  res.json({ ok: true, net: Number(created.net) });
});

// =========================================================
// PAYOUT ENGINE
// =========================================================

const getProvider = () => new ethers.JsonRpcProvider(BSC_RPC, 56, { staticNetwork: true });

// 'success' | 'failed' | 'pending' (not confirmed yet)
async function txOutcome(hash, tx) {
  try {
    const receipt = tx ? await tx.wait(1, 20000) : await getProvider().getTransactionReceipt(hash);
    if (!receipt) return 'pending';
    return receipt.status === 1 ? 'success' : 'failed';
  } catch (e) {
    return e.code === 'CALL_EXCEPTION' ? 'failed' : 'pending';
  }
}

async function postProof(w) {
  if (!PROOF_CHAT_ID) return;

  const text =
    `⚡ Withdrawal Successful!\n\n` +
    `👤 User: ${await userName(w.telegram_id)}\n` +
    `💵 Amount: $${fmt(w.net)} USDT (after $${fmt(w.fee)} fee)\n` +
    `🪙 Gateway: USDT BEP20\n` +
    `📦 Address: ${w.address}`;

  await sendTelegramMessage(PROOF_CHAT_ID, text, {
    reply_markup: { inline_keyboard: [[{ text: 'View Transaction', url: EXPLORER_TX + w.tx_hash }]] }
  });
}

// Closes a 'processing' payout. Safe to call twice (only one call wins).
async function finishPayout(wid, outcome, hash) {
  if (outcome === 'pending') {
    return { ok: true, status: 'processing', tx: hash, message: 'Sent, waiting for confirmation. Use Re-check in a minute.' };
  }

  const status = outcome === 'success' ? 'paid' : 'failed';

  const r = await pool.query(
    `UPDATE payouts SET status = $2, tx_hash = $3, error = $4, decided_at = NOW()
     WHERE id = $1 AND status = 'processing' RETURNING *`,
    [wid, status, hash, status === 'failed' ? 'Transaction reverted' : '']
  );

  if (!r.rows.length) return { ok: false, message: 'Already handled.' };

  const w = r.rows[0];

  if (status === 'paid') {
    await sendTelegramMessage(w.telegram_id, `✅ ${fmt(w.net)} USDT was sent to your wallet.\n\n${EXPLORER_TX}${hash}`);
    await postProof(w);
    return { ok: true, status, tx: hash, message: `Paid. ${EXPLORER_TX}${hash}` };
  }

  await pool.query('UPDATE user_balance SET coins = coins + $2 WHERE telegram_id = $1', [w.telegram_id, w.coins]);
  await sendTelegramMessage(w.telegram_id, '❌ Your withdrawal failed on-chain. Your balance has been refunded.');
  return { ok: true, status, message: 'Transaction failed. User refunded.' };
}

// action: 'approve' | 'reject' | 'recheck'
async function decideWithdrawal(wid, action) {
  if (!Number.isInteger(wid)) return { ok: false, message: 'Invalid request.' };

  // ---------- reject ----------
  if (action === 'reject') {
    const r = await pool.query(
      `UPDATE payouts SET status = 'rejected', decided_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING telegram_id, coins, usdt`,
      [wid]
    );

    if (!r.rows.length) return { ok: false, message: 'Not found or already handled.' };

    await pool.query('UPDATE user_balance SET coins = coins + $2 WHERE telegram_id = $1', [r.rows[0].telegram_id, r.rows[0].coins]);
    await sendTelegramMessage(r.rows[0].telegram_id, `❌ Your ${fmt(r.rows[0].usdt)} USDT withdrawal was rejected. Your balance has been refunded.`);
    return { ok: true, message: 'Rejected and refunded.' };
  }

  // ---------- re-check a broadcast but unconfirmed payout ----------
  if (action === 'recheck') {
    const r = await pool.query(
      `SELECT tx_hash FROM payouts WHERE id = $1 AND status = 'processing' AND tx_hash <> ''`,
      [wid]
    );
    if (!r.rows.length) return { ok: false, message: 'Nothing to re-check.' };
    return finishPayout(wid, await txOutcome(r.rows[0].tx_hash), r.rows[0].tx_hash);
  }

  // ---------- approve = pay automatically ----------
  // Lock the row first so it can never be paid twice. Only one payout at a time
  // (keeps the wallet nonce clean).
  const c = await pool.query(
    `UPDATE payouts SET status = 'processing', error = ''
     WHERE id = $1 AND status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM payouts WHERE status = 'processing')
     RETURNING *`,
    [wid]
  );

  if (!c.rows.length) {
    return { ok: false, message: 'Not found, already handled, or another payout is still processing.' };
  }

  const w = c.rows[0];
  let hash = '';

  try {
    if (!PAYOUT_PRIVATE_KEY) throw new Error('PAYOUT_PRIVATE_KEY is not set');

    const wallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, getProvider());
    const token = new ethers.Contract(USDT_BSC, ERC20_ABI, wallet);
    const value = ethers.parseUnits(String(w.net), 18);

    if ((await token.balanceOf(wallet.address)) < value) {
      throw new Error('Payout wallet USDT balance is too low');
    }

    const tx = await token.transfer(w.address, value);

    // Save the hash IMMEDIATELY so we can never lose track of a sent payment
    hash = tx.hash;
    await pool.query('UPDATE payouts SET tx_hash = $2 WHERE id = $1', [wid, hash]);

    return await finishPayout(wid, await txOutcome(hash, tx), hash);
  } catch (error) {
    if (hash) {
      // Already broadcast: never go back to pending (would risk paying twice)
      console.error('PAYOUT POST-BROADCAST ERROR:', error);
      return { ok: true, status: 'processing', tx: hash, message: 'Sent, waiting for confirmation. Use Re-check in a minute.' };
    }

    // Nothing was sent -> back to pending so the admin can retry
    const msg = String(error.shortMessage || error.message || 'error').slice(0, 200);
    await pool.query(`UPDATE payouts SET status = 'pending', error = $2 WHERE id = $1`, [wid, msg]);
    console.error('PAYOUT ERROR:', error);
    return { ok: false, message: `Payment failed: ${msg}` };
  }
}

// =========================================================
// ADMIN API
// =========================================================

route('/api/admin/overview', async (id, req, res) => {
  const u = await pool.query(
    `SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE status = 'banned')::int AS banned FROM fraud_users`
  );
  const paid = await pool.query(`SELECT COALESCE(SUM(net),0) AS s FROM payouts WHERE status = 'paid'`);
  const coins = await pool.query('SELECT COALESCE(SUM(coins),0)::bigint AS c FROM user_balance');
  const list = await pool.query(
    `SELECT p.id, p.telegram_id, p.address, p.usdt, p.fee, p.net, p.status, p.tx_hash, p.error,
            COALESCE(NULLIF(f.username,''), NULLIF(f.first_name,''), '') AS name
     FROM payouts p LEFT JOIN fraud_users f ON f.telegram_id = p.telegram_id
     WHERE p.status IN ('pending','processing')
     ORDER BY p.id ASC LIMIT 50`
  );

  let wallet = null;

  try {
    if (PAYOUT_PRIVATE_KEY) {
      const w = new ethers.Wallet(PAYOUT_PRIVATE_KEY, getProvider());
      const token = new ethers.Contract(USDT_BSC, ERC20_ABI, w);
      const [usdt, bnb] = await Promise.all([token.balanceOf(w.address), w.provider.getBalance(w.address)]);
      wallet = {
        address: w.address,
        usdt: Number(ethers.formatUnits(usdt, 18)),
        bnb: Number(ethers.formatUnits(bnb, 18))
      };
    }
  } catch (e) {
    console.error('wallet balance error:', e.message);
  }

  res.json({
    ok: true,
    users: u.rows[0].users,
    banned: u.rows[0].banned,
    coins: Number(coins.rows[0].c),
    paid_total: Number(paid.rows[0].s),
    wallet,
    settings: await getSettings(),
    requests: list.rows.map((r) => ({ ...r, usdt: Number(r.usdt), fee: Number(r.fee), net: Number(r.net) }))
  });
}, true);

route('/api/admin/settings', async (id, req, res) => {
  const key = String(req.body?.key || '');
  const value = Number(req.body?.value);

  if (!(key in DEFAULTS) || !Number.isFinite(value) || value < 0 || (key === 'coins_per_usdt' && value < 1)) {
    return res.status(400).json({ ok: false, message: 'Invalid value.' });
  }

  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );

  res.json({ ok: true });
}, true);

route('/api/admin/decide', async (id, req, res) => {
  const action = String(req.body?.action || '');

  if (!['approve', 'reject', 'recheck'].includes(action)) {
    return res.status(400).json({ ok: false, message: 'Invalid request.' });
  }

  res.json(await decideWithdrawal(Number(req.body?.id), action));
}, true);

async function setBan(targetId, ban) {
  if (ban) {
    await pool.query(
      `INSERT INTO fraud_users (telegram_id, status, ban_reason, last_seen)
       VALUES ($1, 'banned', 'Admin ban', NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET
         status = 'banned', ban_reason = 'Admin ban', whitelisted = FALSE, last_seen = NOW()`,
      [targetId]
    );
    return true;
  }

  const r = await pool.query(
    `UPDATE fraud_users SET status = 'verified', ban_reason = '', vpn_detected = FALSE,
       proxy_detected = FALSE, risk_score = 0, ban_message_sent = FALSE, whitelisted = TRUE, last_seen = NOW()
     WHERE telegram_id = $1`,
    [targetId]
  );
  return r.rowCount > 0;
}

route('/api/admin/ban', async (id, req, res) => {
  const target = Number(req.body?.id);

  if (!Number.isInteger(target) || !['ban', 'unban'].includes(req.body?.action)) {
    return res.status(400).json({ ok: false, message: 'Invalid request.' });
  }

  const found = await setBan(target, req.body.action === 'ban');
  res.json({ ok: found, message: found ? 'Done.' : 'User not found.' });
}, true);

// =========================================================
// LOCAL SERVER / VERCEL
// =========================================================

if (require.main === module) {
  initDatabase()
    .then(() => setupWebhook())
    .then(() => {
      app.listen(env.PORT || 3000, () => console.log('Adewa server running'));
    })
    .catch((error) => {
      console.error('Startup error:', error);
      process.exit(1);
    });
}

if (env.VERCEL || env.VERCEL_ENV) {
  setupWebhook().catch(() => {});
}

module.exports = app;
