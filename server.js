'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

app.use(express.json({ limit: '2mb' }));

// =========================================================
// CONFIG
// =========================================================

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || 'adewa_webhook_secret';

// Telegram user ID(s) of the admin(s) allowed to use /ban and /unban.
// Set ADMIN_ID in Vercel env vars (several IDs separated by commas).
const ADMIN_IDS =
  String(process.env.ADMIN_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

const MINI_APP_URL =
  'https://abdulselamahemade608-prog.github.io/Adewa/';

const WEBHOOK_URL =
  'https://backend-rho-tan-62.vercel.app/telegram/webhook';

const TELEGRAM_API =
  `https://api.telegram.org/bot${BOT_TOKEN}`;


// =========================================================
// BASIC CHECK
// =========================================================

if (!BOT_TOKEN) {
  console.warn('WARNING: BOT_TOKEN is not configured.');
}

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not configured.');
}


// =========================================================
// POSTGRES
// =========================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// =========================================================
// DATABASE INITIALIZATION
// =========================================================

let databaseReady = null;

function initDatabase() {

  if (databaseReady) {
    return databaseReady;
  }

  databaseReady = (async () => {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fraud_users (
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

        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      ALTER TABLE fraud_users
      ADD COLUMN IF NOT EXISTS verification_message_sent
      BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
      ALTER TABLE fraud_users
      ADD COLUMN IF NOT EXISTS ban_message_sent
      BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
      ALTER TABLE fraud_users
      ADD COLUMN IF NOT EXISTS whitelisted
      BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // -------------------------------------------------------
    // EARNING SYSTEM TABLES (balance + watch ads)
    // -------------------------------------------------------

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_balance (
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
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ad_sessions (
        token TEXT PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('coins_per_ad', '20'),
        ('daily_ad_limit', '20'),
        ('ad_cooldown_seconds', '15'),
        ('min_ad_seconds', '5')
      ON CONFLICT (key) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        invitee_id BIGINT PRIMARY KEY,
        inviter_id BIGINT NOT NULL,
        rewarded BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        method TEXT NOT NULL,
        account TEXT NOT NULL,
        holder_name TEXT NOT NULL DEFAULT '',
        amount_birr INTEGER NOT NULL,
        coins BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

    await pool.query(`ALTER TABLE user_balance ADD COLUMN IF NOT EXISTS referred_by BIGINT`);
    await pool.query(`ALTER TABLE user_balance ADD COLUMN IF NOT EXISTS ref_paid BOOLEAN NOT NULL DEFAULT FALSE`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        address TEXT NOT NULL,
        coins BIGINT NOT NULL,
        usdt NUMERIC(18,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_hash TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('coins_per_usdt', '10000'),
        ('min_withdraw_usdt', '1'),
        ('invite_bonus', '500')
      ON CONFLICT (key) DO NOTHING
    `);

    console.log('Database initialized.');

  })().catch((error) => {

    databaseReady = null;

    console.error(
      'Database initialization error:',
      error
    );

    throw error;
  });

  return databaseReady;
}


// =========================================================
// TELEGRAM API
// =========================================================

async function telegram(method, data = {}) {

  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is missing.');
  }

  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      `Telegram API error: ${JSON.stringify(result)}`
    );
  }

  return result;
}


// =========================================================
// SEND TELEGRAM MESSAGE
// =========================================================

async function sendTelegramMessage(chatId, text) {

  try {

    await telegram(
      'sendMessage',
      {
        chat_id: chatId,
        text
      }
    );

    return true;

  } catch (error) {

    console.error(
      'Telegram sendMessage error:',
      error.message
    );

    return false;
  }
}


// =========================================================
// BAN MESSAGE BY REASON
// =========================================================

async function sendBanMessage(
  chatId,
  reason
) {

  if (reason === 'vpn') {

    return sendTelegramMessage(
      chatId,

      '🚫 ቪፒኤን/ፕሮክሲ ተገኝቷል።\n\n' +
      'አካውንትዎ ከአዴዋ ለዘላለም ታግዷል።'
    );
  }

  if (reason === 'multi') {

    return sendTelegramMessage(
      chatId,

      '🚫 ብዙ አካውንቶች ተገኝተዋል።\n\n' +
      'አካውንትዎ ከአዴዋ ለዘላለም ታግዷል።'
    );
  }

  return sendTelegramMessage(
    chatId,

    '🚫 አካውንትዎ ከአዴዋ ለዘላለም ታግዷል።'
  );
}


// =========================================================
// GET BAN REASON
// =========================================================

function getBanType(banReason) {

  const reason =
    String(banReason || '').toLowerCase();

  if (
    reason.includes('vpn') ||
    reason.includes('proxy') ||
    reason.includes('tor')
  ) {
    return 'vpn';
  }

  if (
    reason.includes('multiple') ||
    reason.includes('multi account')
  ) {
    return 'multi';
  }

  return 'other';
}


// =========================================================
// TELEGRAM INIT DATA VERIFICATION
// =========================================================

function verifyTelegramInitData(initData) {

  if (!initData) {

    return {
      ok: false,
      reason: 'Missing Telegram initData'
    };
  }

  if (!BOT_TOKEN) {

    return {
      ok: false,
      reason: 'BOT_TOKEN is missing'
    };
  }

  try {

    const params =
      new URLSearchParams(initData);

    const hash =
      params.get('hash');

    if (!hash) {

      return {
        ok: false,
        reason: 'Missing hash'
      };
    }

    params.delete('hash');

    const dataCheckString =
      [...params.entries()]
        .sort(([a], [b]) =>
          a.localeCompare(b)
        )
        .map(
          ([key, value]) =>
            `${key}=${value}`
        )
        .join('\n');

    const secretKey =
      crypto
        .createHmac(
          'sha256',
          'WebAppData'
        )
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash =
      crypto
        .createHmac(
          'sha256',
          secretKey
        )
        .update(dataCheckString)
        .digest('hex');

    const receivedBuffer =
      Buffer.from(hash, 'hex');

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        'hex'
      );

    if (
      receivedBuffer.length !==
        calculatedBuffer.length ||
      !crypto.timingSafeEqual(
        receivedBuffer,
        calculatedBuffer
      )
    ) {

      return {
        ok: false,
        reason: 'Invalid Telegram signature'
      };
    }

    const authDate =
      Number(
        params.get('auth_date')
      );

    if (!authDate) {

      return {
        ok: false,
        reason: 'Missing auth_date'
      };
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    if (
      now - authDate > 86400
    ) {

      return {
        ok: false,
        reason:
          'Telegram initData expired'
      };
    }

    const userString =
      params.get('user');

    if (!userString) {

      return {
        ok: false,
        reason:
          'Missing Telegram user'
      };
    }

    const user =
      JSON.parse(userString);

    if (!user.id) {

      return {
        ok: false,
        reason:
          'Invalid Telegram user'
      };
    }

    return {
      ok: true,
      user
    };

  } catch (error) {

    console.error(
      'initData verification error:',
      error
    );

    return {
      ok: false,
      reason:
        'Invalid initData'
    };
  }
}


// =========================================================
// HASH
// =========================================================

function sha256(value) {

  return crypto
    .createHash('sha256')
    .update(
      String(value || '')
    )
    .digest('hex');
}


// =========================================================
// CLIENT IP
// =========================================================

function getClientIP(req) {

  const forwarded =
    req.headers[
      'x-forwarded-for'
    ];

  if (forwarded) {

    return String(forwarded)
      .split(',')[0]
      .trim();
  }

  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    ''
  );
}


// =========================================================
// VPN / PROXY DETECTION
// =========================================================

async function detectVPNProxy(ip) {

  const result = {

    checked: false,

    vpn: false,

    proxy: false,

    tor: false,

    hosting: false,

    detected: false
  };

  if (!ip) {
    return result;
  }

  const cleanIP =
    String(ip)
      .replace(/^::ffff:/, '')
      .trim();

  if (
    cleanIP === '127.0.0.1' ||
    cleanIP === '::1' ||
    cleanIP.startsWith('10.') ||
    cleanIP.startsWith('192.168.') ||
    cleanIP.startsWith('172.16.')
  ) {
    return result;
  }

  try {

    const response =
      await fetch(
        `https://ipwho.is/${encodeURIComponent(
          cleanIP
        )}`,
        {
          method: 'GET',

          headers: {
            'Accept':
              'application/json'
          },

          signal:
            AbortSignal.timeout(5000)
        }
      );

    if (!response.ok) {
      return result;
    }

    const data =
      await response.json();

    if (
      !data ||
      data.success === false
    ) {
      return result;
    }

    result.checked = true;

    const security =
      data.security || {};

    result.vpn =
      security.vpn === true;

    result.proxy =
      security.proxy === true;

    result.tor =
      security.tor === true;

    result.hosting =
      security.hosting === true;

    result.detected =
      result.vpn ||
      result.proxy ||
      result.tor;

    return result;

  } catch (error) {

    console.error(
      'VPN detection error:',
      error.message
    );

    return result;
  }
}


// =========================================================
// MULTI ACCOUNT DETECTION
// =========================================================

async function detectMultiAccount(
  telegramId,
  ipHash,
  deviceHash
) {

  const result = {

    detected: false,

    reason: ''
  };

  if (
    !deviceHash &&
    !ipHash
  ) {
    return result;
  }

  // -------------------------------------------------------
  // SAME DEVICE
  // -------------------------------------------------------

  if (deviceHash) {

    const deviceResult =
      await pool.query(
        `
        SELECT telegram_id
        FROM fraud_users
        WHERE device_hash = $1
          AND telegram_id <> $2
        LIMIT 1
        `,
        [
          deviceHash,
          telegramId
        ]
      );

    if (
      deviceResult.rows.length > 0
    ) {

      return {

        detected: true,

        reason:
          'Multiple Telegram accounts detected on the same device.'
      };
    }
  }

  // -------------------------------------------------------
  // SAME IP + DIFFERENT DEVICE
  // -------------------------------------------------------

  if (ipHash) {

    const ipResult =
      await pool.query(
        `
        SELECT
          telegram_id,
          device_hash
        FROM fraud_users
        WHERE ip_hash = $1
          AND telegram_id <> $2
          AND status = 'verified'
        LIMIT 1
        `,
        [
          ipHash,
          telegramId
        ]
      );

    if (
      ipResult.rows.length > 0
    ) {

      const oldDevice =
        ipResult.rows[0]
          .device_hash;

      if (
        oldDevice &&
        deviceHash &&
        oldDevice !== deviceHash
      ) {

        return {

          detected: true,

          reason:
            'Multiple Telegram accounts detected from the same IP address.'
        };
      }
    }
  }

  return result;
}


// =========================================================
// SUCCESS MESSAGE
// =========================================================

async function sendVerificationSuccess(
  user
) {

  return sendTelegramMessage(

    user.id,

    '✅ ማረጋገጫዎ በተሳካ ሁኔታ ተጠናቋል።'
  );
}


// =========================================================
// CORS
// =========================================================

app.use(
  (req, res, next) => {

    const origin =
      req.headers.origin;

    if (
      origin ===
      'https://abdulselamahemade608-prog.github.io'
    ) {

      res.setHeader(
        'Access-Control-Allow-Origin',
        origin
      );
    }

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-init-data, x-device'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,OPTIONS'
    );

    if (
      req.method === 'OPTIONS'
    ) {

      return res.sendStatus(204);
    }

    next();
  }
);


// =========================================================
// WEBHOOK SETUP
// =========================================================

let webhookPromise = null;

async function setupWebhook() {

  if (webhookPromise) {
    return webhookPromise;
  }

  webhookPromise =
    telegram(
      'setWebhook',
      {
        url: WEBHOOK_URL,

        secret_token:
          WEBHOOK_SECRET,

        allowed_updates:
          ['message'],

        drop_pending_updates:
          false
      }
    )
    .catch((error) => {

      webhookPromise = null;

      console.error(
        'setWebhook error:',
        error.message
      );

      throw error;
    });

  return webhookPromise;
}


// =========================================================
// ROOT
// =========================================================

app.get(
  '/',
  async (req, res) => {

    try {

      await setupWebhook();

    } catch (error) {

      console.error(
        'Webhook setup error:',
        error.message
      );
    }

    res.json({

      ok: true,

      app:
        'Adewa Telegram Mini App',

      status:
        'online'
    });
  }
);


// =========================================================
// WEBHOOK STATUS
// =========================================================

app.get(
  '/api/webhook-status',
  async (req, res) => {

    try {

      const result =
        await telegram(
          'getWebhookInfo'
        );

      res.json(result);

    } catch (error) {

      res.status(500).json({

        ok: false,

        error:
          error.message
      });
    }
  }
);


// =========================================================
// TELEGRAM WEBHOOK
// =========================================================

app.post(
  '/telegram/webhook',
  async (req, res) => {

    try {

      const incomingSecret =
        req.headers[
          'x-telegram-bot-api-secret-token'
        ];

      if (
        incomingSecret !==
        WEBHOOK_SECRET
      ) {

        console.warn(
          'Invalid webhook secret.'
        );

        return res.sendStatus(403);
      }

      const update =
        req.body;

      if (
        !update ||
        !update.message
      ) {

        return res.sendStatus(200);
      }

      const message =
        update.message;

      const chatId =
        message.chat?.id;

      const text =
        typeof message.text ===
        'string'
          ? message.text.trim()
          : '';

      if (!chatId) {
        return res.sendStatus(200);
      }

      // ===================================================
      // /BAN <id>  and  /UNBAN <id>  (admin only)
      // ===================================================

      const adminCommand =
        text.match(/^\/(ban|unban)(?:@\w+)?(?:\s+(\S+))?\s*$/i);

      if (adminCommand) {

        const fromId =
          String(message.from?.id || '');

        // Not an admin -> ignore silently
        if (!ADMIN_IDS.includes(fromId)) {
          return res.sendStatus(200);
        }

        await initDatabase();

        const action =
          adminCommand[1].toLowerCase();

        const targetRaw =
          adminCommand[2] || '';

        if (!/^\d+$/.test(targetRaw)) {

          await sendTelegramMessage(
            chatId,
            'አጠቃቀም፦\n/ban 123456789\n/unban 123456789'
          );

          return res.sendStatus(200);
        }

        const targetId =
          Number(targetRaw);

        if (action === 'ban') {

          await pool.query(
            `
            INSERT INTO fraud_users (
              telegram_id,
              status,
              ban_reason,
              last_seen
            )
            VALUES ($1, 'banned', 'Admin ban', NOW())

            ON CONFLICT (telegram_id)
            DO UPDATE SET
              status = 'banned',
              ban_reason = 'Admin ban',
              whitelisted = FALSE,
              last_seen = NOW()
            `,
            [targetId]
          );

          await sendTelegramMessage(
            chatId,
            `🚫 ተጠቃሚ ${targetId} ታግዷል።`
          );

          return res.sendStatus(200);
        }

        const unbanned =
          await pool.query(
            `
            UPDATE fraud_users
            SET
              status = 'verified',
              ban_reason = '',
              vpn_detected = FALSE,
              proxy_detected = FALSE,
              risk_score = 0,
              ban_message_sent = FALSE,
              whitelisted = TRUE,
              last_seen = NOW()
            WHERE telegram_id = $1
            `,
            [targetId]
          );

        if (unbanned.rowCount === 0) {

          await sendTelegramMessage(
            chatId,
            `ተጠቃሚ ${targetId} አልተገኘም።`
          );

        } else {

          await sendTelegramMessage(
            chatId,
            `✅ ተጠቃሚ ${targetId} ከእገዳ ተነስቷል።`
          );
        }

        return res.sendStatus(200);
      }

      // ===================================================
      // /START
      // ===================================================

      if (
        text === '/start' ||
        text.startsWith('/start ')
      ) {

        // -----------------------------------------------
        // IMPORTANT:
        // Check database BEFORE opening Mini App.
        // -----------------------------------------------

        await initDatabase();

        await captureReferral(message.from?.id, text)

          .catch((e) => console.error('REFERRAL ERROR:', e));

        const userId =
          message.from?.id;

        // -----------------------------------------------
        // If Telegram user already has a ban,
        // send the SAME ban reason.
        // -----------------------------------------------

        if (userId) {

          const bannedUser =
            await pool.query(
              `
              SELECT
                status,
                ban_reason
              FROM fraud_users
              WHERE telegram_id = $1
              LIMIT 1
              `,
              [userId]
            );

          if (
            bannedUser.rows.length > 0 &&
            bannedUser.rows[0].status ===
              'banned'
          ) {

            const banType =
              getBanType(
                bannedUser.rows[0]
                  .ban_reason
              );

            await sendBanMessage(
              chatId,
              banType
            );

            return res.sendStatus(200);
          }
        }

        // -----------------------------------------------
        // Normal user
        // Referral: /start ref_<inviterId> (only for brand-new users)
        const refMatch =
          text.match(/^\/start\s+ref_(\d+)$/i);

        if (refMatch && userId && Number(refMatch[1]) !== Number(userId)) {
          await pool.query(
            `INSERT INTO user_balance (telegram_id, referred_by)
             VALUES ($1, $2)
             ON CONFLICT (telegram_id) DO NOTHING`,
            [userId, Number(refMatch[1])]
          );
        }
        // -----------------------------------------------

        const firstName =
          message.from?.first_name ||
          'ወዳጄ';

        await telegram(
          'sendMessage',
          {

            chat_id:
              chatId,

            text:
              `👋 ሰላም ${firstName}!\n\n` +
              `እንኳን ወደ አዴዋ ሚኒ አፕ በደህና መጡ።`,

            reply_markup: {

              inline_keyboard: [

                [

                  {

                    text:
                      '🚀 አዴዋን ክፈት',

                    web_app: {

                      url:
                        MINI_APP_URL
                    }
                  }

                ]

              ]
            }
          }
        );
      }

      return res.sendStatus(200);

    } catch (error) {

      console.error(
        'Webhook error:',
        error
      );

      return res.sendStatus(200);
    }
  }
);


// =========================================================
// AUTH
// =========================================================

app.post(
  '/api/auth',
  async (req, res) => {

    try {

      await initDatabase();

      const initData =
        req.headers[
          'x-init-data'
        ];

      const deviceId =
        String(
          req.headers[
            'x-device'
          ] || ''
        ).trim();

      // ---------------------------------------------------
      // VERIFY TELEGRAM
      // ---------------------------------------------------

      const verification =
        verifyTelegramInitData(
          initData
        );

      if (!verification.ok) {

        return res.status(401).json({

          ok: false,

          status:
            'invalid',

          message:
            verification.reason
        });
      }

      const user =
        verification.user;

      const telegramId =
        Number(user.id);

      const username =
        user.username || '';

      const firstName =
        user.first_name || '';

      // ---------------------------------------------------
      // IP / DEVICE
      // ---------------------------------------------------

      const ip =
        getClientIP(req);

      const ipHash =
        sha256(ip);

      const deviceHash =
        sha256(deviceId);

      // ---------------------------------------------------
      // EXISTING USER
      // ---------------------------------------------------

      const existing =
        await pool.query(
          `
          SELECT *
          FROM fraud_users
          WHERE telegram_id = $1
          LIMIT 1
          `,
          [telegramId]
        );

      // ===================================================
      // ALREADY BANNED
      // ===================================================

      if (
        existing.rows.length > 0 &&
        existing.rows[0].status ===
          'banned'
      ) {

        const banType =
          getBanType(
            existing.rows[0]
              .ban_reason
          );

        // Send the same reason again
        await sendBanMessage(
          telegramId,
          banType
        );

        return res.status(403).json({

          ok: false,

          status:
            'banned',

          reason:
            existing.rows[0]
              .ban_reason,

          message:
            'Your account has been permanently banned.'
        });
      }

      // ===================================================
      // VPN / PROXY CHECK
      // ===================================================

      const isWhitelisted =
        existing.rows.length > 0 &&
        existing.rows[0].whitelisted === true;

      const networkCheck =
        isWhitelisted
          ? {
              vpn: false,
              proxy: false,
              tor: false,
              detected: false
            }
          : await detectVPNProxy(ip);

      // ===================================================
      // MULTI ACCOUNT CHECK
      // ===================================================

      const multiAccount =
        isWhitelisted
          ? { detected: false, reason: '' }
          : await detectMultiAccount(
              telegramId,
              ipHash,
              deviceHash
            );

      // ===================================================
      // VPN / PROXY BAN
      // ===================================================

      if (
        networkCheck.detected
      ) {

        const reason =
          networkCheck.vpn
            ? 'VPN detected'
            : networkCheck.proxy
              ? 'Proxy detected'
              : networkCheck.tor
                ? 'Tor detected'
                : 'Restricted network detected';

        await pool.query(
          `
          INSERT INTO fraud_users (
            telegram_id,
            username,
            first_name,
            ip_hash,
            device_hash,
            vpn_detected,
            proxy_detected,
            risk_score,
            status,
            ban_reason,
            last_seen,
            request_count
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,'banned',$9,NOW(),1
          )

          ON CONFLICT (telegram_id)
          DO UPDATE SET

            username =
              EXCLUDED.username,

            first_name =
              EXCLUDED.first_name,

            ip_hash =
              EXCLUDED.ip_hash,

            device_hash =
              EXCLUDED.device_hash,

            vpn_detected =
              EXCLUDED.vpn_detected,

            proxy_detected =
              EXCLUDED.proxy_detected,

            risk_score =
              EXCLUDED.risk_score,

            status =
              'banned',

            ban_reason =
              EXCLUDED.ban_reason,

            last_seen =
              NOW(),

            request_count =
              fraud_users.request_count + 1
          `,
          [

            telegramId,

            username,

            firstName,

            ipHash,

            deviceHash,

            networkCheck.vpn ||
              networkCheck.tor,

            networkCheck.proxy,

            100,

            reason
          ]
        );

        // -----------------------------------------------
        // Direct Telegram message
        // -----------------------------------------------

        await sendBanMessage(
          telegramId,
          'vpn'
        );

        return res.status(403).json({

          ok: false,

          status:
            'banned',

          reason,

          message:
            'VPN/Proxy detected. Your account has been permanently banned.'
        });
      }

      // ===================================================
      // MULTI ACCOUNT BAN
      // ===================================================

      if (
        multiAccount.detected
      ) {

        await pool.query(
          `
          INSERT INTO fraud_users (
            telegram_id,
            username,
            first_name,
            ip_hash,
            device_hash,
            vpn_detected,
            proxy_detected,
            risk_score,
            status,
            ban_reason,
            last_seen,
            request_count
          )
          VALUES (
            $1,$2,$3,$4,$5,FALSE,FALSE,$6,'banned',$7,NOW(),1
          )

          ON CONFLICT (telegram_id)
          DO UPDATE SET

            username =
              EXCLUDED.username,

            first_name =
              EXCLUDED.first_name,

            ip_hash =
              EXCLUDED.ip_hash,

            device_hash =
              EXCLUDED.device_hash,

            risk_score =
              EXCLUDED.risk_score,

            status =
              'banned',

            ban_reason =
              EXCLUDED.ban_reason,

            last_seen =
              NOW(),

            request_count =
              fraud_users.request_count + 1
          `,
          [

            telegramId,

            username,

            firstName,

            ipHash,

            deviceHash,

            100,

            multiAccount.reason
          ]
        );

        // -----------------------------------------------
        // Direct Telegram message
        // -----------------------------------------------

        await sendBanMessage(
          telegramId,
          'multi'
        );

        return res.status(403).json({

          ok: false,

          status:
            'banned',

          reason:
            multiAccount.reason,

          message:
            'Multiple accounts detected. Your account has been permanently banned.'
        });
      }

      // ===================================================
      // NORMAL USER
      // ===================================================

      await pool.query(
        `
        INSERT INTO fraud_users (
          telegram_id,
          username,
          first_name,
          ip_hash,
          device_hash,
          vpn_detected,
          proxy_detected,
          risk_score,
          status,
          ban_reason,
          last_seen,
          request_count
        )
        VALUES (
          $1,$2,$3,$4,$5,FALSE,FALSE,0,'verified','',NOW(),1
        )

        ON CONFLICT (telegram_id)
        DO UPDATE SET

          username =
            EXCLUDED.username,

          first_name =
            EXCLUDED.first_name,

          ip_hash =
            EXCLUDED.ip_hash,

          device_hash =
            EXCLUDED.device_hash,

          status =
            'verified',

          last_seen =
            NOW(),

          request_count =
            fraud_users.request_count + 1
        `,
        [

          telegramId,

          username,

          firstName,

          ipHash,

          deviceHash
        ]
      );

      // ===================================================
      // SUCCESS MESSAGE
      // ===================================================

      const current =
        await pool.query(
          `
          SELECT
            verification_message_sent
          FROM fraud_users
          WHERE telegram_id = $1
          `,
          [telegramId]
        );

      const messageAlreadySent =
        current.rows[0]
          ?.verification_message_sent;

      if (
        !messageAlreadySent
      ) {

        await payReferral(telegramId)
          .catch((e) => console.error('REFERRAL PAY ERROR:', e));


        const sent =
          await sendVerificationSuccess(
            user
          );

        if (sent) {

          await pool.query(
            `
            UPDATE fraud_users
            SET
              verification_message_sent = TRUE
            WHERE telegram_id = $1
            `,
            [telegramId]
          );
        }
      }

      return res.json({

        ok: true,

        status:
          'verified',

        message:
          'Your verification is successfully.'
      });

    } catch (error) {

      console.error(
        'AUTH ERROR:',
        error
      );

      return res.status(500).json({

        ok: false,

        status:
          'error',

        message:
          'Verification server error.'
      });
    }
  }
);


// =========================================================
// ADMIN GET USER
// =========================================================

app.get(
  '/api/admin/user/:id',
  async (req, res) => {

    try {

      await initDatabase();

      const id =
        Number(req.params.id);

      if (
        !Number.isFinite(id)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            'Invalid user ID'
        });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM fraud_users
          WHERE telegram_id = $1
          `,
          [id]
        );

      return res.json({

        ok: true,

        user:
          result.rows[0] || null
      });

    } catch (error) {

      console.error(
        'Admin user error:',
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          error.message
      });
    }
  }
);


// =========================================================
// ADMIN BAN
// =========================================================

app.post(
  '/api/admin/ban/:id',
  async (req, res) => {

    try {

      await initDatabase();

      const id =
        Number(req.params.id);

      await pool.query(
        `
        UPDATE fraud_users
        SET
          status = 'banned',
          ban_reason = 'Admin ban',
          whitelisted = FALSE,
          last_seen = NOW()
        WHERE telegram_id = $1
        `,
        [id]
      );

      return res.json({

        ok: true,

        message:
          'User permanently banned.'
      });

    } catch (error) {

      console.error(
        'Admin ban error:',
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          error.message
      });
    }
  }
);


