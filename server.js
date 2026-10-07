'use strict';

// Env vars: DATABASE_URL, BOT_TOKEN, ADMIN_IDS, PROOF_CHANNEL, MINI_APP_URL,
// BOT_USERNAME, CRON_SECRET, TON_MNEMONIC, TON_WALLET_ADDRESS,
// TONCENTER_API_KEY, BSC_PRIVATE_KEY, BSC_RPC, ADD_GROUP_ID, ADD_GROUP_LINK
// Packages: express cors pg ethers @ton/ton @ton/crypto @ton/core
const NOTI_EMOJI = '5456140674028019486';

const escHtml = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN || '';

const ADMIN_IDS = String(
  process.env.ADMIN_IDS || process.env.ADMIN_ID || ''
)
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const PROOF_CHANNEL = process.env.PROOF_CHANNEL || '@proof_chnallel';

const WITHDRAW_CHANNEL =
  process.env.WITHDRAW_CHANNEL || '';

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || '';

const CRON_SECRET =
  process.env.CRON_SECRET || '';

const MINI_APP_URL =
  process.env.MINI_APP_URL ||
  'https://abdulselamahemade608-prog.github.io/Adewa';

const BOT_USERNAME =
  process.env.BOT_USERNAME || '';

const TON_WALLET_ADDRESS =
  process.env.TON_WALLET_ADDRESS ||
  'UQBnqsss4HOg3WLfxSaL1LsUOebC9fxh0xZuQNcEnPR3Y5Wj';

const TON_MNEMONIC = process.env.TON_MNEMONIC || '';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';

const TONCENTER_ENDPOINT =
  process.env.TONCENTER_ENDPOINT ||
  'https://toncenter.com/api/v2/jsonRPC';

const BSC_PRIVATE_KEY = process.env.BSC_PRIVATE_KEY || '';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';

const CRYPTO_METHODS = ['bep20', 'ton'];

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || '';

const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL ||
  'claude-haiku-4-5-20251001';

const DEFAULT_FAQ_KNOWLEDGE = `
App name: Adewa (formerly FulusApp) — a Telegram Mini App where users earn coins.
Sections: Home, Tasks, Invite, Withdraw.
Earning sources: watching ads, completing tasks, inviting friends.
Coins convert to Birr (ETB); the exchange rate is set by the admin (often 100 coins = 1 Birr).
Withdraw methods: Telebirr and CBE. Each withdrawal has a small service fee.
Withdrawals are reviewed and paid manually by an admin; proof of payment is posted in the proof channel.
Invited friends must join the required channels and be active on 2 separate days before the inviter is paid the referral reward.
There are daily limits on ads/earnings, and VIP users (based on invite count) get higher or unlimited ad limits.
If you don't know a specific number (exact fee %, exact minimum withdrawal, exact reward), say a human admin will confirm it — never guess exact figures.
`;

const WITHDRAW_METHODS = {
  telebirr: /^09\d{8}$/,
  mpesa: /^07\d{8}$/,
  cbe: /^(1000\d{9}|10000\d{8})$/,

  /* crypto (auto payout) - OFF unless listed in WITHDRAW_METHODS_ENABLED */
  bep20: /^0x[a-fA-F0-9]{40}$/,
  ton: /^([A-Za-z0-9_-]{48}|-?\d:[a-fA-F0-9]{64})$/
};

/* Env WITHDRAW_METHODS_ENABLED, e.g. "telebirr,cbe" (default) or "telebirr,cbe,mpesa,bep20,ton" */
const ENABLED_METHODS = String(
  process.env.WITHDRAW_METHODS_ENABLED || 'telebirr,cbe'
)
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter((x) => ['telebirr', 'cbe'].includes(x)); /* withdraw = Telebirr + CBE only */

const DEFAULT_GATE_CHANNELS = [
  '@andbndj',
  '@proof_chnallel',
  '@ABDU_CRYPTO',
  '@m_r_work1'
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

const app = express();

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-init-data', 'x-device', 'x-cron-key'],
    maxAge: 86400
  })
);
app.use(express.json({ limit: '100kb' }));

const q = (t, p) => pool.query(t, p);

const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'server' });
  });

const todayStr = () =>
  new Date().toISOString().slice(0, 10);

const dayDiff = (a, b) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

const fail = (res, code, error, extra = {}) =>
  res.status(code).json({ error, ...extra });

const isAdmin = (id) =>
  ADMIN_IDS.includes(String(id));

async function tg(method, body) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    return await r.json();
  } catch (e) {
    return {
      ok: false,
      description: String(e)
    };
  }
}

async function askFAQAI(question, knowledge) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const r = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 400,
          system:
            'You are the automatic support assistant for the Adewa Telegram earning app. ' +
            'Reply directly and briefly (2-5 short sentences), in the SAME language the user wrote in (Amharic or English). ' +
            'Only rely on the facts given below. If the question is unrelated to the app, or you are not sure of an exact number or rule, ' +
            'say that a human admin will confirm it soon — never invent amounts, dates, or rules.\n\n' +
            knowledge,
          messages: [
            {
              role: 'user',
              content: String(question).slice(0, 2000)
            }
          ]
        })
      }
    );

    const data = await r.json();

    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return text || null;
  } catch (e) {
    console.error('askFAQAI', e);
    return null;
  }
}

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const p = new URLSearchParams(initData);
  const hash = p.get('hash');

  if (!hash) return null;

  p.delete('hash');

  const str = [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calc = crypto
    .createHmac('sha256', secret)
    .update(str)
    .digest('hex');

  if (calc !== hash) return null;

  if (
    Date.now() / 1000 -
      Number(p.get('auth_date') || 0) >
    86400
  ) {
    return null;
  }

  try {
    return {
      user: JSON.parse(p.get('user')),
      start: p.get('start_param') || ''
    };
  } catch {
    return null;
  }
}

let sCache = {
  t: 0,
  v: {}
};

async function settings() {
  if (Date.now() - sCache.t < 30000) {
    return sCache.v;
  }

  const { rows } = await q(
    'SELECT key, value FROM settings'
  );

  const v = {};

  rows.forEach((r) => {
    v[r.key] = r.value;
  });

  if (
    !Array.isArray(v.gate_channels) ||
    !v.gate_channels.length
  ) {
    v.gate_channels = DEFAULT_GATE_CHANNELS;
  }

  if (
    !Array.isArray(v.free_table) ||
    !v.free_table.length
  ) {
    v.free_table = [
      [0, 55],
      [3, 25],
      [5, 15],
      [10, 5]
    ];
  }

  if (
    !Array.isArray(v.paid_table) ||
    !v.paid_table.length
  ) {
    v.paid_table = [
      [0, 40],
      [5, 25],
      [10, 15],
      [20, 10],
      [25, 1],
      [1, 9]
    ];
  }

  if (
    v.spin_cost === undefined ||
    v.spin_cost === null ||
    v.spin_cost === ''
  ) {
    v.spin_cost = 20;
  }

  if (
    v.coin_per_etb === undefined ||
    v.coin_per_etb === null ||
    v.coin_per_etb === ''
  ) {
    v.coin_per_etb = 100;
  }

  if (v.ads_payment_enabled === undefined) {
    v.ads_payment_enabled = true;
  }

  if (v.invite_payment_enabled === undefined) {
    v.invite_payment_enabled = true;
  }

  if (
    v.withdraw_fee_percent === undefined ||
    v.withdraw_fee_percent === null ||
    v.withdraw_fee_percent === ''
  ) {
    v.withdraw_fee_percent = 3;
  }

  if (
    v.free_spins === undefined ||
    v.free_spins === null ||
    v.free_spins === ''
  ) {
    v.free_spins = 5;
  }

  if (v.faq_bot_enabled === undefined) {
    v.faq_bot_enabled = true;
  }

  if (
    !v.channel_rewards ||
    typeof v.channel_rewards !== 'object' ||
    Array.isArray(v.channel_rewards)
  ) {
    v.channel_rewards = {};
  }

  if (
    v.referral_min_hold_hours === undefined ||
    v.referral_min_hold_hours === null ||
    v.referral_min_hold_hours === ''
  ) {
    v.referral_min_hold_hours = 24;
  }

  if (
    v.referral_clawback_hours === undefined ||
    v.referral_clawback_hours === null ||
    v.referral_clawback_hours === ''
  ) {
    v.referral_clawback_hours = 48;
  }

  if (
    v.referral_daily_cap === undefined ||
    v.referral_daily_cap === null ||
    v.referral_daily_cap === ''
  ) {
    v.referral_daily_cap = 0;
  }

  if (v.referral_require_activity === undefined) {
    v.referral_require_activity = true;
  }

  if (
    v.referral_full_bonus === undefined ||
    v.referral_full_bonus === null ||
    v.referral_full_bonus === ''
  ) {
    v.referral_full_bonus = 0;
  }

  if (
    v.etb_per_usd === undefined ||
    v.etb_per_usd === null ||
    v.etb_per_usd === ''
  ) {
    v.etb_per_usd = 150;
  }

  if (
    v.ton_usd_price === undefined ||
    v.ton_usd_price === null ||
    v.ton_usd_price === ''
  ) {
    v.ton_usd_price = 0;
  }

  if (v.withdraw_adds_required === undefined || v.withdraw_adds_required === null || v.withdraw_adds_required === '') {
    v.withdraw_adds_required = 0;
  }

  if (
    !v.channel_meta ||
    typeof v.channel_meta !== 'object' ||
    Array.isArray(v.channel_meta)
  ) {
    v.channel_meta = {};
  }

  v.add_group_id = String(v.add_group_id || process.env.ADD_GROUP_ID || '').trim();
  v.add_group_link = String(v.add_group_link || process.env.ADD_GROUP_LINK || '').trim();

  if (!(Number(v.withdraw_interval_hours) > 0)) {
    v.withdraw_interval_hours = 48;
  }

  sCache = {
    t: Date.now(),
    v
  };

  return v;
}

const SETTING_KEYS = [
  'coin_per_etb',
  'ad_reward',
  'ad_cooldown',
  'ad_min_seconds',
  'ads_per_level',
  'free_spins',
  'spin_cost',
  'free_table',
  'paid_table',
  'freeze_price',
  'milestone_bonus',
  'referral_reward',
  'min_withdraw_etb',
  'withdraw_referrals_required',
  'withdraw_interval_hours',
  'global_daily_cap_etb',
  'withdrawals_open',
  'ads_payment_enabled',
  'invite_payment_enabled',
  'withdraw_fee_percent',
  'gate_channels',
  'gate_cache_min',

  'vip_invites_unlimited',
  'weekly_top_inviter_min',
  'weekly_top_inviter_bonus_etb',
  'anticheat_ip_check',

  'faq_knowledge',
  'faq_bot_enabled',

  'channel_rewards',
  'referral_min_hold_hours',
  'referral_clawback_hours',
  'referral_daily_cap',
  'referral_require_activity',
  'referral_full_bonus',
  'support_bot_username',

  'etb_per_usd',
  'ton_usd_price',

  'withdraw_adds_required',
  'add_group_id',
  'add_group_link',
  'channel_meta'
];

