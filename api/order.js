const crypto = require('crypto');

// Vérifie que la commande vient bien de Telegram (et pas d'un robot malveillant)
function checkTelegramAuth(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      pairs.push(`${key}=${value}`);
    }
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return computedHash === hash;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  const { items, total, initData } = req.body || {};
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!BOT_TOKEN || !OWNER_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'Configuration manquante (variables d\'environnement)' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'Panier vide' });
  }

  const isValid = checkTelegramAuth(initData, BOT_TOKEN);
  if (!isValid) {
    return res.status(401).json({ ok: false, error: 'Authentification Telegram invalide' });
  }

  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  const user = userJson ? JSON.parse(userJson) : {};

  let text = `🛍 *Nouvelle commande*\n\n`;
  text += `👤 ${(user.first_name || '') + ' ' + (user.last_name || '')}`.trim();
  if (user.username) text += ` (@${user.username})`;
  text += `\nID Telegram : \`${user.id}\`\n\n`;
  items.forEach(it => {
    text += `• ${it.name} x${it.qty} — ${(it.price * it.qty).toFixed(2)} €\n`;
  });
  text += `\n💰 *Total : ${Number(total).toFixed(2)} €*`;

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: OWNER_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    })
  });
  const tgData = await tgRes.json();

  if (!tgData.ok) {
    return res.status(500).json({ ok: false, error: tgData.description });
  }

  return res.status(200).json({ ok: true });
};