// =========================================================
// ADMIN UNBAN
// =========================================================

app.post(
  '/api/admin/unban/:id',
  async (req, res) => {

    try {

      await initDatabase();

      const id =
        Number(req.params.id);

      await pool.query(
        `
        UPDATE fraud_users
        SET
          status = 'verified',
          ban_reason = '',
          vpn_detected = FALSE,
          proxy_detected = FALSE,
          risk_score = 0,
          ban_message_sent = FALSE,
          whitelisted = TRUE,
          last_seen = NOW()
        WHERE telegram_id = $1
        `,
        [id]
      );

      return res.json({

        ok: true,

        message:
          'User unbanned.'
      });

    } catch (error) {

      console.error(
        'Admin unban error:',
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          error.message
      });
    }
  }
);


// =========================================================
// EARNING: HELPERS
// =========================================================

const ADDIS_TODAY =
  `(NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date`;

async function getSettings() {

  const result =
    await pool.query(
      `SELECT key, value FROM app_settings`
    );

  const settings = {
    coins_per_ad: 20,
    daily_ad_limit: 20,
    ad_cooldown_seconds: 15,
    min_ad_seconds: 5,
    invite_reward: 500,
    coins_per_birr: 100,
    min_withdraw_birr: 50
  };

  for (const row of result.rows) {

    const n = Number(row.value);

    if (Number.isFinite(n)) {
      settings[row.key] = n;
    }
  }

  return settings;
}