async function ensureUser(tu, refId) {
  const ins = await q(
    `INSERT INTO users(id, first_name, username)
     VALUES($1,$2,$3)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [
      tu.id,
      tu.first_name || '',
      tu.username || ''
    ]
  );

  if (ins.rowCount) {
    if (
      refId &&
      /^\d+$/.test(String(refId)) &&
      String(refId) !== String(tu.id)
    ) {
      const assigned = await q(
        `UPDATE users
         SET referred_by=$2
         WHERE id=$1
         AND EXISTS(
           SELECT 1 FROM users WHERE id=$2
         )
         RETURNING id`,
        [tu.id, refId]
      );

      if (assigned.rowCount) {
        await captureReferralBaseline(tu.id, refId);
      }
    }
  } else {
    await q(
      `UPDATE users
       SET first_name=$2,
           username=$3
       WHERE id=$1`,
      [
        tu.id,
        tu.first_name || '',
        tu.username || ''
      ]
    );
  }
}

async function captureReferralBaseline(inviteeId, referrerId) {
  const S = await settings();

  let chans = Array.isArray(S.gate_channels)
    ? S.gate_channels
    : DEFAULT_GATE_CHANNELS;

  if (!chans.length) {
    chans = DEFAULT_GATE_CHANNELS;
  }

  for (const chat of chans) {
    const r = await tg('getChatMember', {
      chat_id: chat,
      user_id: inviteeId
    });

    let wasMember = false;

    if (r.ok) {
      const st = r.result.status;

      wasMember =
        st === 'restricted'
          ? !!r.result.is_member
          : ['member', 'administrator', 'creator'].includes(st);
    }

    await q(
      `INSERT INTO referral_channels(
        invitee_id, channel, referrer_id,
        was_member_before, currently_joined
      )
      VALUES($1,$2,$3,$4,$4)
      ON CONFLICT (invitee_id, channel) DO NOTHING`,
      [inviteeId, chat, referrerId, wasMember]
    );
  }
}

async function syncReferralChannels(inviteeId, channels) {
  const rows = (
    await q(
      `SELECT * FROM referral_channels WHERE invitee_id=$1`,
      [inviteeId]
    )
  ).rows;

  if (!rows.length) return;

  const S = await settings();
  const byChannel = {};
  rows.forEach((r) => {
    byChannel[r.channel] = r;
  });

  const rewardFor = (chat) => {
    const map = S.channel_rewards || {};
    const v = map[chat];
    return Number(v != null && v !== '' ? v : S.referral_reward || 0);
  };

  const minHoldMs =
    Number(S.referral_min_hold_hours || 0) * 3600000;
  const clawbackMs =
    Number(S.referral_clawback_hours || 0) * 3600000;

  for (const c of channels) {
    const row = byChannel[c.chat];

    if (!row || row.was_member_before) continue;

    if (c.joined && !row.currently_joined) {
      await q(
        `UPDATE referral_channels
         SET currently_joined=true, joined_at=now()
         WHERE invitee_id=$1 AND channel=$2`,
        [inviteeId, c.chat]
      );
      row.currently_joined = true;
      row.joined_at = new Date();
    } else if (!c.joined && row.currently_joined) {
      if (row.paid && !row.clawed_back) {
        const withinWindow =
          row.paid_at &&
          Date.now() - new Date(row.paid_at).getTime() <= clawbackMs;

        if (withinWindow) {
          const amt = rewardFor(c.chat);

          await q(
            `UPDATE users
             SET coins=GREATEST(0, coins-$2),
                 invite_coins=GREATEST(0, invite_coins-$2),
                 flagged=true
             WHERE id=$1`,
            [row.referrer_id, amt]
          );

          await q(
            `UPDATE users SET flagged=true WHERE id=$1`,
            [inviteeId]
          );

          await q(
            `UPDATE referral_channels
             SET currently_joined=false, left_after_paid=true, clawed_back=true
             WHERE invitee_id=$1 AND channel=$2`,
            [inviteeId, c.chat]
          );

          await tg('sendMessage', {
            chat_id: row.referrer_id,
            text:
              `⚠️ ${amt} coins were taken back: the friend you invited left ${c.chat} shortly after joining.`
          }).catch(() => {});
        } else {
          await q(
            `UPDATE referral_channels
             SET currently_joined=false, left_after_paid=true
             WHERE invitee_id=$1 AND channel=$2`,
            [inviteeId, c.chat]
          );
        }
      } else {
        await q(
          `UPDATE referral_channels
           SET currently_joined=false, joined_at=NULL
           WHERE invitee_id=$1 AND channel=$2`,
          [inviteeId, c.chat]
        );
      }

      row.currently_joined = false;
    }

  }
}

/* =========================================================
   REQUIRED CHANNELS: title / link / reward + full referral pay
========================================================= */

function gateChans(S) {
  const c = Array.isArray(S.gate_channels) && S.gate_channels.length
    ? S.gate_channels
    : DEFAULT_GATE_CHANNELS;

  return c.length ? c : DEFAULT_GATE_CHANNELS;
}

function channelInfo(S, chat) {
  const meta = (S.channel_meta && S.channel_meta[chat]) || {};
  const rw = (S.channel_rewards || {})[chat];

  return {
    chat,
    title: meta.title || String(chat),
    url: meta.link || chatUrl(chat),
    reward: Number(rw != null && rw !== '' ? rw : S.referral_reward || 0)
  };
}

async function isChannelMember(chat, userId) {
  const r = await tg('getChatMember', { chat_id: chat, user_id: userId });

  if (!r.ok) return false;

  const st = r.result.status;

  return st === 'restricted'
    ? !!r.result.is_member
    : ['member', 'administrator', 'creator'].includes(st);
}

/*
 * The inviter is paid ONCE, when the invited person
 *   1) joined ALL required channels, and
 *   2) passed the multi-account / VPN check (fraud status "verified").
 * Amount = sum of every channel's reward (4 channels x 250 = 1000).
 */
async function tryPayFullReferral(inviteeId, knownChannels) {
  const u = (
    await q(
      `SELECT id, first_name, username, referred_by, referral_paid, flagged, banned
       FROM users WHERE id=$1`,
      [inviteeId]
    )
  ).rows[0];

  if (!u || !u.referred_by || u.referral_paid || u.flagged || u.banned) return;
  if (String(u.referred_by) === String(u.id)) return;

  const fz = (
    await q('SELECT status FROM fraud_users WHERE telegram_id=$1', [inviteeId])
  ).rows[0];

  if (!fz || fz.status !== 'verified') return;

  const S = await settings();
  const chans = gateChans(S);

  let allJoined;

  if (knownChannels && knownChannels.length) {
    allJoined = chans.every((c) =>
      knownChannels.some((k) => k.chat === c && k.joined)
    );
  } else {
    const rs = await Promise.all(chans.map((c) => isChannelMember(c, inviteeId)));
    allJoined = rs.every(Boolean);
  }

  if (!allJoined) return;

  const ref = (
    await q('SELECT id, flagged, banned FROM users WHERE id=$1', [u.referred_by])
  ).rows[0];

  if (!ref || ref.flagged || ref.banned) return;

  let total = chans.reduce((a, c) => a + channelInfo(S, c).reward, 0);

  const bonus = Number(S.referral_full_bonus || 0);
  if (bonus > 0) total += bonus;

  /* atomic: only one request can win, so it can never pay twice */
  const claim = await q(
    `UPDATE users
     SET referral_paid=true, full_referral_bonus_paid=true
     WHERE id=$1 AND referral_paid=false
     RETURNING id`,
    [inviteeId]
  );

  if (!claim.rowCount) return;

  if (total > 0) {
    await q(
      `UPDATE users
       SET coins=coins+$2,
           invite_coins=invite_coins+$2,
           daily_ads =
             CASE WHEN daily_earn_day=CURRENT_DATE THEN daily_ads ELSE 0 END,
           daily_task =
             CASE WHEN daily_earn_day=CURRENT_DATE THEN daily_task ELSE 0 END,
           daily_invite =
             CASE WHEN daily_earn_day=CURRENT_DATE THEN daily_invite+$2 ELSE $2 END,
           daily_earn_day=CURRENT_DATE
       WHERE id=$1`,
      [u.referred_by, total]
    );
  }

  await q(
    `UPDATE referral_channels
     SET paid=true, paid_at=now(), currently_joined=true
     WHERE invitee_id=$1`,
    [inviteeId]
  );

  const name = u.username ? '@' + u.username : u.first_name || 'Someone';

  await tg('sendMessage', {
    chat_id: u.referred_by,
    text:
      `🎉 ${name} joined all ${chans.length} required channel(s).\n` +
      `You earned ${total} coins from this invite.\n\n` +
      `🎉 ${name} ሁሉንም ${chans.length} ቻናል ተቀላቅለዋል።\n` +
      `በዚህ ኢንቫይት ${total} ኮይን አግኝተዋል።\n\n` +
      chans.map((c) => `• ${channelInfo(S, c).title}: +${channelInfo(S, c).reward}`).join('\n')
  }).catch(() => {});
}

async function saveSettingRow(key, value) {
  await q(
    `INSERT INTO settings(key, value) VALUES($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=$2`,
    [key, JSON.stringify(value)]
  );

  sCache.t = 0;
}


const auth = ah(async (req, res, next) => {
  const d = verifyInitData(
    req.headers['x-init-data']
  );

  if (!d || !d.user) {
    return fail(res, 401, 'bad_auth');
  }

  const m = /^ref_(\d+)$/.exec(
    d.start || ''
  );

  await ensureUser(
    d.user,
    m ? m[1] : null
  );

  const { rows } = await q(
    `SELECT *,
      last_checkin::text AS last_checkin_s,
      free_spins_day::text AS fsd
     FROM users
     WHERE id=$1`,
    [d.user.id]
  );

  const u = rows[0];

  if (!u) {
    return fail(res, 404, 'user_not_found');
  }

  await initFraud();

  const fz = (
    await q(
      'SELECT status, ban_reason FROM fraud_users WHERE telegram_id=$1',
      [u.id]
    )
  ).rows[0];

  if (u.banned || (fz && fz.status === 'banned')) {
    return fail(res, 403, 'banned', {
      reason: (fz && fz.ban_reason) || 'Banned'
    });
  }

  const gateOnly = String(req.originalUrl || '').split('?')[0] === '/api/gate';

  if (!gateOnly && (!fz || fz.status !== 'verified')) {
    return fail(res, 403, 'not_verified');
  }

  const dev = String(
    req.headers['x-device'] || ''
  ).slice(0, 64);

  if (dev && !u.device_hash) {
    await q(
      `UPDATE users
       SET device_hash=$2
       WHERE id=$1`,
      [u.id, dev]
    );

    const c = await q(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE device_hash=$1`,
      [dev]
    );

    if (c.rows[0].c > 2) {
      await q(
        `UPDATE users
         SET flagged=true
         WHERE id=$1`,
        [u.id]
      );

      u.flagged = true;
    }

    u.device_hash = dev;
  }

  const ip = String(
    req.headers['x-forwarded-for'] || ''
  )
    .split(',')[0]
    .trim()
    .slice(0, 64);

  if (ip && ip !== u.last_ip) {
    await q(
      `UPDATE users
       SET last_ip=$2
       WHERE id=$1`,
      [u.id, ip]
    );

    u.last_ip = ip;

    const S = await settings();

    if (S.anticheat_ip_check) {
      const c = await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE last_ip=$1`,
        [ip]
      );

      if (c.rows[0].c > 2) {
        await q(
          `UPDATE users
           SET flagged=true
           WHERE last_ip=$1`,
          [ip]
        );

        u.flagged = true;
      }
    }
  }

  req.user = u;

  next();
});

let fraudReady = null;

function initFraud() {
  if (fraudReady) return fraudReady;

  fraudReady = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS fraud_users (
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
      admin_verified BOOLEAN NOT NULL DEFAULT FALSE,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      request_count INTEGER NOT NULL DEFAULT 0
    )`);
  })().catch((e) => {
    fraudReady = null;
    console.error('initFraud', e);
    throw e;
  });

  return fraudReady;
}

const sha256 = (v) =>
  crypto.createHash('sha256').update(String(v || '')).digest('hex');

function getClientIP(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return String(f).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
}

function getBanType(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('vpn') || r.includes('proxy') || r.includes('tor')) return 'vpn';
  if (r.includes('multiple') || r.includes('multi account')) return 'multi';
  return 'other';
}

async function sendBanMessage(chatId, type) {
  const tail = 'Your account has been permanently banned from Adewa.';

  let text = tail;
  if (type === 'vpn') text = `VPN/Proxy detected.\n\n${tail}`;
  if (type === 'multi') text = `Multiple accounts detected.\n\n${tail}`;

  const r = await tg('sendMessage', { chat_id: chatId, text });
  return !!r.ok;
}

async function detectVPNProxy(ip) {
  const result = { checked: false, vpn: false, proxy: false, tor: false, hosting: false, detected: false };
  if (!ip) return result;

  const clean = String(ip).replace(/^::ffff:/, '').trim();

  if (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    clean.startsWith('172.16.')
  ) {
    return result;
  }

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return result;

    const data = await response.json();
    if (!data || data.success === false) return result;

    const sec = data.security || {};

    result.checked = true;
    result.vpn = sec.vpn === true;
    result.proxy = sec.proxy === true;
    result.tor = sec.tor === true;
    result.hosting = sec.hosting === true;
    result.detected = result.vpn || result.proxy || result.tor;

    return result;
  } catch (e) {
    console.error('VPN detection error:', e.message);
    return result;
  }
}

async function detectMultiAccount(telegramId, ipHash, deviceHash) {
  if (!deviceHash && !ipHash) return { detected: false, reason: '' };

  if (deviceHash) {
    const d = await q(
      'SELECT telegram_id FROM fraud_users WHERE device_hash=$1 AND telegram_id<>$2 LIMIT 1',
      [deviceHash, telegramId]
    );

    if (d.rows.length) {
      return {
        detected: true,
        reason: 'Multiple Telegram accounts detected on the same device.'
      };
    }
  }

  if (ipHash) {
    const i = await q(
      `SELECT telegram_id, device_hash FROM fraud_users
       WHERE ip_hash=$1 AND telegram_id<>$2 AND status='verified' LIMIT 1`,
      [ipHash, telegramId]
    );

    if (i.rows.length) {
      const old = i.rows[0].device_hash;

      if (old && deviceHash && old !== deviceHash) {
        return {
          detected: true,
          reason: 'Multiple Telegram accounts detected from the same IP address.'
        };
      }
    }
  }

  return { detected: false, reason: '' };
}

async function recordBan(id, username, firstName, ipHash, deviceHash, vpn, proxy, reason) {
  await q(
    `INSERT INTO fraud_users
       (telegram_id, username, first_name, ip_hash, device_hash, vpn_detected, proxy_detected,
        risk_score, status, ban_reason, last_seen, request_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,100,'banned',$8,NOW(),1)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=EXCLUDED.username, first_name=EXCLUDED.first_name,
       ip_hash=EXCLUDED.ip_hash, device_hash=EXCLUDED.device_hash,
       vpn_detected=EXCLUDED.vpn_detected, proxy_detected=EXCLUDED.proxy_detected,
       risk_score=100, status='banned', ban_reason=EXCLUDED.ban_reason,
       last_seen=NOW(), request_count=fraud_users.request_count+1`,
    [id, username, firstName, ipHash, deviceHash, vpn, proxy, reason]
  );

  await q('UPDATE users SET banned=true WHERE id=$1', [id]);
}

async function banUserById(telegramId, reason) {
  await initFraud();

  await q(
    `INSERT INTO fraud_users (telegram_id, status, ban_reason, admin_verified, last_seen, request_count)
     VALUES ($1,'banned',$2,FALSE,NOW(),1)
     ON CONFLICT (telegram_id) DO UPDATE SET
       status='banned', ban_reason=EXCLUDED.ban_reason, admin_verified=FALSE, last_seen=NOW()`,
    [telegramId, reason || 'Admin ban']
  );

  await q('UPDATE users SET banned=true WHERE id=$1', [telegramId]);

  await sendBanMessage(telegramId, getBanType(reason || 'Admin ban'));
}

async function unbanUserById(telegramId) {
  await initFraud();

  const r = await q(
    `UPDATE fraud_users SET
       status='verified', ban_reason='', vpn_detected=FALSE, proxy_detected=FALSE,
       risk_score=0, ban_message_sent=FALSE, admin_verified=TRUE, last_seen=NOW()
     WHERE telegram_id=$1 RETURNING telegram_id`,
    [telegramId]
  );

  await q('UPDATE users SET banned=false WHERE id=$1', [telegramId]);

  if (r.rows.length) {
    await tg('sendMessage', {
      chat_id: telegramId,
      text: 'Your account has been unbanned. Send /start to continue.'
    });
  }

  return r.rows[0] || null;
}

