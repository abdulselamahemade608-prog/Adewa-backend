const tg = window.Telegram.WebApp;

tg.ready();
tg.expand();

const API = "/api";

let balance = 0;

const balanceElement = document.getElementById("balance");
const claimBtn = document.getElementById("claimBtn");
const withdrawBtn = document.getElementById("withdrawBtn");
const walletInput = document.getElementById("wallet");
const amountInput = document.getElementById("amount");
const statusElement = document.getElementById("status");

const telegramUser = tg.initDataUnsafe?.user;

if (!telegramUser) {
  statusElement.textContent = "Open this app from Telegram.";
  claimBtn.disabled = true;
  withdrawBtn.disabled = true;
}

function showStatus(message) {
  statusElement.textContent = message;
}

function updateBalance() {
  balanceElement.textContent = balance.toFixed(4);
}

claimBtn.addEventListener("click", async () => {

  claimBtn.disabled = true;
  showStatus("Claiming...");

  try {

    const response = await fetch(`${API}`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        action: "claim",
        telegramId: telegramUser.id
      })
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Claim failed");
    }

    balance += Number(data.reward);

    updateBalance();

    showStatus(`+$${Number(data.reward).toFixed(4)}`);

  } catch (error) {

    showStatus(error.message);

  } finally {

    claimBtn.disabled = false;

  }
});


withdrawBtn.addEventListener("click", async () => {

  const wallet = walletInput.value.trim();
  const amount = Number(amountInput.value);

  if (!wallet) {
    showStatus("Enter your BEP20 address.");
    return;
  }

  if (!amount || amount <= 0) {
    showStatus("Enter a valid amount.");
    return;
  }

  if (amount > balance) {
    showStatus("Insufficient balance.");
    return;
  }

  withdrawBtn.disabled = true;
  showStatus("Creating withdrawal request...");

  try {

    const response = await fetch(`${API}`, {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        action: "withdraw",
        telegramId: telegramUser.id,
        wallet,
        amount
      })
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Withdrawal failed");
    }

    balance -= amount;

    updateBalance();

    showStatus("Withdrawal request created.");

    walletInput.value = "";
    amountInput.value = "";

  } catch (error) {

    showStatus(error.message);

  } finally {

    withdrawBtn.disabled = false;

  }
});

updateBalance();