// Verifies Telegram initData AND that the user passed /api/auth
async function requireUser(req, res) {

  const verification =
    verifyTelegramInitData(
      req.headers['x-init-data']
    );

  if (!verification.ok) {

    res.status(401).json({
      ok: false,
      status: 'invalid',
      message: verification.reason
    });

    return null;
  }

  const id = Number(verification.user.id);

  const result =
    await pool.query(
      `
      SELECT status
      FROM fraud_users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [id]
    );

  const status =
    result.rows[0]?.status;

  if (status === 'banned') {

    res.status(403).json({
      ok: false,
      status: 'banned',
      message: 'Your account has been permanently banned.'
    });

    return null;
  }

  if (status !== 'verified') {

    res.status(403).json({
      ok: false,
      status: 'not_verified',
      message: 'Please complete verification first.'
    });

    return null;
  }

  return id;
}

async function getEarnState(telegramId, settings) {

  await pool.query(
    `
    INSERT INTO user_balance (telegram_id)
    VALUES ($1)
    ON CONFLICT (telegram_id) DO NOTHING
    `,
    [telegramId]
  );

  const result =
    await pool.query(
      `
      SELECT
        coins,
        ads_coins,
        invite_coins,
        task_coins,
        total_ads,
        CASE
          WHEN ads_day = ${ADDIS_TODAY}
          THEN ads_today
          ELSE 0
        END AS ads_today,
        GREATEST(
          0,
          CEIL(
            EXTRACT(
              EPOCH FROM (
                last_ad_at +
                ($2::int * INTERVAL '1 second') -
                NOW()
              )
            )
          )
        )::int AS cooldown_left
      FROM user_balance
      WHERE telegram_id = $1
      `,
      [
        telegramId,
        settings.ad_cooldown_seconds
      ]
    );

  const row = result.rows[0];

  return {
    coins: Number(row.coins),
    ads_coins: Number(row.ads_coins),
    invite_coins: Number(row.invite_coins),
    task_coins: Number(row.task_coins),
    total_ads: Number(row.total_ads),
    ads_today: Number(row.ads_today),
    daily_ad_limit: settings.daily_ad_limit,
    coins_per_ad: settings.coins_per_ad,
    cooldown_left: Number(row.cooldown_left || 0)
  };
}


// =========================================================
// EARNING: ME (balance + ad status)
// =========================================================

app.post(
  '/api/me',
  async (req, res) => {

    try {

      await initDatabase();

      const telegramId =
        await requireUser(req, res);

      if (!telegramId) {
        return;
      }

      const settings =
        await getSettings();

      const state =
        await getEarnState(
          telegramId,
          settings
        );

      return res.json({
        ok: true,
        state,
        is_admin: ADMIN_IDS.includes(String(telegramId))
      });

    } catch (error) {

      console.error('ME ERROR:', error);

      return res.status(500).json({
        ok: false,
        message: 'Server error.'
      });
    }
  }
);


// =========================================================
// EARNING: WATCH AD - START
// =========================================================

app.post(
  '/api/ads/start',
  async (req, res) => {

    try {

      await initDatabase();

      const telegramId =
        await requireUser(req, res);

      if (!telegramId) {
        return;
      }

      const settings =
        await getSettings();

      const state =
        await getEarnState(
          telegramId,
          settings
        );

      if (
        state.ads_today >=
        settings.daily_ad_limit
      ) {

        return res.status(429).json({
          ok: false,
          code: 'daily_limit',
          message: 'Daily ad limit reached. Come back tomorrow.',
          state
        });
      }

      if (state.cooldown_left > 0) {

        return res.status(429).json({
          ok: false,
          code: 'cooldown',
          message: `Please wait ${state.cooldown_left}s.`,
          state
        });
      }

      const token =
        crypto
          .randomBytes(16)
          .toString('hex');

      await pool.query(
        `
        INSERT INTO ad_sessions (token, telegram_id)
        VALUES ($1, $2)
        `,
        [token, telegramId]
      );

      return res.json({
        ok: true,
        token
      });

    } catch (error) {

      console.error('AD START ERROR:', error);

      return res.status(500).json({
        ok: false,
        message: 'Server error.'
      });
    }
  }
);


// =========================================================
// EARNING: WATCH AD - CLAIM REWARD
// =========================================================

app.post(
  '/api/ads/claim',
  async (req, res) => {

    let client = null;

    try {

      await initDatabase();

      const telegramId =
        await requireUser(req, res);

      if (!telegramId) {
        return;
      }

      const token =
        String(req.body?.token || '');

      const provider =
        ['adsgram', 'monetag'].includes(
          req.body?.provider
        )
          ? req.body.provider
          : '';

      if (!token || !provider) {

        return res.status(400).json({
          ok: false,
          message: 'Invalid request.'
        });
      }

      const settings =
        await getSettings();

      client = await pool.connect();

      await client.query('BEGIN');

      // ---------------------------------------------------
      // Lock the ad session (one-time use)
      // ---------------------------------------------------

      const session =
        await client.query(
          `
          SELECT
            used,
            EXTRACT(
              EPOCH FROM (NOW() - created_at)
            ) AS age_seconds
          FROM ad_sessions
          WHERE token = $1
            AND telegram_id = $2
          FOR UPDATE
          `,
          [token, telegramId]
        );

      if (session.rows.length === 0) {

        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Ad session not found.'
        });
      }

      const age =
        Number(session.rows[0].age_seconds);

      if (session.rows[0].used) {

        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Reward already claimed.'
        });
      }

      if (age < settings.min_ad_seconds) {

        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Ad was not watched completely.'
        });
      }

      if (age > 600) {

        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Ad session expired.'
        });
      }

      // ---------------------------------------------------
      // Lock the balance row, re-check limit + cooldown
      // ---------------------------------------------------

      await client.query(
        `
        INSERT INTO user_balance (telegram_id)
        VALUES ($1)
        ON CONFLICT (telegram_id) DO NOTHING
        `,
        [telegramId]
      );

      const bal =
        await client.query(
          `
          SELECT
            CASE
              WHEN ads_day = ${ADDIS_TODAY}
              THEN ads_today
              ELSE 0
            END AS ads_today,
            COALESCE(
              EXTRACT(
                EPOCH FROM (NOW() - last_ad_at)
              ),
              999999
            ) AS since_last_ad
          FROM user_balance
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      const adsToday =
        Number(bal.rows[0].ads_today);

      const sinceLast =
        Number(bal.rows[0].since_last_ad);

      if (adsToday >= settings.daily_ad_limit) {

        await client.query('ROLLBACK');

        return res.status(429).json({
          ok: false,
          code: 'daily_limit',
          message: 'Daily ad limit reached.'
        });
      }

      if (sinceLast < settings.ad_cooldown_seconds) {

        await client.query('ROLLBACK');

        return res.status(429).json({
          ok: false,
          code: 'cooldown',
          message: 'Please wait before the next ad.'
        });
      }

      // ---------------------------------------------------
      // Pay
      // ---------------------------------------------------

      await client.query(
        `
        UPDATE ad_sessions
        SET used = TRUE,
            provider = $2
        WHERE token = $1
        `,
        [token, provider]
      );

      await client.query(
        `
        UPDATE user_balance
        SET
          coins = coins + $2,
          ads_coins = ads_coins + $2,
          total_ads = total_ads + 1,
          ads_today = $3,
          ads_day = ${ADDIS_TODAY},
          last_ad_at = NOW()
        WHERE telegram_id = $1
        `,
        [
          telegramId,
          settings.coins_per_ad,
          adsToday + 1
        ]
      );

      const rf = await client.query(
        `SELECT referred_by, ref_paid FROM user_balance WHERE telegram_id = $1`,
        [telegramId]
      );

      if (rf.rows[0].referred_by && !rf.rows[0].ref_paid) {

        const bonus = Number(settings.invite_bonus || 500);
        const inviter = rf.rows[0].referred_by;

        await client.query(
          `INSERT INTO user_balance (telegram_id) VALUES ($1)
           ON CONFLICT (telegram_id) DO NOTHING`,
          [inviter]
        );
        await client.query(
          `UPDATE user_balance
           SET coins = coins + $2, invite_coins = invite_coins + $2
           WHERE telegram_id = $1`,
          [inviter, bonus]
        );
        await client.query(
          `UPDATE user_balance SET ref_paid = TRUE WHERE telegram_id = $1`,
          [telegramId]
        );
      }

      await client.query('COMMIT');

      const state =
        await getEarnState(
          telegramId,
          settings
        );

      return res.json({
        ok: true,
        reward: settings.coins_per_ad,
        state
      });

    } catch (error) {

      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }

      console.error('AD CLAIM ERROR:', error);

      return res.status(500).json({
        ok: false,
        message: 'Server error.'
      });

    } finally {

      if (client) {
        client.release();
      }
    }
  }
);