app.post(
  '/api/auth',
  ah(async (req, res) => {
    await initFraud();

    const d = verifyInitData(req.headers['x-init-data']);

    if (!d || !d.user) {
      return res.status(401).json({
        ok: false,
        status: 'invalid',
        error: 'bad_auth',
        message: 'Invalid Telegram session.'
      });
    }

    const user = d.user;
    const telegramId = Number(user.id);
    const username = user.username || '';
    const firstName = user.first_name || '';

    const deviceId = String(req.headers['x-device'] || '').trim();
    const ip = getClientIP(req);
    const ipHash = sha256(ip);
    const deviceHash = sha256(deviceId);

    const m = /^ref_(\d+)$/.exec(d.start || '');
    await ensureUser(user, m ? m[1] : null);

    const existing = (
      await q('SELECT * FROM fraud_users WHERE telegram_id=$1 LIMIT 1', [telegramId])
    ).rows[0];

    if (existing && existing.status === 'banned') {
      await sendBanMessage(telegramId, getBanType(existing.ban_reason));

      return res.status(403).json({
        ok: false,
        status: 'banned',
        error: 'banned',
        reason: existing.ban_reason,
        message: 'Your account has been permanently banned.'
      });
    }

    const trusted = !!existing && existing.admin_verified === true;

    const multi = trusted
      ? { detected: false }
      : await detectMultiAccount(telegramId, ipHash, deviceHash);

    if (multi.detected) {
      await recordBan(telegramId, username, firstName, ipHash, deviceHash, false, false, multi.reason);
      await sendBanMessage(telegramId, 'multi');

      return res.status(403).json({
        ok: false,
        status: 'banned',
        error: 'banned',
        reason: multi.reason,
        message: 'Multiple accounts detected. Your account has been permanently banned.'
      });
    }

    const net = trusted ? { detected: false } : await detectVPNProxy(ip);

    if (net.detected) {
      const reason = net.vpn
        ? 'VPN detected'
        : net.proxy
        ? 'Proxy detected'
        : net.tor
        ? 'Tor detected'
        : 'Restricted network detected';

      await recordBan(
        telegramId, username, firstName, ipHash, deviceHash,
        net.vpn || net.tor, net.proxy, reason
      );
      await sendBanMessage(telegramId, 'vpn');

      return res.status(403).json({
        ok: false,
        status: 'banned',
        error: 'banned',
        reason,
        message: 'VPN/Proxy detected. Your account has been permanently banned.'
      });
    }

    await q(
      `INSERT INTO fraud_users
         (telegram_id, username, first_name, ip_hash, device_hash, vpn_detected, proxy_detected,
          risk_score, status, ban_reason, last_seen, request_count)
       VALUES ($1,$2,$3,$4,$5,FALSE,FALSE,0,'verified','',NOW(),1)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username=EXCLUDED.username, first_name=EXCLUDED.first_name,
         ip_hash=EXCLUDED.ip_hash, device_hash=EXCLUDED.device_hash,
         status='verified', last_seen=NOW(), request_count=fraud_users.request_count+1`,
      [telegramId, username, firstName, ipHash, deviceHash]
    );

    const sent = (
      await q('SELECT verification_message_sent FROM fraud_users WHERE telegram_id=$1', [telegramId])
    ).rows[0];

    if (!sent || !sent.verification_message_sent) {
      const r = await tg('sendMessage', {
        chat_id: telegramId,
        text: 'Your verification is successful.'
      });

      if (r.ok) {
        await q(
          'UPDATE fraud_users SET verification_message_sent=TRUE WHERE telegram_id=$1',
          [telegramId]
        );
      }
    }

    await tryPayFullReferral(telegramId).catch((e) =>
      console.error('tryPayFullReferral', e)
    );

    return res.json({
      ok: true,
      status: 'verified',
      admin: isAdmin(telegramId),
      message: 'Verified.'
    });
  })
);

const forceThrottle = new Map();

async function checkGate(user, force) {
  const S = await settings();

  let chans = Array.isArray(S.gate_channels)
    ? S.gate_channels
    : DEFAULT_GATE_CHANNELS;

  if (!chans.length) {
    chans = DEFAULT_GATE_CHANNELS;
  }

  const cached =
    user.gate_ok_until &&
    new Date(user.gate_ok_until) >
      new Date();

  if (cached && !force) {
    return {
      ok: true,
      channels: chans.map((c) => ({
        chat: c,
        joined: true
      }))
    };
  }

  if (force) {
    const last =
      forceThrottle.get(user.id) || 0;

    if (Date.now() - last < 2000) {
      return {
        ok: false,
        channels: chans.map((c) => ({
          chat: c,
          joined: false
        })),
        throttled: true
      };
    }

    forceThrottle.set(
      user.id,
      Date.now()
    );
  }

  const channels = await Promise.all(
    chans.map(async (c) => {
      const r = await tg(
        'getChatMember',
        {
          chat_id: c,
          user_id: user.id
        }
      );

      let joined = false;

      if (r.ok) {
        const st = r.result.status;

        joined =
          st === 'restricted'
            ? !!r.result.is_member
            : [
                'member',
                'administrator',
                'creator'
              ].includes(st);
      }

      return {
        chat: c,
        joined,
        error: r.ok
          ? null
          : r.description
      };
    })
  );

  const ok = channels.every(
    (x) => x.joined
  );

  await q(
    `UPDATE users
     SET gate_ok_until=$2,
         gate_passed =
           gate_passed OR $3
     WHERE id=$1`,
    [
      user.id,
      ok
        ? new Date(
            Date.now() +
              (S.gate_cache_min || 10) *
                60000
          )
        : null,
      ok
    ]
  );

  try {
    await syncReferralChannels(user.id, channels);

    if (ok) await tryPayFullReferral(user.id, channels);
  } catch (e) {
    console.error('syncReferralChannels', e);
  }

  return {
    ok,
    channels
  };
}

const needGate = ah(
  async (req, res, next) => {
    const g = await checkGate(
      req.user,
      false
    );

    if (!g.ok) {
      return fail(
        res,
        403,
        'gate'
      );
    }

    next();
  }
);

const adminOnly = (
  req,
  res,
  next
) =>
  isAdmin(req.user.id)
    ? next()
    : fail(res, 403, 'admin');

async function processReferrals(uid) {
  return;

  const S = await settings();

  const r = await q(
    `UPDATE users u
     SET referral_paid=true
     WHERE u.referred_by=$1
       AND u.referral_paid=false
       AND u.gate_passed
       AND NOT u.flagged
       AND (
         SELECT COUNT(
           DISTINCT (
             a.started_at
             AT TIME ZONE 'UTC'
           )::date
         )
         FROM ad_views a
         WHERE a.user_id=u.id
           AND a.completed
       ) >= 2
     RETURNING u.id`,
    [uid]
  );

  if (r.rowCount) {
    const amt =
      r.rowCount *
      (S.referral_reward || 0);

    await q(
      `UPDATE users
       SET coins=coins+$2,
           invite_coins=invite_coins+$2,
           daily_ads =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_ads ELSE 0 END,
           daily_task =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_task ELSE 0 END,
           daily_invite =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_invite+$2 ELSE $2 END,
           daily_earn_day=CURRENT_DATE
       WHERE id=$1`,
      [uid, amt]
    );
  }
}

async function vipStatus(user) {
  const S = await settings();

  if (
    user.vip_unlimited_until &&
    new Date(user.vip_unlimited_until) >
      new Date()
  ) {
    return true;
  }

  const need = Number(
    S.vip_invites_unlimited || 0
  );

  if (!need) return false;

  const refs = (
    await q(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE referred_by=$1
         AND referral_paid`,
      [user.id]
    )
  ).rows[0].c;

  return refs >= need;
}

function pick(table) {
  if (!Array.isArray(table) || !table.length) {
    return 0;
  }

  const total = table.reduce(
    (a, r) => a + Number(r[1]),
    0
  );

  let x =
    crypto.randomInt(
      Math.max(
        1,
        Math.round(total * 100)
      )
    ) / 100;

  for (const [prize, w] of table) {
    x -= Number(w);

    if (x < 0) {
      return Number(prize);
    }
  }

  return Number(table[0][0]);
}

async function finishTask(id) {
  const r = await q(
    `UPDATE tasks
     SET active=false
     WHERE id=$1
       AND active
       AND max_users IS NOT NULL
       AND (
         SELECT COUNT(*)
         FROM task_subs
         WHERE task_id=$1
           AND status IN ('pending','approved')
       ) >= max_users
     RETURNING id`,
    [id]
  );

  if (r.rowCount) {
    await deleteTaskBroadcast(id);
  }
}

async function deleteTaskBroadcast(taskId) {
  const { rows } = await q(
    `SELECT chat_id, message_id
     FROM task_broadcasts
     WHERE task_id=$1`,
    [taskId]
  );

  for (const m of rows) {
    await tg('deleteMessage', {
      chat_id: m.chat_id,
      message_id: m.message_id
    }).catch(() => {});
  }

  await q(
    `DELETE FROM task_broadcasts
     WHERE task_id=$1`,
    [taskId]
  );
}

const chatUrl = (c) =>
  'https://t.me/' +
  String(c).replace(/^@/, '');

function buildProofCaption(w, feePercent) {
  const fee =
    Math.round(
      w.etb * feePercent
    ) / 100;

  const final =
    Math.round(
      (w.etb - fee) * 100
    ) / 100;

  const user =
    '@' + (w.username || w.first_name || 'user');

  const footer =
    `\n-------------------------------\n\n` +
    `🤖 Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : '-'}`;

  if (w.method === 'telebirr') {
    return (
      `💸 New Withdrawal approve \n` +
      `----------------\n` +
      `👤 User: ${user}\n` +
      `📱 Telebirr Number: ${w.account}\n` +
      `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
      `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
      `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
      `🔍 Status: Paid ` +
      footer
    );
  }

  if (w.method === 'mpesa') {
    return (
      `💸 New Withdrawal Approved \n` +
      `----------------\n` +
      `👤 User: ${user}\n` +
      `📱 Mepeas Number: ${w.account}\n` +
      `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
      `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
      `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
      `🔍 Status: Paid ` +
      footer
    );
  }

  return (
    `💸 New Withdrawal approve \n` +
    `----------------\n` +
    `👤 User: ${user}\n` +
    `📱 Cbe Number: ${w.account}\n` +
    `💵 Requested Amount:${w.etb.toFixed(2)} Birr\n` +
    `📉 ${feePercent}% Service Fee: ${fee.toFixed(2)} Birr\n` +
    `💰 Final Amount: ${final.toFixed(2)} Birr\n` +
    `🔍 Status: Paid ` +
    footer
  );
}

app.get(
  '/health',
  ah(async (req, res) => {
    await q('SELECT 1');

    res.json({
      ok: true,
      service: 'Adewa',
      status: 'online',
      database: 'connected'
    });
  })
);

app.get(
  '/api/gate',
  auth,
  ah(async (req, res) => {
    const g = await checkGate(
      req.user,
      req.query.force === '1'
    );

    res.json({
      ok: g.ok,
      channels: await Promise.all(
        g.channels.map(async (c) => {
          const info = channelInfo(await settings(), c.chat);

          return {
            chat: c.chat,
            joined: c.joined,
            title: info.title,
            url: info.url
          };
        })
      )
    });
  })
);

app.get(
  '/api/me',
  auth,
  ah(async (req, res) => {
    const S = await settings();

    await processReferrals(
      req.user.id
    );

    const u = (
      await q(
        `SELECT *,
          last_checkin::text AS last_checkin_s,
          free_spins_day::text AS fsd
         FROM users
         WHERE id=$1`,
        [req.user.id]
      )
    ).rows[0];

    const t = todayStr();

    const limits =
      S.ads_per_level || [
        10,
        15,
        20
      ];

    const adsToday = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM ad_views
         WHERE user_id=$1
           AND completed
           AND (
             started_at
             AT TIME ZONE 'UTC'
           )::date=$2::date`,
        [u.id, t]
      )
    ).rows[0].c;

    const refs = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1
           AND referral_paid`,
        [u.id]
      )
    ).rows[0].c;

    const invited = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1`,
        [u.id]
      )
    ).rows[0].c;

    const vip = await vipStatus(u);

    let state = 'new';

    if (u.last_checkin_s) {
      const d = dayDiff(
        t,
        u.last_checkin_s
      );

      state =
        d === 0
          ? 'done'
          : d === 1
          ? 'ready'
          : d === 2 &&
            u.streak > 0
          ? 'recoverable'
          : 'lost';
    }

    const freeUsed =
      u.fsd === t
        ? u.free_spins_used
        : 0;

    const nextAt =
      u.last_withdraw_at
        ? new Date(
            new Date(
              u.last_withdraw_at
            ).getTime() +
              (S.withdraw_interval_hours ||
                48) *
                3600000
          )
        : null;

    const total = (tb) =>
      tb.reduce(
        (a, r) =>
          a + Number(r[1]),
        0
      );

    res.json({
      user: {
        id: u.id,
        name: u.first_name,
        coins: Number(u.coins),
        ads_coins: Number(u.ads_coins || 0),
        invite_coins: Number(u.invite_coins || 0),
        level: u.level,
        streak: u.streak,
        best: u.best_streak,
        state,
        flagged: u.flagged
      },

      cfg: {
        coin_per_etb:
          S.coin_per_etb,

        ad_reward:
          S.ad_reward,

        ads_today:
          adsToday,

        ads_limit:
          vip
            ? null
            : limits[u.level - 1] ||
              limits[
                limits.length - 1
              ],

        vip,

        levels: limits,

        freeze_price:
          S.freeze_price,

        milestone_bonus:
          S.milestone_bonus,

        referral_reward:
          S.referral_reward,

        gate_channels:
          S.gate_channels ||
          DEFAULT_GATE_CHANNELS,

        spin: {
          free_left: Math.max(
            0,
            (S.free_spins || 0) -
              freeUsed
          ),

          cost:
            S.spin_cost,

          free_prizes: [
            ...new Set(
              (S.free_table || [])
                .map((r) =>
                  Number(r[0])
                )
            )
          ].sort(
            (a, b) => a - b
          ),

          paid_odds:
            (S.paid_table || [])
              .map((r) => [
                Number(r[0]),
                Math.round(
                  (Number(r[1]) /
                    total(
                      S.paid_table
                    )) *
                    1000
                ) / 10
              ])
        },

        withdraw: {
          open:
            S.withdrawals_open !==
            false,

          min_etb:
            S.min_withdraw_etb,

          refs_required:
            S.withdraw_referrals_required,

          refs_have:
            refs,

          adds_required:
            Number(S.withdraw_adds_required || 0),

          adds_have:
            await countGroupAdds(u.id, S),

          group_link:
            S.add_group_link || '',

          next_at:
            nextAt &&
            nextAt > new Date()
              ? nextAt.toISOString()
              : null,

          interval_h:
            S.withdraw_interval_hours,

          methods: availableMethods(),

          etb_per_usd:
            Number(S.etb_per_usd || 0),

          ton_usd:
            tonUsdCache.v || Number(S.ton_usd_price || 0),

          ads_enabled:
            S.ads_payment_enabled !== false,

          invite_enabled:
            S.invite_payment_enabled !== false,

          fee_percent:
            Number(S.withdraw_fee_percent || 0),

          max_coins: Math.max(
            0,
            Math.floor(
              (S.ads_payment_enabled !== false
                ? Number(u.ads_coins || 0)
                : 0) +
              (S.invite_payment_enabled !== false
                ? Number(u.invite_coins || 0)
                : 0)
            )
          )
        }
      },

      invited,

      lang: u.lang || 'en',

      ref_link:
        `https://t.me/${await botName()}?start=ref_${u.id}`,

      is_admin:
        isAdmin(u.id)
    });
  })
);

