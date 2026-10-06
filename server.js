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

const MINI_APP_URL =
  'https://abdulselamahemade608-prog.github.io/V-/';

const WEBHOOK_URL =
  'https://adewav2.vercel.app/telegram/webhook';

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

      '🚫 VPN/Proxy detected.\n\n' +
      'Your account has been permanently banned from Adewa.'
    );
  }

  if (reason === 'multi') {

    return sendTelegramMessage(
      chatId,

      '🚫 Multiple accounts detected.\n\n' +
      'Your account has been permanently banned from Adewa.'
    );
  }

  return sendTelegramMessage(
    chatId,

    '🚫 Your account has been permanently banned from Adewa.'
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

    '✅ Your verification is successfully.'
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
        // -----------------------------------------------

        const firstName =
          message.from?.first_name ||
          'there';

        await telegram(
          'sendMessage',
          {

            chat_id:
              chatId,

            text:
              `👋 Hello ${firstName}!\n\n` +
              `Welcome to Adewa Mini App.`,

            reply_markup: {

              inline_keyboard: [

                [

                  {

                    text:
                      '🚀 OPEN ADEWA',

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

      const networkCheck =
        await detectVPNProxy(ip);

      // ===================================================
      // MULTI ACCOUNT CHECK
      // ===================================================

      const multiAccount =
        await detectMultiAccount(
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
    min_ad_seconds: 5
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
        state
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