// =========================================================
// INVITE / WALLET / ADMIN PANEL
// =========================================================

let botUsernameCache = null;

async function getBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  const r = await telegram('getMe');
  botUsernameCache = r.result.username;
  return botUsernameCache;
}

// Saves "who invited me" when a NEW user opens /start ref_<inviterId>
async function captureReferral(inviteeId, text) {

  const m =
    String(text || '').match(/^\/start\s+ref_(\d+)\s*$/);

  if (!m || !inviteeId) return;

  const inviterId = Number(m[1]);

  if (inviterId === Number(inviteeId)) return;

  const known =
    await pool.query(
      'SELECT 1 FROM fraud_users WHERE telegram_id = $1',
      [inviteeId]
    );

  if (known.rows.length > 0) return;

  await pool.query(
    `
    INSERT INTO referrals (invitee_id, inviter_id)
    VALUES ($1, $2)
    ON CONFLICT (invitee_id) DO NOTHING
    `,
    [inviteeId, inviterId]
  );
}

// Pays the inviter once, when the invited user passes verification
async function payReferral(inviteeId) {

  const r =
    await pool.query(
      `
      UPDATE referrals
      SET rewarded = TRUE
      WHERE invitee_id = $1 AND rewarded = FALSE
      RETURNING inviter_id
      `,
      [inviteeId]
    );

  if (r.rows.length === 0) return;

  const inviterId = r.rows[0].inviter_id;
  const settings = await getSettings();

  await pool.query(
    `
    INSERT INTO user_balance (telegram_id, coins, invite_coins)
    VALUES ($1, $2::bigint, $2::bigint)
    ON CONFLICT (telegram_id) DO UPDATE SET
      coins = user_balance.coins + $2::bigint,
      invite_coins = user_balance.invite_coins + $2::bigint
    `,
    [inviterId, settings.invite_reward]
  );

  await sendTelegramMessage(
    inviterId,
    `🎉 ጓደኛዎ ተቀላቅሏል! +${settings.invite_reward} ሳንቲም አግኝተዋል።`
  );
}