app.get(
  '/api/checkin-calendar',
  auth,
  ah(async (req, res) => {
    const u = req.user;
    const days = [];

    if (u.last_checkin_s && u.streak > 0) {
      const base = new Date(u.last_checkin_s + 'T00:00:00Z');

      for (let i = 0; i < u.streak; i++) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() - i);
        days.push(d.toISOString().slice(0, 10));
      }
    }

    res.json({ days });
  })
);

app.post(
  '/api/lang',
  auth,
  ah(async (req, res) => {
    const lang = 'en';

    await q(
      `UPDATE users
       SET lang=$2
       WHERE id=$1`,
      [req.user.id, lang]
    );

    res.json({ ok: true, lang });
  })
);

let _bot = '';

async function botName() {
  if (_bot) return _bot;

  const r = await tg(
    'getMe',
    {}
  );

  _bot = r.ok
    ? r.result.username
    : '';

  return _bot;
}

app.post(
  '/api/checkin',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const diff =
      u.last_checkin_s
        ? dayDiff(
            t,
            u.last_checkin_s
          )
        : null;

    if (diff === 0) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (
      diff === 2 &&
      u.streak > 0 &&
      !req.body.restart
    ) {
      return fail(
        res,
        409,
        'recoverable'
      );
    }

    const streak =
      diff === 1
        ? u.streak + 1
        : 1;

    const maxLevel =
      (
        S.ads_per_level || [
          10,
          15,
          20
        ]
      ).length;

    const newLevel = Math.min(
      maxLevel,
      1 +
        Math.floor(
          streak / 7
        )
    );

    let level = u.level;
    let bonus = 0;

    if (newLevel > u.level) {
      level = newLevel;
      bonus = Number(
        S.milestone_bonus || 0
      );
    }

    await q(
      `UPDATE users
       SET streak=$2,
           best_streak=GREATEST(best_streak,$2),
           last_checkin=$3::date,
           level=$4,
           coins=coins+$5
       WHERE id=$1`,
      [
        u.id,
        streak,
        t,
        level,
        bonus
      ]
    );

    res.json({
      ok: true,
      streak,
      level,
      bonus
    });
  })
);

app.post(
  '/api/streak/freeze',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    if (
      !(
        u.last_checkin_s &&
        dayDiff(
          t,
          u.last_checkin_s
        ) === 2 &&
        u.streak > 0
      )
    ) {
      return fail(
        res,
        409,
        'not_recoverable'
      );
    }

    const r = await q(
      `UPDATE users
       SET coins=coins-$2,
           last_checkin=($3::date - 1)
       WHERE id=$1
         AND coins>=$2`,
      [
        u.id,
        S.freeze_price,
        t
      ]
    );

    if (!r.rowCount) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    res.json({
      ok: true
    });
  })
);

app.post(
  '/api/ad/start',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const limits =
      S.ads_per_level || [
        10,
        15,
        20
      ];

    const limit =
      limits[u.level - 1] ||
      limits[
        limits.length - 1
      ];

    const vip = await vipStatus(u);

    if (!vip) {
      const cnt = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM ad_views
           WHERE user_id=$1
             AND completed
             AND (
               started_at
               AT TIME ZONE 'UTC'
             )::date=$2::date`,
          [u.id, t]
        )
      ).rows[0].c;

      if (cnt >= limit) {
        return fail(
          res,
          429,
          'quota'
        );
      }
    }

    const last = (
      await q(
        `SELECT EXTRACT(
           EPOCH FROM
           (now()-started_at)
         ) AS s
         FROM ad_views
         WHERE user_id=$1
         ORDER BY id DESC
         LIMIT 1`,
        [u.id]
      )
    ).rows[0];

    const cd =
      S.ad_cooldown || 30;

    if (
      last &&
      Number(last.s) < cd
    ) {
      return fail(
        res,
        429,
        'cooldown',
        {
          wait: Math.ceil(
            cd -
              Number(last.s)
          )
        }
      );
    }

    const nonce =
      crypto.randomBytes(16)
        .toString('hex');

    await q(
      `INSERT INTO ad_views(
        user_id,
        nonce
      )
      VALUES($1,$2)`,
      [
        u.id,
        nonce
      ]
    );

    res.json({
      nonce
    });
  })
);

app.post(
  '/api/ad/complete',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();

    const nonce = String(
      (req.body || {}).nonce ||
        ''
    );

    const reward = Number(
      S.ad_reward || 0
    );

    const r = await q(
      `UPDATE ad_views
       SET completed=true,
           reward=$3
       WHERE nonce=$1
         AND user_id=$2
         AND completed=false
         AND started_at <=
           now() -
           ($4::int *
           interval '1 second')
       RETURNING id`,
      [
        nonce,
        u.id,
        reward,
        S.ad_min_seconds || 10
      ]
    );

    if (!r.rowCount) {
      return fail(
        res,
        400,
        'invalid_view'
      );
    }

    const c = await q(
      `UPDATE users
       SET coins=coins+$2,
           ads_coins=ads_coins+$2,
           daily_invite =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_invite ELSE 0 END,
           daily_task =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_task ELSE 0 END,
           daily_ads =
             CASE WHEN daily_earn_day=CURRENT_DATE
               THEN daily_ads+$2 ELSE $2 END,
           daily_earn_day=CURRENT_DATE
       WHERE id=$1
       RETURNING coins`,
      [
        u.id,
        reward
      ]
    );

    res.json({
      ok: true,
      reward,
      coins: Number(
        c.rows[0].coins
      )
    });
  })
);

app.post(
  '/api/spin',
  auth,
  needGate,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();
    const t = todayStr();

    const kind =
      (req.body || {}).kind ===
      'paid'
        ? 'paid'
        : 'free';

    let cost = 0;

    if (kind === 'free') {
      const r = await q(
        `UPDATE users
         SET free_spins_day=$2::date,
             free_spins_used =
               CASE
                 WHEN free_spins_day=$2::date
                 THEN free_spins_used+1
                 ELSE 1
               END
         WHERE id=$1
           AND (
             free_spins_day
               IS DISTINCT FROM $2::date
             OR free_spins_used < $3
           )
         RETURNING free_spins_used`,
        [
          u.id,
          t,
          S.free_spins || 0
        ]
      );

      if (!r.rowCount) {
        return fail(
          res,
          409,
          'no_spins'
        );
      }
    } else {
      cost = Number(
        S.spin_cost || 0
      );

      const r = await q(
        `UPDATE users
         SET coins=coins-$2
         WHERE id=$1
           AND coins>=$2
         RETURNING coins`,
        [
          u.id,
          cost
        ]
      );

      if (!r.rowCount) {
        return fail(
          res,
          402,
          'no_coins'
        );
      }
    }

    const prize = pick(
      kind === 'free'
        ? S.free_table
        : S.paid_table
    );

    const c = await q(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1
       RETURNING coins,
                 free_spins_used,
                 free_spins_day::text AS fsd`,
      [
        u.id,
        prize
      ]
    );

    await q(
      `INSERT INTO spins(
        user_id,
        kind,
        cost,
        prize
      )
      VALUES($1,$2,$3,$4)`,
      [
        u.id,
        kind,
        cost,
        prize
      ]
    );

    const used =
      c.rows[0].fsd === t
        ? c.rows[0]
            .free_spins_used
        : 0;

    res.json({
      prize,
      coins: Number(
        c.rows[0].coins
      ),
      free_left: Math.max(
        0,
        (S.free_spins || 0) -
          used
      )
    });
  })
);

app.get(
  '/api/winners',
  auth,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT
        u.first_name AS name,
        s.prize
       FROM spins s
       JOIN users u
         ON u.id=s.user_id
       WHERE s.prize >= 10
       ORDER BY s.id DESC
       LIMIT 10`
    );

    res.json({
      winners: rows
    });
  })
);

app.get(
  '/api/tasks',
  auth,
  needGate,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT
        t.id,
        t.title,
        t.type,
        t.url,
        t.reward,
        t.max_users,
        s.status AS my_status,
        (
          SELECT COUNT(*)::int
          FROM task_subs x
          WHERE x.task_id=t.id
            AND x.status IN (
              'pending',
              'approved'
            )
        ) AS taken
       FROM tasks t
       LEFT JOIN task_subs s
         ON s.task_id=t.id
        AND s.user_id=$1
       WHERE t.active
         AND (
           s.status IS NULL
           OR s.status <> 'approved'
         )
       ORDER BY t.id DESC`,
      [req.user.id]
    );

    res.json({
      tasks: rows.filter(
        (t) =>
          !t.max_users ||
          t.taken < t.max_users ||
          t.my_status
      )
    });
  })
);

app.post(
  '/api/tasks/:id/verify',
  auth,
  needGate,
  ah(async (req, res) => {
    const t = (
      await q(
        `SELECT *
         FROM tasks
         WHERE id=$1
           AND active
           AND type='channel'`,
        [req.params.id]
      )
    ).rows[0];

    if (!t) {
      return fail(
        res,
        404,
        'not_found'
      );
    }

    const prev = (
      await q(
        `SELECT status
         FROM task_subs
         WHERE task_id=$1
           AND user_id=$2`,
        [
          t.id,
          req.user.id
        ]
      )
    ).rows[0];

    if (
      prev &&
      prev.status === 'approved'
    ) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (!prev && t.max_users) {
      const n = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM task_subs
           WHERE task_id=$1
             AND status IN (
               'pending',
               'approved'
             )`,
          [t.id]
        )
      ).rows[0].c;

      if (n >= t.max_users) {
        return fail(
          res,
          409,
          'limit'
        );
      }
    }

    const r = await tg(
      'getChatMember',
      {
        chat_id: t.chat,
        user_id: req.user.id
      }
    );

    const st = r.ok
      ? r.result.status
      : null;

    const joined =
      st === 'restricted'
        ? !!r.result.is_member
        : [
            'member',
            'administrator',
            'creator'
          ].includes(st);

    if (!joined) {
      return fail(
        res,
        400,
        'not_joined'
      );
    }

    const up = await q(
      `INSERT INTO task_subs(
        task_id,
        user_id,
        status
      )
      VALUES($1,$2,'approved')
      ON CONFLICT (
        task_id,
        user_id
      )
      DO UPDATE SET
        status='approved'
      WHERE task_subs.status <> 'approved'
      RETURNING id`,
      [
        t.id,
        req.user.id
      ]
    );

    if (up.rowCount) {
      await q(
        `UPDATE users
         SET coins=coins+$2,
             daily_ads =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_ads ELSE 0 END,
             daily_invite =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_invite ELSE 0 END,
             daily_task =
               CASE WHEN daily_earn_day=CURRENT_DATE
                 THEN daily_task+$2 ELSE $2 END,
             daily_earn_day=CURRENT_DATE
         WHERE id=$1`,
        [
          req.user.id,
          t.reward
        ]
      );

      await finishTask(t.id);
    }

    res.json({
      ok: true,
      reward: Number(
        t.reward
      )
    });
  })
);

app.post(
  '/api/tasks/:id/start',
  auth,
  needGate,
  ah(async (req, res) => {
    const t = (
      await q(
        `SELECT *
         FROM tasks
         WHERE id=$1
           AND active
           AND type='social'`,
        [req.params.id]
      )
    ).rows[0];

    if (!t) {
      return fail(
        res,
        404,
        'not_found'
      );
    }

    const prev = (
      await q(
        `SELECT status
         FROM task_subs
         WHERE task_id=$1
           AND user_id=$2`,
        [
          t.id,
          req.user.id
        ]
      )
    ).rows[0];

    if (
      prev &&
      (
        prev.status === 'pending' ||
        prev.status === 'approved'
      )
    ) {
      return fail(
        res,
        409,
        'already'
      );
    }

    if (!prev && t.max_users) {
      const n = (
        await q(
          `SELECT COUNT(*)::int AS c
           FROM task_subs
           WHERE task_id=$1
             AND status IN (
               'pending',
               'approved'
             )`,
          [t.id]
        )
      ).rows[0].c;

      if (n >= t.max_users) {
        return fail(
          res,
          409,
          'limit'
        );
      }
    }

    await q(
      `INSERT INTO task_subs(
        task_id,
        user_id,
        status
      )
      VALUES($1,$2,'awaiting')
      ON CONFLICT (
        task_id,
        user_id
      )
      DO UPDATE SET
        status='awaiting'`,
      [
        t.id,
        req.user.id
      ]
    );

    res.json({
      ok: true,
      bot:
        `https://t.me/${await botName()}`
    });
  })
);

