const REWARD = 0.0001;

function send(res, status, data) {
  res.status(status).json(data);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return send(res, 200, {
      ok: true,
      app: "Claim Mini App",
      reward: REWARD
    });
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const { action, telegramId, wallet, amount } = req.body || {};

  if (!telegramId) {
    return send(res, 400, {
      ok: false,
      error: "Telegram ID is required"
    });
  }

  /*
   * TEMPORARY SERVER LOGIC.
   *
   * The actual Nano.tech database connection will be added
   * after you provide your Nano.tech connection/API details.
   */

  if (action === "claim") {
    return send(res, 200, {
      ok: true,
      reward: REWARD,
      message: "Claim recorded"
    });
  }

  if (action === "withdraw") {
    if (!wallet) {
      return send(res, 400, {
        ok: false,
        error: "BEP20 address is required"
      });
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return send(res, 400, {
        ok: false,
        error: "Invalid BEP20 address"
      });
    }

    if (!amount || Number(amount) <= 0) {
      return send(res, 400, {
        ok: false,
        error: "Invalid amount"
      });
    }

    return send(res, 200, {
      ok: true,
      status: "pending",
      amount: Number(amount),
      wallet,
      message: "Withdrawal request created"
    });
  }

  return send(res, 400, {
    ok: false,
    error: "Unknown action"
  });
}