async function requireAdmin(req, res) {

  const id = await requireUser(req, res);

  if (!id) return null;

  if (!ADMIN_IDS.includes(String(id))) {

    res.status(403).json({
      ok: false,
      message: 'Not allowed.'
    });

    return null;
  }

  return id;
}

function route(path, handler, admin = false) {

  app.post(path, async (req, res) => {

    try {

      await initDatabase();

      const id =
        admin
          ? await requireAdmin(req, res)
          : await requireUser(req, res);

      if (!id) return;

      await handler(id, req, res);

    } catch (error) {

      console.error(path, error);

      res.status(500).json({
        ok: false,
        message: 'Server error.'
      });
    }
  });
}

// ---------------- INVITE ----------------

route('/api/invite', async (id, req, res) => {

  const bot = await getBotUsername();
  const settings = await getSettings();

  const r =
    await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE rewarded)::int AS done
      FROM referrals
      WHERE inviter_id = $1
      `,
      [id]
    );

  res.json({
    ok: true,
    link: `https://t.me/${bot}?start=ref_${id}`,
    total: r.rows[0].total,
    done: r.rows[0].done,
    reward: settings.invite_reward
  });
});

// ---------------- WALLET ----------------

route('/api/wallet', async (id, req, res) => {

  const settings = await getSettings();
  const state = await getEarnState(id, settings);
  const rate = Math.max(1, settings.coins_per_birr);

  const list =
    await pool.query(
      `
      SELECT id, method, account, amount_birr, status
      FROM withdrawals
      WHERE telegram_id = $1
      ORDER BY id DESC
      LIMIT 10
      `,
      [id]
    );

  res.json({
    ok: true,
    coins: state.coins,
    birr: Math.floor(state.coins / rate),
    min_birr: settings.min_withdraw_birr,
    history: list.rows
  });
});