app.post(
  '/api/promo',
  auth,
  needGate,
  ah(async (req, res) => {
    const code = String(
      (req.body || {}).code || ''
    )
      .trim()
      .toUpperCase()
      .slice(0, 32);

    const p = (
      await q(
        `SELECT *
         FROM promos
         WHERE code=$1
           AND active`,
        [code]
      )
    ).rows[0];

    if (!p) {
      return fail(
        res,
        404,
        'invalid_code'
      );
    }

    const use = await q(
      `INSERT INTO promo_uses(
        code,
        user_id
      )
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      RETURNING code`,
      [
        code,
        req.user.id
      ]
    );

    if (!use.rowCount) {
      return fail(
        res,
        409,
        'already'
      );
    }

    const ok = await q(
      `UPDATE promos
       SET uses=uses+1
       WHERE code=$1
         AND (
           max_uses IS NULL
           OR uses < max_uses
         )
       RETURNING uses`,
      [code]
    );

    if (!ok.rowCount) {
      await q(
        `DELETE FROM promo_uses
         WHERE code=$1
           AND user_id=$2`,
        [
          code,
          req.user.id
        ]
      );

      return fail(
        res,
        409,
        'code_full'
      );
    }

    await q(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1`,
      [
        req.user.id,
        p.reward
      ]
    );

    res.json({
      ok: true,
      reward: Number(
        p.reward
      )
    });
  })
);

app.get(
  '/api/leaderboard',
  auth,
  ah(async (req, res) => {
    const S = await settings();

    const top = (
      await q(
        `SELECT
          u.first_name AS name,
          COUNT(*)::int AS ads
         FROM ad_views a
         JOIN users u
           ON u.id=a.user_id
         WHERE a.completed
           AND a.started_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY ads DESC
         LIMIT 55`
      )
    ).rows;

    const inviters = (
      await q(
        `SELECT
          u.first_name AS name,
          COUNT(*)::int AS invites
         FROM users ref
         JOIN users u
           ON u.id=ref.referred_by
         WHERE ref.referral_paid
           AND ref.created_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY invites DESC
         LIMIT 55`
      )
    ).rows;

    const coinPerEtb = Number(
      S.coin_per_etb || 1
    ) || 1;

    const earners = (
      await q(
        `SELECT
          u.first_name AS name,
          ROUND(u.coins / $1, 2) AS pending_etb,
          COALESCE(w.paid, 0) AS paid_etb,
          ROUND(
            u.coins / $1
              + COALESCE(w.paid, 0)
              + COALESCE(w.pending, 0),
            2
          ) AS total_earned_etb
         FROM users u
         LEFT JOIN (
           SELECT
             user_id,
             SUM(etb)
               FILTER (
                 WHERE status='paid'
               ) AS paid,
             SUM(etb)
               FILTER (
                 WHERE status='pending'
               ) AS pending
           FROM withdrawals
           GROUP BY user_id
         ) w
           ON w.user_id=u.id
         ORDER BY total_earned_etb DESC
         LIMIT 55`,
        [coinPerEtb]
      )
    ).rows;

    res.json({
      top,
      inviters,
      earners
    });
  })
);

app.get(
  '/api/withdrawals',
  auth,
  ah(async (req, res) => {
    await ensureCryptoCols();

    const { rows } = await q(
      `SELECT
        id,
        etb,
        method,
        account,
        status,
        tx_hash,
        paid_amount,
        paid_asset,
        created_at
       FROM withdrawals
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 10`,
      [req.user.id]
    );

    res.json({
      items: rows
    });
  })
);

app.post(
  '/api/withdraw',
  auth,
  ah(async (req, res) => {
    const u = req.user;
    const S = await settings();

    const g = await checkGate(
      u,
      true
    );

    if (!g.ok) {
      return fail(
        res,
        403,
        'gate'
      );
    }

    if (
      S.withdrawals_open ===
      false
    ) {
      return fail(
        res,
        423,
        'closed'
      );
    }

    if (u.flagged) {
      return fail(
        res,
        403,
        'under_review'
      );
    }

    const b = req.body || {};

    const etb =
      Math.round(
        Number(b.etb) * 100
      ) / 100;

    const method = String(
      b.method || ''
    )
      .trim()
      .toLowerCase();

    const account = String(
      b.account || ''
    )
      .trim()
      .slice(0, 80);

    const holderName = String(
      b.holder_name || b.owner_name || ''
    )
      .trim()
      .slice(0, 64);

    if (
      !(etb > 0) ||
      !WITHDRAW_METHODS[method] ||
      !availableMethods().includes(method)
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    const isCrypto = CRYPTO_METHODS.includes(method);

    if (
      isCrypto &&
      !availableMethods().includes(method)
    ) {
      return fail(res, 423, 'crypto_off');
    }

    if (!WITHDRAW_METHODS[method].test(account)) {
      return fail(
        res,
        400,
        isCrypto ? 'bad_address' : 'bad_phone'
      );
    }

    if (!isCrypto && holderName.length < 3) {
      return fail(
        res,
        400,
        'bad_name'
      );
    }

    if (
      !S.ads_payment_enabled &&
      !S.invite_payment_enabled
    ) {
      return fail(
        res,
        423,
        'no_payment_source'
      );
    }

    if (
      etb <
      Number(
        S.min_withdraw_etb || 0
      )
    ) {
      return fail(
        res,
        400,
        'min',
        {
          min:
            S.min_withdraw_etb
        }
      );
    }

    if (
      u.last_withdraw_at &&
      Date.now() -
        new Date(
          u.last_withdraw_at
        ).getTime() <
        (S.withdraw_interval_hours ||
          48) *
          3600000
    ) {
      return fail(
        res,
        429,
        'interval'
      );
    }

    const refs = (
      await q(
        `SELECT COUNT(*)::int AS c
         FROM users
         WHERE referred_by=$1
           AND referral_paid`,
        [u.id]
      )
    ).rows[0].c;

    if (
      refs <
      (
        S.withdraw_referrals_required ||
        0
      )
    ) {
      return fail(
        res,
        403,
        'referrals'
      );
    }

    const needAdds = Number(S.withdraw_adds_required || 0);

    if (needAdds > 0) {
      const haveAdds = await countGroupAdds(u.id, S);

      if (haveAdds < needAdds) {
        return fail(res, 403, 'need_adds', {
          have: haveAdds,
          need: needAdds
        });
      }
    }

    const cap = (
      await q(
        `SELECT
          COALESCE(
            SUM(etb),
            0
          ) AS s
         FROM withdrawals
         WHERE status IN ('pending','processing','paid')
           AND (
             created_at
             AT TIME ZONE 'UTC'
           )::date=$1::date`,
        [todayStr()]
      )
    ).rows[0].s;

    if (
      Number(cap) + etb >
      Number(
        S.global_daily_cap_etb ||
          1e9
      )
    ) {
      return fail(
        res,
        429,
        'cap'
      );
    }

    const coins = Math.round(
      etb * S.coin_per_etb
    );

    const availAds = S.ads_payment_enabled
      ? Number(u.ads_coins || 0)
      : 0;

    const availInvite = S.invite_payment_enabled
      ? Number(u.invite_coins || 0)
      : 0;

    if (coins > availAds + availInvite) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    const fromAds = Math.min(
      coins,
      availAds
    );

    const fromInvite =
      coins - fromAds;

    const d = await q(
      `UPDATE users
       SET coins=coins-$2,
           ads_coins=GREATEST(0, ads_coins-$3),
           invite_coins=GREATEST(0, invite_coins-$4),
           last_withdraw_at=now()
       WHERE id=$1
         AND coins>=$2
       RETURNING coins`,
      [
        u.id,
        coins,
        fromAds,
        fromInvite
      ]
    );

    if (!d.rowCount) {
      return fail(
        res,
        402,
        'no_coins'
      );
    }

    const w = (
      await q(
        `INSERT INTO withdrawals(
          user_id,
          coins,
          etb,
          method,
          account,
          holder_name,
          from_ads,
          from_invite
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id`,
        [
          u.id,
          coins,
          etb,
          method,
          account,
          holderName,
          fromAds,
          fromInvite
        ]
      )
    ).rows[0];

    let text =
      `Withdrawal #${w.id}\n` +
      `User: ${u.first_name} (ID: ${u.id}) @${u.username || '-'}\n` +
      `Amount: ${etb} ETB\n` +
      `Method: ${method}\n` +
      `Account: ${account}\n` +
      `Holder name: ${holderName || '-'}`;

    if (isCrypto) {
      let payLine = '';

      try {
        const qt = await cryptoQuote({ etb, method }, S);

        payLine =
          `\nNetwork: ${method === 'bep20' ? 'BEP20 (BNB Smart Chain)' : 'TON'}` +
          `\nFee: ${S.withdraw_fee_percent || 0}%` +
          `\nWill pay: ${qt.amount} ${qt.asset}`;
      } catch (e) {
        payLine = `\nNetwork: ${method.toUpperCase()}\n(Quote error: ${e.message})`;
      }

      text += payLine + '\n\nPress Approve & Pay to send the crypto automatically.';
    }

    for (const adminId of ADMIN_IDS) {
      await tg(
        'sendMessage',
        {
          chat_id: adminId,
          text,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: isCrypto ? '✅ Approve & Pay' : '✅ Paid',
                  style: 'success',
                  callback_data:
                    `w:a:${w.id}`
                },
                {
                  text: '❌ Reject',
                  style: 'danger',
                  callback_data:
                    `w:r:${w.id}`
                }
              ]
            ]
          }
        }
      );
    }

    if (WITHDRAW_CHANNEL) {
      await tg(
        'sendMessage',
        {
          chat_id:
            WITHDRAW_CHANNEL,
          text
        }
      );
    }

    res.json({
      ok: true,
      id: w.id,
      coins: Number(
        d.rows[0].coins
      )
    });
  })
);

app.get(
  '/api/admin/overview',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const S = await settings();

    const stats = (
      await q(
        `SELECT
          (
            SELECT COUNT(*)::int
            FROM users
          ) AS users,

          (
            SELECT COUNT(*)::int
            FROM users
            WHERE created_at >
              now() - interval '1 day'
          ) AS new_today,

          (
            SELECT COUNT(*)::int
            FROM users
            WHERE flagged
          ) AS flagged,

          (
            SELECT COUNT(*)::int
            FROM task_subs
            WHERE status='pending'
          ) AS pending_tasks,

          (
            SELECT
              COALESCE(
                SUM(coins),
                0
              )::bigint
            FROM users
          ) AS coins_owed`
      )
    ).rows[0];

    const pending = (
      await q(
        `SELECT
          w.id,
          w.etb,
          w.method,
          w.account,
          u.first_name
         FROM withdrawals w
         JOIN users u
           ON u.id=w.user_id
         WHERE w.status='pending'
         ORDER BY w.id`
      )
    ).rows;

    const tasks = (
      await q(
        `SELECT
          t.*,
          (
            SELECT COUNT(*)::int
            FROM task_subs s
            WHERE s.task_id=t.id
              AND s.status IN (
                'pending',
                'approved'
              )
          ) AS taken
         FROM tasks t
         ORDER BY id DESC
         LIMIT 50`
      )
    ).rows;

    const promos = (
      await q(
        'SELECT * FROM promos ORDER BY code'
      )
    ).rows;

    const s = {};

    SETTING_KEYS.forEach(
      (k) => {
        s[k] = S[k];
      }
    );

    res.json({
      stats,
      pending,
      tasks,
      promos,
      settings: s,
      admins: ADMIN_IDS
    });
  })
);

app.post(
  '/api/admin/setting',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const {
      key,
      value
    } = req.body || {};

    if (
      !SETTING_KEYS.includes(key)
    ) {
      return fail(
        res,
        400,
        'bad_key'
      );
    }

    if (
      /_table$/.test(key) &&
      !(
        Array.isArray(value) &&
        value.length &&
        value.every(
          (r) =>
            Array.isArray(r) &&
            r.length === 2 &&
            r.every((n) =>
              Number.isFinite(
                Number(n)
              )
            )
        )
      )
    ) {
      return fail(
        res,
        400,
        'bad_table'
      );
    }

    if (
      key === 'gate_channels' &&
      !(
        Array.isArray(value) &&
        value.every(
          (c) =>
            /^@\w{4,}$/.test(
              String(c)
            )
        )
      )
    ) {
      return fail(
        res,
        400,
        'bad_channels'
      );
    }

    await q(
      `INSERT INTO settings(
        key,
        value
      )
      VALUES($1,$2)
      ON CONFLICT(key)
      DO UPDATE SET
        value=$2`,
      [
        key,
        JSON.stringify(value)
      ]
    );

    sCache.t = 0;

    res.json({
      ok: true
    });
  })
);

app.post(
  '/api/admin/channel',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};
    const S = await settings();

    const list = Array.isArray(S.gate_channels) && S.gate_channels.length
      ? [...S.gate_channels]
      : [];

    const rewards = { ...(S.channel_rewards || {}) };
    const meta = { ...(S.channel_meta || {}) };

    const toChat = (v) => {
      const m = /^(?:https?:\/\/)?(?:t\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,})\/?$/.exec(
        String(v || '').trim()
      );

      return m ? '@' + m[1] : null;
    };

    const chat = toChat(b.link || b.chat);

    if (!chat) {
      return fail(res, 400, 'bad_channels');
    }

    if (b.action === 'remove') {
      const i = list.indexOf(chat);
      if (i >= 0) list.splice(i, 1);
      delete rewards[chat];
      delete meta[chat];
    } else {
      const title = String(b.title || '').trim().slice(0, 40);
      const reward = Number(b.reward);

      if (!title || !(reward >= 0)) {
        return fail(res, 400, 'bad_input');
      }

      const info = await tg('getChat', { chat_id: chat });

      if (!info.ok) {
        return fail(res, 400, 'bad_channels', {
          detail: info.description
        });
      }

      if (!list.includes(chat)) list.push(chat);

      rewards[chat] = reward;
      meta[chat] = { title, link: 'https://t.me/' + chat.slice(1) };
    }

    await saveSettingRow('gate_channels', list);
    await saveSettingRow('channel_rewards', rewards);
    await saveSettingRow('channel_meta', meta);

    res.json({ ok: true });
  })
);


app.post(
  '/api/admin/task',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};

    const type =
      b.type === 'channel'
        ? 'channel'
        : 'social';

    const title = String(
      b.title || ''
    )
      .trim()
      .slice(0, 80);

    const chat = String(
      b.chat || ''
    ).trim();

    let url = String(
      b.url || ''
    ).trim();

    if (type === 'channel') {
      if (
        !/^@\w{4,}$/.test(chat)
      ) {
        return fail(
          res,
          400,
          'bad_channel'
        );
      }

      url = chatUrl(chat);
    }

    if (
      !title ||
      !/^https?:\/\//.test(url)
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    const max =
      Number(b.max_users) > 0
        ? Math.floor(
            Number(
              b.max_users
            )
          )
        : null;

    const reward = Math.max(
      0,
      Math.floor(
        Number(b.reward) || 0
      )
    );

    const sponsor = String(
      b.sponsor || ''
    )
      .trim()
      .slice(0, 60);

    const ins = await q(
      `INSERT INTO tasks(
        title,
        type,
        url,
        chat,
        reward,
        max_users,
        sponsor
      )
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id`,
      [
        title,
        type,
        url,
        type === 'channel'
          ? chat
          : '',
        reward,
        max,
        sponsor || null
      ]
    );

    const taskId = ins.rows[0].id;

    if (b.broadcast) {
      broadcastTask(
        taskId,
        title,
        reward,
        sponsor
      ).catch((e) =>
        console.error(
          'broadcastTask',
          e
        )
      );
    }

    res.json({
      ok: true,
      id: taskId
    });
  })
);