route('/api/withdraw', async (id, req, res) => {

  const method = String(req.body?.method || '');
  const account = String(req.body?.account || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 60);

  const rules = {
    telebirr: /^(09|07)\d{8}$/,
    cbe: /^\d{13}$/
  };

  if (!rules[method] || !rules[method].test(account) || name.length < 3) {

    return res.status(400).json({
      ok: false,
      message: 'የስልክ/አካውንት ቁጥር ወይም ስም ትክክል አይደለም።'
    });
  }

  const settings = await getSettings();
  const rate = Math.max(1, settings.coins_per_birr);

  const client = await pool.connect();

  try {

    await client.query('BEGIN');

    await client.query(
      `
      INSERT INTO user_balance (telegram_id)
      VALUES ($1)
      ON CONFLICT (telegram_id) DO NOTHING
      `,
      [id]
    );

    const bal =
      await client.query(
        'SELECT coins FROM user_balance WHERE telegram_id = $1 FOR UPDATE',
        [id]
      );

    const pending =
      await client.query(
        `
        SELECT 1 FROM withdrawals
        WHERE telegram_id = $1 AND status = 'pending'
        LIMIT 1
        `,
        [id]
      );

    if (pending.rows.length > 0) {

      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        message: 'ያልተጠናቀቀ የማውጫ ጥያቄ አለዎት።'
      });
    }

    const birr = Math.floor(Number(bal.rows[0].coins) / rate);

    if (birr < settings.min_withdraw_birr) {

      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        message: `ዝቅተኛው ማውጫ ${settings.min_withdraw_birr} ብር ነው።`
      });
    }

    const coins = birr * rate;

    await client.query(
      'UPDATE user_balance SET coins = coins - $2 WHERE telegram_id = $1',
      [id, coins]
    );

    await client.query(
      `
      INSERT INTO withdrawals
        (telegram_id, method, account, holder_name, amount_birr, coins)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [id, method, account, name, birr, coins]
    );

    await client.query('COMMIT');

    res.json({ ok: true });

  } catch (error) {

    await client.query('ROLLBACK').catch(() => {});

    throw error;

  } finally {

    client.release();
  }
});

// ---------------- ADMIN ----------------

const EDITABLE_SETTINGS = [
  'coins_per_ad',
  'daily_ad_limit',
  'ad_cooldown_seconds',
  'invite_reward',
  'coins_per_birr',
  'min_withdraw_birr'
];

route('/api/admin/stats', async (id, req, res) => {

  const u =
    await pool.query(
      `
      SELECT
        COUNT(*)::int AS users,
        COUNT(*) FILTER (WHERE status = 'banned')::int AS banned
      FROM fraud_users
      `
    );

  const w =
    await pool.query(
      `SELECT COUNT(*)::int AS pending FROM withdrawals WHERE status = 'pending'`
    );

  const c =
    await pool.query(
      'SELECT COALESCE(SUM(coins), 0)::bigint AS coins FROM user_balance'
    );

  res.json({
    ok: true,
    users: u.rows[0].users,
    banned: u.rows[0].banned,
    pending: w.rows[0].pending,
    coins: Number(c.rows[0].coins),
    settings: await getSettings()
  });
}, true);

route('/api/admin/settings', async (id, req, res) => {

  const key = String(req.body?.key || '');
  const value = Number(req.body?.value);

  if (
    !EDITABLE_SETTINGS.includes(key) ||
    !Number.isFinite(value) ||
    value < 0 ||
    (key === 'coins_per_birr' && value < 1)
  ) {

    return res.status(400).json({
      ok: false,
      message: 'Invalid value.'
    });
  }

  await pool.query(
    `
    INSERT INTO app_settings (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
    [key, String(Math.floor(value))]
  );

  res.json({ ok: true });
}, true);