async function broadcastTask(taskId, title, reward, sponsor) {
  const { rows } = await q(
    'SELECT id FROM users WHERE NOT banned'
  );

  for (const u of rows) {
    const r = await tg(
      'sendMessage',
      {
        chat_id: u.id,
        parse_mode: 'HTML',
        text:
          `<tg-emoji emoji-id="${NOTI_EMOJI}">📢</tg-emoji> ` +
          `New task added: ${escHtml(title)}\n` +
          (sponsor
            ? `📣 Sponsored by: ${escHtml(sponsor)}\n`
            : '') +
          `Reward: ${reward} coins`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Start',
                style: 'success',
                web_app: {
                  url: MINI_APP_URL
                }
              }
            ]
          ]
        }
      }
    );

    if (r.ok) {
      await q(
        `INSERT INTO task_broadcasts(
          task_id,
          chat_id,
          message_id
        )
        VALUES($1,$2,$3)`,
        [
          taskId,
          u.id,
          r.result.message_id
        ]
      );
    }

    await new Promise((r2) =>
      setTimeout(r2, 40)
    );
  }
}

app.post(
  '/api/admin/task/:id/toggle',
  auth,
  adminOnly,
  ah(async (req, res) => {
    await q(
      `UPDATE tasks
       SET active = NOT active
       WHERE id=$1`,
      [req.params.id]
    );

    res.json({
      ok: true
    });
  })
);

app.post(
  '/api/admin/promo',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};

    const code = String(
      b.code || ''
    )
      .trim()
      .toUpperCase()
      .slice(0, 32);

    if (
      !/^[A-Z0-9_]{3,32}$/.test(
        code
      )
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    await q(
      `INSERT INTO promos(
        code,
        reward,
        max_uses
      )
      VALUES($1,$2,$3)
      ON CONFLICT(code)
      DO UPDATE SET
        reward=$2,
        max_uses=$3,
        active=true`,
      [
        code,
        Math.max(
          0,
          Math.floor(
            Number(
              b.reward
            ) || 0
          )
        ),
        Number(b.max_uses) > 0
          ? Math.floor(
              Number(
                b.max_uses
              )
            )
          : null
      ]
    );

    res.json({
      ok: true
    });
  })
);

async function broadcastAll(text, keyboard) {
  const { rows } = await q(
    'SELECT id FROM users WHERE NOT banned'
  );

  let sent = 0;

  const payload = { text };

  if (keyboard && keyboard.length) {
    payload.reply_markup = {
      inline_keyboard: [keyboard]
    };
  }

  for (const u of rows) {
    const r = await tg('sendMessage', {
      chat_id: u.id,
      ...payload
    });

    if (r.ok) sent++;

    await new Promise((r2) =>
      setTimeout(r2, 40)
    );
  }

  return sent;
}

app.post(
  '/api/admin/broadcast',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const b = req.body || {};

    const text = String(
      b.text || b.message || ''
    )
      .trim()
      .slice(0, 2000);

    if (!text) {
      return fail(res, 400, 'bad_input');
    }

    const btnText = String(
      b.button_text || ''
    )
      .trim()
      .slice(0, 30);

    const btnUrl = String(
      b.button_url || ''
    ).trim();

    let keyboard = null;

    if (btnText && btnUrl) {
      if (!/^https?:\/\//.test(btnUrl)) {
        return fail(res, 400, 'bad_button_url');
      }

      keyboard = [{ text: btnText, url: btnUrl }];
    }

    broadcastAll(text, keyboard)
      .then((sent) =>
        console.log('broadcast sent to', sent)
      )
      .catch((e) =>
        console.error('broadcastAll', e)
      );

    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/daily-leaderboard/post',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const { rows } = await q(
      `SELECT username, first_name, daily_ads, daily_invite, daily_task
       FROM users
       WHERE daily_earn_day=CURRENT_DATE
         AND (daily_ads+daily_invite+daily_task) > 0
       ORDER BY (daily_ads+daily_invite+daily_task) DESC
       LIMIT 7`
    );

    if (!rows.length) {
      return fail(res, 404, 'no_earnings');
    }

    let text =
      "Today's top earners — Ads · Invite · Task · Total\n";

    rows.forEach((r, i) => {
      const name =
        '@' + (r.username || r.first_name || 'user');

      const total =
        Number(r.daily_ads) +
        Number(r.daily_invite) +
        Number(r.daily_task);

      text +=
        `${i + 1} ${name}   ${r.daily_ads}   ${r.daily_invite}   ${r.daily_task}   ${total} coins\n`;
    });

    text += '\nWork fast, earn fast!';

    const r = await tg('sendMessage', {
      chat_id: PROOF_CHANNEL,
      text
    });

    if (!r.ok) {
      console.error('daily leaderboard', r.description);
      return fail(res, 502, 'post_failed');
    }

    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/user',
  auth,
  adminOnly,
  ah(async (req, res) => {
    const {
      id,
      action
    } = req.body || {};

    if (action === 'unflag_all') {
      await q('UPDATE users SET flagged=false WHERE flagged');

      return res.json({ ok: true });
    }

    if (
      !/^\d+$/.test(
        String(id)
      )
    ) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    if (action === 'ban') {
      await banUserById(Number(id), 'Admin ban');

      return res.json({ ok: true });
    }

    if (action === 'unban') {
      await unbanUserById(Number(id));

      return res.json({ ok: true });
    }

    const sql = {
      flag:
        'UPDATE users SET flagged=true WHERE id=$1',

      unflag:
        'UPDATE users SET flagged=false WHERE id=$1'
    }[action];

    if (!sql) {
      return fail(
        res,
        400,
        'bad_input'
      );
    }

    await q(sql, [id]);

    res.json({
      ok: true
    });
  })
);

const tonUsdCache = { t: 0, v: 0 };

function availableMethods() {
  return Object.keys(WITHDRAW_METHODS).filter((m) =>
    ENABLED_METHODS.includes(m)
  );
}

let cryptoColsReady = null;

function ensureCryptoCols() {
  if (!cryptoColsReady) {
    cryptoColsReady = q(
      `ALTER TABLE withdrawals
         ADD COLUMN IF NOT EXISTS tx_hash text,
         ADD COLUMN IF NOT EXISTS paid_amount numeric,
         ADD COLUMN IF NOT EXISTS paid_asset text,
         ADD COLUMN IF NOT EXISTS pay_error text`
    ).catch((e) => {
      cryptoColsReady = null;
      throw e;
    });
  }

  return cryptoColsReady;
}

async function getTonUsd(S) {
  if (Date.now() - tonUsdCache.t < 300000 && tonUsdCache.v > 0) {
    return tonUsdCache.v;
  }

  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );

    const j = await r.json();
    const p = Number(j && j['the-open-network'] && j['the-open-network'].usd);

    if (p > 0) {
      tonUsdCache.t = Date.now();
      tonUsdCache.v = p;
      return p;
    }
  } catch (e) {
    console.error('ton price', e.message);
  }

  const fb = Number((S && S.ton_usd_price) || 0);

  if (fb > 0) return fb;

  throw new Error('TON price unavailable (set ton_usd_price in admin settings).');
}

async function cryptoQuote(w, S) {
  const etb = Number(w.etb);
  const fee = Number(S.withdraw_fee_percent || 0);
  const perUsd = Number(S.etb_per_usd || 0);

  if (!(perUsd > 0)) {
    throw new Error('Set etb_per_usd in admin settings first.');
  }

  const feeEtb = Math.round(etb * fee) / 100;
  const finalEtb = Math.round((etb - feeEtb) * 100) / 100;
  const usd = finalEtb / perUsd;

  if (w.method === 'bep20') {
    return {
      asset: 'USDT',
      amount: Math.floor(usd * 100) / 100,
      feeEtb,
      finalEtb,
      fee
    };
  }

  const price = await getTonUsd(S);

  return {
    asset: 'TON',
    amount: Math.floor((usd / price) * 10000) / 10000,
    feeEtb,
    finalEtb,
    fee
  };
}

async function payBep20(to, amount, onSent) {
  const { ethers } = require('ethers');

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(BSC_PRIVATE_KEY, provider);

  const usdt = new ethers.Contract(
    USDT_BSC,
    [
      'function transfer(address,uint256) returns (bool)',
      'function balanceOf(address) view returns (uint256)'
    ],
    wallet
  );

  const value = ethers.parseUnits(amount.toFixed(2), 18);

  const bal = await usdt.balanceOf(wallet.address);

  if (bal < value) {
    throw new Error('Not enough USDT in the BEP20 payout wallet.');
  }

  const tx = await usdt.transfer(to, value);

  await onSent(tx.hash);

  return { hash: tx.hash };
}

function b64ToHex(h) {
  return /^[0-9a-fA-F]{64}$/.test(h)
    ? h.toLowerCase()
    : Buffer.from(h, 'base64').toString('hex');
}

async function tonTxHashByMessage(msgHash) {
  for (let i = 0; i < 3; i++) {
    await sleepMs(1500);

    try {
      const r = await fetch(
        `https://toncenter.com/api/v3/transactionsByMessage?msg_hash=${msgHash}&direction=in&limit=1`,
        {
          headers: TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {},
          signal: AbortSignal.timeout(4000)
        }
      );

      const j = await r.json();
      const tx = j && j.transactions && j.transactions[0];

      if (tx && tx.hash) return b64ToHex(tx.hash);
    } catch (e) {
    }
  }

  return null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function payTon(to, amount, memo, onSent) {
  const {
    TonClient,
    WalletContractV4,
    WalletContractV5R1,
    internal,
    external,
    storeMessage,
    SendMode,
    Address,
    toNano,
    beginCell
  } = require('@ton/ton');

  const { mnemonicToPrivateKey } = require('@ton/crypto');

  const key = await mnemonicToPrivateKey(
    TON_MNEMONIC.trim().split(/\s+/)
  );

  const target = Address.parse(TON_WALLET_ADDRESS);

  const candidates = [];

  if (WalletContractV5R1) {
    candidates.push(
      WalletContractV5R1.create({ publicKey: key.publicKey, workchain: 0 })
    );
  }

  candidates.push(
    WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
  );

  const wallet = candidates.find((c) => c.address.equals(target));

  if (!wallet) {
    throw new Error(
      'TON_MNEMONIC does not belong to ' + TON_WALLET_ADDRESS + ' (payout refused).'
    );
  }

  const client = new TonClient({
    endpoint: TONCENTER_ENDPOINT,
    apiKey: TONCENTER_API_KEY || undefined
  });

  const contract = client.open(wallet);

  const value = toNano(amount.toFixed(4));
  const balance = await contract.getBalance();

  if (balance < value + toNano('0.05')) {
    throw new Error('Not enough TON in the payout wallet.');
  }

  const seqno = await contract.getSeqno();

  const transfer = contract.createTransfer({
    seqno,
    secretKey: key.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: Address.parse(to),
        value,
        bounce: false,
        body: memo
      })
    ]
  });

  await contract.send(transfer);

  const ext = external({
    to: wallet.address,
    init: seqno === 0 ? wallet.init : undefined,
    body: transfer
  });

  const msgHash = beginCell()
    .store(storeMessage(ext))
    .endCell()
    .hash()
    .toString('hex');

  await onSent(msgHash);

  const txHash = await tonTxHashByMessage(msgHash);

  return { hash: txHash || msgHash };
}

const explorerLink = (method, hash) =>
  method === 'bep20'
    ? `https://bscscan.com/tx/${hash}`
    : `https://tonviewer.com/transaction/${hash}`;

const shortAddr = (a) =>
  a.length > 16 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a;

async function approveCryptoWithdrawal(id, cq) {
  await ensureCryptoCols();

  const claim = await q(
    `UPDATE withdrawals
     SET status='processing', decided_at=now(), pay_error=NULL
     WHERE id=$1 AND status='pending' AND method = ANY($2)
     RETURNING *`,
    [id, CRYPTO_METHODS]
  );

  if (!claim.rowCount) {
    return { note: 'Already handled' };
  }

  const w = claim.rows[0];
  const S = await settings();

  try {
    const quote = await cryptoQuote(
      { etb: Number(w.etb), method: w.method },
      S
    );

    if (!(quote.amount > 0)) {
      throw new Error('Amount is too small to send.');
    }

    const onSent = (hash) =>
      q(
        `UPDATE withdrawals
         SET tx_hash=$2, paid_amount=$3, paid_asset=$4
         WHERE id=$1`,
        [w.id, hash, quote.amount, quote.asset]
      );

    const sent =
      w.method === 'bep20'
        ? await payBep20(w.account, quote.amount, onSent)
        : await payTon(w.account, quote.amount, `Adewa #${w.id}`, onSent);

    await q(
      `UPDATE withdrawals
       SET status='paid', tx_hash=$2, paid_amount=$3, paid_asset=$4,
           pay_error=NULL, decided_at=now()
       WHERE id=$1`,
      [w.id, sent.hash, quote.amount, quote.asset]
    );

    const link = explorerLink(w.method, sent.hash);
    const net = w.method === 'bep20' ? 'BEP20' : 'TON';

    await tg('sendMessage', {
      chat_id: w.user_id,
      text:
        `💸 Withdrawal paid\n` +
        `----------------\n` +
        `🌐 Network: ${net}\n` +
        `💵 Amount: ${quote.amount} ${quote.asset}\n` +
        `🔗 Hash: ${sent.hash}\n` +
        `🔍 Status: Paid\n` +
        `-------------------------------\n\n` +
        `🤖 Proof channel: ${PROOF_CHANNEL}`,
      reply_markup: {
        inline_keyboard: [[{ text: 'View transaction', url: link }]]
      }
    });

    const usr = (
      await q('SELECT first_name, username FROM users WHERE id=$1', [w.user_id])
    ).rows[0] || {};

    const who = '@' + (usr.username || usr.first_name || 'user');

    const proof = await tg('sendMessage', {
      chat_id: PROOF_CHANNEL,
      text:
        `💸 New Withdrawal Approved\n` +
        `----------------\n` +
        `👤 User: ${who}\n` +
        `🌐 Network: ${net} (${quote.asset})\n` +
        `📮 Address: ${shortAddr(w.account)}\n` +
        `💵 Requested Amount: ${Number(w.etb).toFixed(2)} Birr\n` +
        `📉 ${quote.fee}% Service Fee: ${quote.feeEtb.toFixed(2)} Birr\n` +
        `💰 Final Amount: ${quote.amount} ${quote.asset}\n` +
        `🔗 Hash: ${sent.hash}\n` +
        `🔍 Status: Paid\n` +
        `-------------------------------\n\n` +
        `🤖 Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : '-'}`,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: 'View on explorer', url: link }]]
      }
    });

    if (!proof.ok) {
      console.error('proof channel post', proof.description);

      await tg('sendMessage', {
        chat_id: cq.from.id,
        text: `Paid, but posting to the proof channel failed: ${proof.description}\nHash: ${sent.hash}`
      });
    }

    await tg('sendMessage', {
      chat_id: cq.from.id,
      text:
        `Withdrawal #${w.id} paid: ${quote.amount} ${quote.asset}\n` +
        `Hash: ${sent.hash}\n${link}`,
      disable_web_page_preview: true
    });

    return { note: '✅ Paid ' + quote.amount + ' ' + quote.asset };
  } catch (e) {
    console.error('crypto payout', w.id, e);

    const msg = String((e && e.message) || e).slice(0, 300);

    const cur = (
      await q('SELECT tx_hash FROM withdrawals WHERE id=$1', [w.id])
    ).rows[0];

    if (cur && cur.tx_hash) {
      await q('UPDATE withdrawals SET pay_error=$2 WHERE id=$1', [w.id, msg]);

      await tg('sendMessage', {
        chat_id: cq.from.id,
        text:
          `Withdrawal #${w.id}: the transfer was broadcast (hash ${cur.tx_hash}) ` +
          `but a later step failed: ${msg}\nCheck it on the explorer, do NOT pay again.`
      });

      return { note: '⚠️ Sent - check manually' };
    }

    await q(
      `UPDATE withdrawals SET status='pending', pay_error=$2 WHERE id=$1`,
      [w.id, msg]
    );

    await tg('sendMessage', {
      chat_id: cq.from.id,
      text:
        `Payout #${w.id} failed, nothing was sent:\n${msg}\n\n` +
        `It is still pending. Fix the problem and press Approve & Pay again.`
    });

    return { note: '❌ Payout failed', retry: true };
  }
}