route('/api/admin/withdrawals', async (id, req, res) => {

  const r =
    await pool.query(
      `
      SELECT
        w.id,
        w.telegram_id,
        w.method,
        w.account,
        w.holder_name,
        w.amount_birr,
        f.username
      FROM withdrawals w
      LEFT JOIN fraud_users f ON f.telegram_id = w.telegram_id
      WHERE w.status = 'pending'
      ORDER BY w.id
      LIMIT 30
      `
    );

  res.json({ ok: true, rows: r.rows });
}, true);

route('/api/admin/withdrawals/resolve', async (id, req, res) => {

  const wid = Number(req.body?.id);
  const action = req.body?.action;

  if (!Number.isInteger(wid) || !['paid', 'rejected'].includes(action)) {

    return res.status(400).json({
      ok: false,
      message: 'Invalid request.'
    });
  }

  const r =
    await pool.query(
      `
      UPDATE withdrawals
      SET status = $2, resolved_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING telegram_id, coins, amount_birr
      `,
      [wid, action]
    );

  if (r.rows.length === 0) {
    return res.json({ ok: false, message: 'አልተገኘም።' });
  }

  const w = r.rows[0];

  if (action === 'rejected') {

    await pool.query(
      'UPDATE user_balance SET coins = coins + $2 WHERE telegram_id = $1',
      [w.telegram_id, w.coins]
    );
  }

  await sendTelegramMessage(
    w.telegram_id,
    action === 'paid'
      ? `✅ የ${w.amount_birr} ብር ክፍያዎ ተከፍሏል።`
      : '❌ የማውጫ ጥያቄዎ ውድቅ ሆኗል፤ ሳንቲምዎ ተመልሷል።'
  );

  res.json({ ok: true });
}, true);


// =========================================================
// WALLET / INVITE / ADMIN PAYOUT (USDT BEP20)
// =========================================================

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

// Sends USDT (BEP20) from the payout wallet. Returns the tx hash.
async function sendUSDT(to, amount) {

  if (!process.env.PAYOUT_PRIVATE_KEY) {
    throw new Error('PAYOUT_PRIVATE_KEY is not set');
  }

  const { ethers } = require('ethers');

  const provider = new ethers.JsonRpcProvider(BSC_RPC, 56);
  const wallet = new ethers.Wallet(process.env.PAYOUT_PRIVATE_KEY, provider);

  const token = new ethers.Contract(
    USDT_BSC,
    [
      'function transfer(address,uint256) returns (bool)',
      'function balanceOf(address) view returns (uint256)'
    ],
    wallet
  );

  const value = ethers.parseUnits(String(amount), 18);

  if ((await token.balanceOf(wallet.address)) < value) {
    throw new Error('Payout wallet USDT balance is too low');
  }

  const tx = await token.transfer(to, value);

  return tx.hash;
}

async function requireAdmin(req, res) {

  const id = await requireUser(req, res);

  if (!id) return null;

  if (!ADMIN_IDS.includes(String(id))) {
    res.status(403).json({ ok: false, message: 'Forbidden' });
    return null;
  }

  return id;
}

// ---------- info for Home / Invite / Wallet tabs ----------

app.post('/api/info', async (req, res) => {

  try {

    await initDatabase();

    const id = await requireUser(req, res);
    if (!id) return;

    const st = await getSettings();

    const inv = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_balance WHERE referred_by = $1`,
      [id]
    );

    const hist = await pool.query(
      `SELECT id, usdt, status, tx_hash, created_at
       FROM withdrawals WHERE telegram_id = $1
       ORDER BY id DESC LIMIT 10`,
      [id]
    );

    return res.json({
      ok: true,
      is_admin: ADMIN_IDS.includes(String(id)),
      invites: inv.rows[0].n,
      invite_bonus: Number(st.invite_bonus || 500),
      ref_link: BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?start=ref_${id}`
        : '',
      rate: Number(st.coins_per_usdt || 10000),
      min_withdraw: Number(st.min_withdraw_usdt || 1),
      withdrawals: hist.rows
    });

  } catch (error) {

    console.error('INFO ERROR:', error);
    return res.status(500).json({ ok: false, message: 'Server error.' });
  }
});