let groupAddsReady = null;

function ensureGroupAdds() {
  if (!groupAddsReady) {
    groupAddsReady = q(
      `CREATE TABLE IF NOT EXISTS group_adds (
        chat_id BIGINT NOT NULL,
        member_id BIGINT NOT NULL,
        adder_id BIGINT NOT NULL,
        left_chat BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, member_id)
      )`
    )
      .then(() => q('CREATE INDEX IF NOT EXISTS group_adds_adder_idx ON group_adds (adder_id)'))
      .catch((e) => {
        groupAddsReady = null;
        throw e;
      });
  }

  return groupAddsReady;
}

async function countGroupAdds(userId, S) {
  if (!S.add_group_id) return 0;

  await ensureGroupAdds();

  const r = await q(
    'SELECT COUNT(*)::int AS c FROM group_adds WHERE adder_id=$1 AND chat_id=$2 AND NOT left_chat',
    [userId, S.add_group_id]
  );

  return r.rows[0].c;
}

async function trackGroupAdds(m, S) {
  if (!S.add_group_id) return;

  if (String(m.chat.id) !== String(S.add_group_id)) {
    if (m.new_chat_members) {
      console.log('group_add ignored: chat', m.chat.id, 'expected', S.add_group_id);
    }
    return;
  }

  await ensureGroupAdds();

  if (m.left_chat_member) {
    await q(
      'UPDATE group_adds SET left_chat=TRUE WHERE chat_id=$1 AND member_id=$2',
      [m.chat.id, m.left_chat_member.id]
    );
    return;
  }

  const adder = m.from;

  if (!adder || adder.is_bot) return;

  for (const nm of m.new_chat_members || []) {
    if (nm.is_bot || nm.id === adder.id) continue;

    await q(
      `INSERT INTO group_adds (chat_id, member_id, adder_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (chat_id, member_id) DO UPDATE
         SET left_chat=FALSE, adder_id=EXCLUDED.adder_id
         WHERE group_adds.left_chat`,
      [m.chat.id, nm.id, adder.id]
    );
  }
}

/* Channel buttons: 2 per row, style success, then the primary "Joined" button */
function channelKeyboard(S, chans) {
  const btns = chans.map((c) => {
    const i = channelInfo(S, c);
    return { text: '📢 ' + i.title, url: i.url, style: 'success' };
  });

  const rows = [];

  for (let k = 0; k < btns.length; k += 2) {
    rows.push(btns.slice(k, k + 2));
  }

  rows.push([{ text: '✅ Joined', callback_data: 'joined', style: 'primary' }]);

  return rows;
}

async function handleJoined(cq) {
  const S = await settings();
  const chans = gateChans(S);
  const uid = cq.from.id;
  const chatId = cq.message && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;

  await ensureUser(cq.from, null);

  const ban = (
    await q(
      `SELECT u.banned, f.status
       FROM users u LEFT JOIN fraud_users f ON f.telegram_id=u.id
       WHERE u.id=$1`,
      [uid]
    )
  ).rows[0];

  if (ban && (ban.banned || ban.status === 'banned')) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Your account has been banned.',
      show_alert: true
    });
    return;
  }

  const res = await Promise.all(
    chans.map(async (c) => ({ c, ok: await isChannelMember(c, uid) }))
  );

  const missing = res.filter((x) => !x.ok);

  if (missing.length) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `You still need to join ${missing.length} channel(s).`,
      show_alert: true
    });

    if (chatId) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text:
          'Step 1 - join all required channels:\n' +
          res.map((x) => (x.ok ? '✅ ' : '❌ ') + channelInfo(S, x.c).title).join('\n') +
          '\n\nThen press "Joined".',
        reply_markup: {
          inline_keyboard: channelKeyboard(
            S,
            res.filter((x) => !x.ok).map((x) => x.c)
          )
        }
      }).catch(() => {});
    }

    return;
  }

  await tg('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: 'All channels joined ✅'
  });

  if (chatId) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text:
        'All required channels joined ✅\n\n' +
        'Tap the button to open Adewa. Channels are checked again and your account ' +
        'is verified (VPN / multiple accounts) when the app opens.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Open Adewa', style: 'success', web_app: { url: MINI_APP_URL } }]
        ]
      }
    });
  }

  /* if the app was already verified, pay the inviter right away */
  await tryPayFullReferral(uid).catch(() => {});
}


async function handleUpdate(u) {
  if (u.message) {
    const m = u.message;
    const from = m.from;

    if (m.new_chat_members || m.left_chat_member) {
      await trackGroupAdds(m, await settings());
      return;
    }

    if (
      m.text &&
      m.text.startsWith('/start')
    ) {
      const r =
        /^ref_(\d+)$/.exec(
          m.text.split(' ')[1] ||
            ''
        );

      await ensureUser(
        from,
        r ? r[1] : null
      );

      const S0 = await settings();
      const supportLine = S0.support_bot_username
        ? `\n\nNeed help? Contact @${S0.support_bot_username}`
        : '';

          const chansS = gateChans(S0);

    if (chansS.length) {
      const lines = chansS.map((c) => '• ' + channelInfo(S0, c).title).join('\n');

      const who = from.first_name || from.username || 'friend';

      await tg('sendMessage', {
        chat_id: m.chat.id,
        text:
          `Hello ${who}, Welcome to Adewa mini bots\n\n` +
          (r ? 'You were invited by a friend.\n\n' : '') +
          'Join all the required channels below, then press "Joined".' +
          supportLine,
        reply_markup: {
          inline_keyboard: channelKeyboard(S0, chansS)
        }
      });

      return;
    }

    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: 'Welcome to Adewa. Tap the button to open the app.' + supportLine,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Open Adewa', style: 'success', web_app: { url: MINI_APP_URL } }]
        ]
      }
    });

    return;
    }

    /* /unflag [user_id]  - admin only (no id = your own account)
       /unflagall         - admin only: clears the review flag for everyone */
    if (
      m.text &&
      (m.text.startsWith('/unflagall') || m.text.startsWith('/unflag')) &&
      isAdmin(from.id)
    ) {
      let out;

      if (m.text.startsWith('/unflagall')) {
        const r = await q('UPDATE users SET flagged=false WHERE flagged');
        out = `Cleared review flag for ${r.rowCount} account(s).`;
      } else {
        const arg = (m.text.trim().split(/\s+/)[1] || '').trim();
        const uid = arg ? Number(arg) : from.id;

        if (!uid) {
          out = 'Usage: /unflag <user_id>  (no id = your own account)';
        } else {
          const r = await q('UPDATE users SET flagged=false WHERE id=$1', [uid]);
          out = r.rowCount
            ? `Account ${uid} is no longer under review.`
            : `User ${uid} not found.`;
        }
      }

      await tg('sendMessage', { chat_id: m.chat.id, text: out });

      return;
    }

    /* /addcredit <user_id> <count>  - admin only: manually credit group adds
       (for people who were added before the bot was in the group) */
    if (
      m.text &&
      m.text.startsWith('/addcredit') &&
      isAdmin(from.id)
    ) {
      const parts = m.text.trim().split(/\s+/);
      const uid = Number(parts[1]);
      const n = Math.min(Math.max(parseInt(parts[2], 10) || 0, 0), 100);
      const Sc = await settings();

      let out;

      if (!Sc.add_group_id) {
        out = 'Group chat id is not set in Admin > Settings.';
      } else if (!uid || !n) {
        out = 'Usage: /addcredit <user_id> <count>';
      } else {
        await ensureGroupAdds();

        const base = Date.now() * 1000;

        for (let i = 0; i < n; i++) {
          await q(
            `INSERT INTO group_adds (chat_id, member_id, adder_id)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [Sc.add_group_id, -(base + i), uid]
          );
        }

        out = `Credited ${n} group add(s) to ${uid}. Now counted: ${await countGroupAdds(uid, Sc)}`;
      }

      await tg('sendMessage', { chat_id: m.chat.id, text: out });

      return;
    }

    if (
      m.text &&
      m.text.startsWith('/checkgroup') &&
      isAdmin(from.id)
    ) {
      const Sg = await settings();
      const gid = Sg.add_group_id || '';

      const lines = [
        `Configured group id: ${gid || '(not set)'}`,
        `This chat id: ${m.chat.id}`,
        `Required adds: ${Number(Sg.withdraw_adds_required || 0)}`
      ];

      if (gid) {
        await ensureGroupAdds();

        const me = await tg('getMe', {});
        const cm = me.ok
          ? await tg('getChatMember', { chat_id: gid, user_id: me.result.id })
          : null;

        lines.push(
          cm && cm.ok
            ? `Bot status in the group: ${cm.result.status}`
            : `Bot cannot see the group: ${cm ? cm.description : 'getMe failed'}`
        );

        const tot = await q(
          'SELECT COUNT(*)::int AS c FROM group_adds WHERE chat_id=$1',
          [gid]
        );

        lines.push(`Adds recorded in total: ${tot.rows[0].c}`);
        lines.push(`Adds counted for you: ${await countGroupAdds(from.id, Sg)}`);
      }

      if (m.chat.type !== 'private' && String(m.chat.id) !== String(gid)) {
        lines.push('WARNING: this chat id does not match the configured group id.');
      }

      await tg('sendMessage', { chat_id: m.chat.id, text: lines.join('\n') });

      return;
    }

    if (
      m.text &&
      (m.text.startsWith('/ban ') || m.text.startsWith('/unban ')) &&
      isAdmin(from.id)
    ) {
      const cmd = m.text.split(' ')[0].split('@')[0];
      const target = Number(m.text.split(' ')[1]);

      if (!Number.isFinite(target)) {
        await tg('sendMessage', {
          chat_id: from.id,
          text: `Usage: ${cmd} <telegram_id>`
        });

        return;
      }

      if (cmd === '/ban') {
        await banUserById(target, 'Admin ban');

        await tg('sendMessage', {
          chat_id: from.id,
          text: `User ${target} has been banned.`
        });
      } else {
        const done = await unbanUserById(target);

        await tg('sendMessage', {
          chat_id: from.id,
          text: done
            ? `User ${target} has been unbanned.`
            : `User ${target} was not found.`
        });
      }

      return;
    }

    if (
      m.text === '/skip' &&
      isAdmin(from.id)
    ) {
      await q(
        `DELETE FROM settings
         WHERE key='awaiting_proof'`
      );

      await tg(
        'sendMessage',
        {
          chat_id: from.id,
          text: 'Skipped.'
        }
      );

      return;
    }

    if (
      m.text === '/topearners' &&
      isAdmin(from.id)
    ) {
      const { rows } = await q(
        `SELECT
          username,
          first_name,
          daily_ads,
          daily_invite,
          daily_task
         FROM users
         WHERE daily_earn_day=CURRENT_DATE
           AND (daily_ads+daily_invite+daily_task) > 0
         ORDER BY (daily_ads+daily_invite+daily_task) DESC
         LIMIT 7`
      );

      if (!rows.length) {
        await tg('sendMessage', {
          chat_id: from.id,
          text: 'No earnings recorded yet today.'
        });

        return;
      }

      let text =
        "Today's top earners — Ads · Invite · Task · Total\n";

      rows.forEach((r, i) => {
        const name =
          '@' + (r.username || r.first_name || 'user');

        const total =
          Number(r.daily_ads) +
          Number(r.daily_invite) +
          Number(r.daily_task);

        text +=
          `${i + 1} ${name}        ${r.daily_ads}        ${r.daily_invite}       ${r.daily_task}         ${total} Birr \n`;
      });

      text += '\nWork fast, earn fast!';

      await tg('sendMessage', {
        chat_id: PROOF_CHANNEL,
        text
      });

      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Posted to the proof channel.'
      });

      return;
    }

    if (
      m.text &&
      m.text.startsWith('/broadcast ') &&
      isAdmin(from.id)
    ) {
      const raw = m.text
        .slice('/broadcast '.length)
        .trim();

      const parts = raw.split('||').map((p) => p.trim());
      const text = parts[0];
      let keyboard = null;

      if (parts.length >= 3 && parts[1] && parts[2]) {
        if (/^https?:\/\//.test(parts[2])) {
          keyboard = [{ text: parts[1].slice(0, 30), url: parts[2] }];
        } else {
          await tg('sendMessage', {
            chat_id: from.id,
            text: 'Button URL must start with http:// or https://. Broadcast not sent.'
          });

          return;
        }
      }

      if (text) {
        broadcastAll(text, keyboard).catch((e) =>
          console.error('broadcastAll', e)
        );

        await tg('sendMessage', {
          chat_id: from.id,
          text: 'Broadcast started.'
        });
      }

      return;
    }

    if (
      m.text &&
      m.text.startsWith('/setfaq ') &&
      isAdmin(from.id)
    ) {
      const text = m.text
        .slice('/setfaq '.length)
        .trim();

      if (text) {
        await q(
          `INSERT INTO settings(key, value)
           VALUES('faq_knowledge', $1)
           ON CONFLICT(key)
           DO UPDATE SET value=$1`,
          [JSON.stringify(text)]
        );

        sCache.t = 0;

        await tg('sendMessage', {
          chat_id: from.id,
          text: 'FAQ knowledge updated.'
        });
      }

      return;
    }

    if (
      (m.text === '/faqon' ||
        m.text === '/faqoff') &&
      isAdmin(from.id)
    ) {
      const enabled = m.text === '/faqon';

      await q(
        `INSERT INTO settings(key, value)
         VALUES('faq_bot_enabled', $1)
         ON CONFLICT(key)
         DO UPDATE SET value=$1`,
        [JSON.stringify(enabled)]
      );

      sCache.t = 0;

      await tg('sendMessage', {
        chat_id: from.id,
        text: enabled
          ? 'AI FAQ auto-reply is ON.'
          : 'AI FAQ auto-reply is OFF.'
      });

      return;
    }

    if (
      m.text &&
      !m.text.startsWith('/')
    ) {
      const S = await settings();

      if (S.faq_bot_enabled === false) {
        return;
      }

      await tg('sendChatAction', {
        chat_id: m.chat.id,
        action: 'typing'
      });

      const knowledge =
        S.faq_knowledge || DEFAULT_FAQ_KNOWLEDGE;

      const answer = await askFAQAI(
        m.text,
        knowledge
      );

      await tg('sendMessage', {
        chat_id: m.chat.id,
        text:
          answer ||
          'Thanks for your message — an admin will reply soon. / አመሰግናለሁ፣ አድሚን በቅርቡ ይመልስልዎታል።'
      });

      if (!answer) {
        for (const adminId of ADMIN_IDS) {
          await tg('sendMessage', {
            chat_id: adminId,
            text:
              `❓ Unanswered question from ${from.first_name || 'user'} (ID: ${from.id}):\n${m.text}`
          });
        }
      }

      return;
    }

    if (m.photo) {
      const fileId =
        m.photo[
          m.photo.length - 1
        ].file_id;

      if (isAdmin(from.id)) {
        const a = (
          await q(
            `SELECT value
             FROM settings
             WHERE key='awaiting_proof'`
          )
        ).rows[0];

        if (
          a &&
          a.value &&
          a.value.wid
        ) {
          const w = (
            await q(
              `SELECT
                w.etb,
                w.method,
                w.account,
                u.first_name,
                u.username
               FROM withdrawals w
               JOIN users u
                 ON u.id=w.user_id
               WHERE w.id=$1`,
              [a.value.wid]
            )
          ).rows[0];

          if (w) {
            const S = await settings();

            await tg(
              'sendPhoto',
              {
                chat_id:
                  PROOF_CHANNEL,
                photo: fileId,
                caption: buildProofCaption(
                  {
                    ...w,
                    etb: Number(w.etb)
                  },
                  Number(
                    S.withdraw_fee_percent || 3
                  )
                )
              }
            );
          }

          await q(
            `DELETE FROM settings
             WHERE key='awaiting_proof'`
          );

          await tg(
            'sendMessage',
            {
              chat_id: from.id,
              text:
                'Posted to the proof channel.'
            }
          );

          return;
        }
      }

      const s = (
        await q(
          `SELECT
            s.id,
            t.title,
            t.reward
           FROM task_subs s
           JOIN tasks t
             ON t.id=s.task_id
           WHERE s.user_id=$1
             AND s.status='awaiting'
           ORDER BY s.id DESC
           LIMIT 1`,
          [from.id]
        )
      ).rows[0];

      if (!s) {
        await tg(
          'sendMessage',
          {
            chat_id: from.id,
            text:
              'Open the app, choose a task, then send your screenshot here.'
          }
        );

        return;
      }

      await q(
        `UPDATE task_subs
         SET status='pending'
         WHERE id=$1`,
        [s.id]
      );

      for (const adminId of ADMIN_IDS) {
        await tg(
          'sendPhoto',
          {
            chat_id: adminId,
            photo: fileId,
            caption:
              `New task proof\n` +
              `User: ${from.first_name} (ID: ${from.id})\n` +
              `Task: ${s.title} (${s.reward} coins)`,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Approve',
                    style: 'success',
                    callback_data:
                      `t:a:${s.id}`
                  },
                  {
                    text: '❌ Reject',
                    style: 'danger',
                    callback_data:
                      `t:r:${s.id}`
                  }
                ]
              ]
            }
          }
        );
      }

      await tg(
        'sendMessage',
        {
          chat_id: from.id,
          text:
            'Screenshot received. An admin will review it soon.'
        }
      );
    }

    return;
  }

  if (u.callback_query) {
    const cq =
      u.callback_query;

    console.log(
      'callback_query received:',
      'from=' + cq.from.id,
      'data=' + cq.data,
      'isAdmin=' + isAdmin(cq.from.id)
    );

    if (cq.data === 'joined') {
      await handleJoined(cq).catch((e) => console.error('joined', e));
      return;
    }

    if (!isAdmin(cq.from.id)) {
      console.log(
        'callback rejected: sender is not in ADMIN_IDS',
        cq.from.id
      );

      await tg(
        'answerCallbackQuery',
        {
          callback_query_id:
            cq.id
        }
      );

      return;
    }

    try {

    const [
      kind,
      act,
      id
    ] = String(
      cq.data
    ).split(':');

    let note = 'Done';
    let skipEdit = false;

    if (kind === 't') {
      if (act === 'a') {
        const r = await q(
          `UPDATE task_subs
           SET status='approved'
           WHERE id=$1
             AND status='pending'
           RETURNING
             task_id,
             user_id`,
          [id]
        );

        console.log(
          'task approve: id=' + id,
          'rowCount=' + r.rowCount
        );

        if (r.rowCount) {
          const tk = (
            await q(
              `SELECT
                reward,
                title
               FROM tasks
               WHERE id=$1`,
              [
                r.rows[0]
                  .task_id
              ]
            )
          ).rows[0];

          await q(
            `UPDATE users
             SET coins=coins+$2,
                 daily_ads =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_ads ELSE 0 END,
                 daily_invite =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_invite ELSE 0 END,
                 daily_task =
                   CASE WHEN daily_earn_day=CURRENT_DATE
                     THEN daily_task+$2 ELSE $2 END,
                 daily_earn_day=CURRENT_DATE
             WHERE id=$1`,
            [
              r.rows[0].user_id,
              tk.reward
            ]
          );

          await finishTask(
            r.rows[0].task_id
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `Task approved: ${tk.title}. You earned ${tk.reward} coins.`
            }
          );

          note = '✅ Approved';
        } else {
          note =
            'Already handled';
        }
      } else {
        const r = await q(
          `UPDATE task_subs
           SET status='rejected'
           WHERE id=$1
             AND status='pending'
           RETURNING user_id`,
          [id]
        );

        if (r.rowCount) {
          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                'Your task proof was rejected. Open the app to try again.'
            }
          );

          note = '❌ Rejected';
        } else {
          note =
            'Already handled';
        }
      }
    }

    else if (kind === 'w') {
      const wrow = (
        await q('SELECT method FROM withdrawals WHERE id=$1', [id])
      ).rows[0];

      if (
        act === 'a' &&
        wrow &&
        CRYPTO_METHODS.includes(wrow.method)
      ) {
        const out = await approveCryptoWithdrawal(id, cq);

        note = out.note;
        skipEdit = !!out.retry;
      } else if (act === 'a') {
        const r = await q(
          `UPDATE withdrawals
           SET status='paid',
               decided_at=now()
           WHERE id=$1
             AND status='pending'
           RETURNING
             user_id,
             etb`,
          [id]
        );

        if (r.rowCount) {
          await q(
            `INSERT INTO settings(
              key,
              value
            )
            VALUES(
              'awaiting_proof',
              $1
            )
            ON CONFLICT(key)
            DO UPDATE SET
              value=$1`,
            [
              JSON.stringify({
                wid: Number(id)
              })
            ]
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `💸 New Withdrawal requests accepted \n` +
                `----------------\n` +
                `💵 Amount: ${Number(r.rows[0].etb).toFixed(2)} Birr\n` +
                `🔍 Status: Paid \n` +
                `-------------------------------\n\n` +
                `🤖 Proof channel: ${PROOF_CHANNEL}`
            }
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                cq.from.id,
              text:
                'Send the payment screenshot now to post it in the proof channel, or send /skip.'
            }
          );

          note =
            '✅ Marked as paid';
        } else {
          note =
            'Already handled';
        }
      } else {
        const r = await q(
          `UPDATE withdrawals
           SET status='rejected',
               decided_at=now()
           WHERE id=$1
             AND status='pending'
           RETURNING
             user_id,
             coins,
             etb,
             method,
             from_ads,
             from_invite`,
          [id]
        );

        if (r.rowCount) {
          await q(
            `UPDATE users
             SET coins=coins+$2,
                 ads_coins=ads_coins+$3,
                 invite_coins=invite_coins+$4,
                 last_withdraw_at=NULL
             WHERE id=$1`,
            [
              r.rows[0].user_id,
              r.rows[0].coins,
              r.rows[0].from_ads,
              r.rows[0].from_invite
            ]
          );

          await tg(
            'sendMessage',
            {
              chat_id:
                r.rows[0].user_id,
              text:
                `💸 New Withdrawal requests rejected \n` +
                `----------------\n` +
                `💵 Requested Amount: ${Number(r.rows[0].etb).toFixed(2)} Birr\n` +
                `        Reback to Your balance \n` +
                `🔍 Status: Rejected`
            }
          );

          note =
            '❌ Rejected and refunded';
        } else {
          note =
            'Already handled';
        }
      }
    }

    await tg(
      'answerCallbackQuery',
      {
        callback_query_id:
          cq.id,
        text: note
      }
    );

    if (cq.message && !skipEdit) {
      await tg(
        'editMessageReplyMarkup',
        {
          chat_id:
            cq.message.chat.id,
          message_id:
            cq.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: note,
                  callback_data:
                    'noop'
                }
              ]
            ]
          }
        }
      );
    }

    } catch (e) {
      console.error('callback_query error:', e);

      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Error: ' + String(e.message || e).slice(0, 190),
        show_alert: true
      }).catch(() => {});
    }
  }
}

const cronAuth = (req, res, next) =>
  CRON_SECRET &&
  req.headers['x-cron-key'] === CRON_SECRET
    ? next()
    : fail(res, 403, 'cron_forbidden');

app.all(
  '/api/cron/streak-reminder',
  cronAuth,
  ah(async (req, res) => {
    const t = todayStr();

    const { rows } = await q(
      `SELECT id, lang, streak
       FROM users
       WHERE NOT banned
         AND streak > 0
         AND last_checkin::text <> $1
         AND last_checkin::text =
           (
             $1::date - 1
           )::text`,
      [t]
    );

    for (const u of rows) {
      await tg('sendMessage', {
        chat_id: u.id,
        text: `🔥 Your ${u.streak}-day streak will be lost if you don't check in today! Open the app now.`
      }).catch(() => {});

      await new Promise((r) =>
        setTimeout(r, 40)
      );
    }

    res.json({
      ok: true,
      notified: rows.length
    });
  })
);

app.all(
  '/api/cron/weekly-rewards',
  cronAuth,
  ah(async (req, res) => {
    const S = await settings();

    const result = {
      top_inviter: null,
      top_ad_watcher: null
    };

    const minInvites = Number(
      S.weekly_top_inviter_min || 200
    );

    const bonusEtb = Number(
      S.weekly_top_inviter_bonus_etb || 0
    );

    const inviter = (
      await q(
        `SELECT
          u.id,
          COUNT(*)::int AS invites
         FROM users ref
         JOIN users u
           ON u.id=ref.referred_by
         WHERE ref.referral_paid
           AND ref.created_at >
             now() - interval '7 days'
         GROUP BY u.id
         HAVING COUNT(*) >= $1
         ORDER BY invites DESC
         LIMIT 1`,
        [minInvites]
      )
    ).rows[0];

    if (inviter && bonusEtb > 0) {
      const bonusCoins = Math.round(
        bonusEtb *
          Number(S.coin_per_etb || 1)
      );

      await q(
        `UPDATE users
         SET coins=coins+$2
         WHERE id=$1`,
        [inviter.id, bonusCoins]
      );

      await tg('sendMessage', {
        chat_id: inviter.id,
        text:
          `🏆 You were this week's top inviter (${inviter.invites} invites)! ` +
          `Bonus: ${bonusEtb} ETB (${bonusCoins} coins) has been added to your balance.`
      }).catch(() => {});

      result.top_inviter = inviter;
    }

    const watcher = (
      await q(
        `SELECT
          u.id,
          COUNT(*)::int AS ads
         FROM ad_views a
         JOIN users u
           ON u.id=a.user_id
         WHERE a.completed
           AND a.started_at >
             now() - interval '7 days'
         GROUP BY u.id
         ORDER BY ads DESC
         LIMIT 1`
      )
    ).rows[0];

    if (watcher) {
      await q(
        `UPDATE users
         SET vip_unlimited_until=
           now() + interval '7 days'
         WHERE id=$1`,
        [watcher.id]
      );

      await tg('sendMessage', {
        chat_id: watcher.id,
        text:
          `🏆 You watched the most ads this week (${watcher.ads})! ` +
          `You now have unlimited ads for the next 7 days.`
      }).catch(() => {});

      result.top_ad_watcher = watcher;
    }

    res.json({
      ok: true,
      ...result
    });
  })
);

app.post(
  '/api/webhook',
  async (req, res) => {
    if (
      WEBHOOK_SECRET &&
      req.headers[
        'x-telegram-bot-api-secret-token'
      ] !== WEBHOOK_SECRET
    ) {
      return res.sendStatus(403);
    }

    try {
      await handleUpdate(
        req.body || {}
      );
    } catch (e) {
      console.error(
        'webhook',
        e
      );
    }

    res.sendStatus(200);
  }
);

module.exports = app;

if (require.main === module) {
  app.listen(
    process.env.PORT || 3000,
    () => {
      console.log(
        `Adewa server running on port ${
          process.env.PORT || 3000
        }`
      );
    }
  );
  }