// ---------- user: request withdraw ----------

app.post('/api/withdraw', async (req, res) => {

  let client = null;

  try {

    await initDatabase();

    const id = await requireUser(req, res);
    if (!id) return;

    const address = String(req.body?.address || '').trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({
        ok: false,
        message: 'የBEP20 አድራሻው ትክክል አይደለም።'
      });
    }

    const st = await getSettings();
    const rate = Number(st.coins_per_usdt || 10000);
    const min = Number(st.min_withdraw_usdt || 1);

    client = await pool.connect();
    await client.query('BEGIN');

    const bal = await client.query(
      `SELECT coins FROM user_balance WHERE telegram_id = $1 FOR UPDATE`,
      [id]
    );

    const coins = Number(bal.rows[0]?.coins || 0);
    const usdt = Math.floor((coins * 100) / rate) / 100;

    if (usdt < min) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        message: `ቢያንስ ${min} USDT ሊኖርዎት ይገባል።`
      });
    }

    const open = await client.query(
      `SELECT 1 FROM withdrawals
       WHERE telegram_id = $1 AND status IN ('pending','processing')`,
      [id]
    );

    if (open.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        message: 'አንድ ጥያቄ አስቀድሞ በመጠባበቅ ላይ ነው።'
      });
    }

    const used = Math.ceil(usdt * rate);

    await client.query(
      `UPDATE user_balance SET coins = coins - $2 WHERE telegram_id = $1`,
      [id, used]
    );

    await client.query(
      `INSERT INTO withdrawals (telegram_id, address, coins, usdt)
       VALUES ($1, $2, $3, $4)`,
      [id, address, used, usdt]
    );

    await client.query('COMMIT');

    return res.json({ ok: true, usdt });

  } catch (error) {

    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('WITHDRAW ERROR:', error);
    return res.status(500).json({ ok: false, message: 'Server error.' });

  } finally {

    if (client) client.release();
  }
});

// ---------- admin: stats + pending list ----------

app.post('/api/admin/overview', async (req, res) => {

  try {

    await initDatabase();

    const id = await requireAdmin(req, res);
    if (!id) return;

    const users = await pool.query(`SELECT COUNT(*)::int AS n FROM fraud_users`);
    const banned = await pool.query(
      `SELECT COUNT(*)::int AS n FROM fraud_users WHERE status = 'banned'`
    );
    const paid = await pool.query(
      `SELECT COALESCE(SUM(usdt),0) AS s FROM withdrawals WHERE status = 'paid'`
    );
    const pending = await pool.query(
      `SELECT w.id, w.telegram_id, w.address, w.usdt, w.error,
              COALESCE(NULLIF(f.username,''), f.first_name, '') AS name
       FROM withdrawals w
       LEFT JOIN fraud_users f ON f.telegram_id = w.telegram_id
       WHERE w.status = 'pending'
       ORDER BY w.id ASC LIMIT 50`
    );

    return res.json({
      ok: true,
      users: users.rows[0].n,
      banned: banned.rows[0].n,
      paid_total: String(paid.rows[0].s),
      pending: pending.rows
    });

  } catch (error) {

    console.error('ADMIN OVERVIEW ERROR:', error);
    return res.status(500).json({ ok: false, message: 'Server error.' });
  }
});

// ---------- admin: approve (auto-pay BEP20) / reject ----------

app.post('/api/admin/withdraw/decide', async (req, res) => {

  try {

    await initDatabase();

    const adminId = await requireAdmin(req, res);
    if (!adminId) return;

    const wid = Number(req.body?.id);
    const action = String(req.body?.action || '');

    if (!Number.isInteger(wid) || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ ok: false, message: 'Invalid request.' });
    }

    if (action === 'reject') {

      const r = await pool.query(
        `UPDATE withdrawals
         SET status = 'rejected', decided_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING telegram_id, coins, usdt`,
        [wid]
      );

      if (r.rows.length === 0) {
        return res.status(400).json({ ok: false, message: 'ጥያቄው አልተገኘም ወይም ተወስኗል።' });
      }

      await pool.query(
        `UPDATE user_balance SET coins = coins + $2 WHERE telegram_id = $1`,
        [r.rows[0].telegram_id, r.rows[0].coins]
      );

      await sendTelegramMessage(
        r.rows[0].telegram_id,
        `❌ የ${r.rows[0].usdt} USDT የገንዘብ ጥያቄዎ ተቀባይነት አላገኘም። ሂሳብዎ ተመልሷል።`
      );

      return res.json({ ok: true });
    }

    // approve: lock the row first so it can never be paid twice
    const c = await pool.query(
      `UPDATE withdrawals SET status = 'processing'
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [wid]
    );

    if (c.rows.length === 0) {
      return res.status(400).json({ ok: false, message: 'ጥያቄው አልተገኘም ወይም ተወስኗል።' });
    }

    const w = c.rows[0];

    try {

      const hash = await sendUSDT(w.address, w.usdt);

      await pool.query(
        `UPDATE withdrawals
         SET status = 'paid', tx_hash = $2, error = '', decided_at = NOW()
         WHERE id = $1`,
        [wid, hash]
      );

      await sendTelegramMessage(
        w.telegram_id,
        `✅ ${w.usdt} USDT ወደ አድራሻዎ ተልኳል።\n\nTx: https://bscscan.com/tx/${hash}`
      );

      return res.json({ ok: true, tx: hash });

    } catch (payError) {

      // Payment failed before sending -> back to pending so admin can retry
      await pool.query(
        `UPDATE withdrawals SET status = 'pending', error = $2 WHERE id = $1`,
        [wid, String(payError.message || 'error').slice(0, 200)]
      );

      console.error('PAYOUT ERROR:', payError);

      return res.status(500).json({
        ok: false,
        message: 'ክፍያ አልተሳካም: ' + String(payError.message || '').slice(0, 120)
      });
    }

  } catch (error) {

    console.error('DECIDE ERROR:', error);
    return res.status(500).json({ ok: false, message: 'Server error.' });
  }
});


// =========================================================
// LOCAL SERVER
// =========================================================

if (
  require.main === module
) {

  initDatabase()

    .then(() =>
      setupWebhook()
    )

    .then(() => {

      app.listen(
        PORT,
        () => {

          console.log(
            `Adewa server running on port ${PORT}`
          );
        }
      );

    })

    .catch((error) => {

      console.error(
        'Startup error:',
        error
      );

      process.exit(1);
    });
}


// =========================================================
// VERCEL
// =========================================================

if (
  process.env.VERCEL ||
  process.env.VERCEL_ENV
) {

  setupWebhook()
    .catch(() => {});
}


module.exports = app;
