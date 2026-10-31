const crypto = require('crypto');

// ------------------------------------------------------------------
// Catalogue de référence côté serveur : SEULE source de vérité pour les prix.
// Doit rester synchronisé avec PRODUCTS dans index.html.
// Le client n'envoie que { id, g, qty } : jamais de prix ni de total.
// ------------------------------------------------------------------
const CATALOG = new Map([
  ['lemon',          { name: 'Lemon Scent',    prices: new Map([[3, 30], [5, 50], [10, 100]]) }],
  ['fleur-premium',  { name: 'Fleur Premium',  prices: new Map([[3, 36], [5, 60], [10, 110]]) }],
  ['resine-classic', { name: 'Résine Classic', prices: new Map([[1, 12], [3, 30], [5, 45]]) }],
  ['resine-premium', { name: 'Résine Premium', prices: new Map([[1, 14], [3, 36], [5, 55]]) }],
]);

const MAX_LINES = 20;         // nombre de lignes distinctes par commande
const MAX_QTY_PER_LINE = 20;  // quantité max par ligne
const MAX_QTY_TOTAL = 50;     // quantité max par commande
const MAX_AUTH_AGE_S = 3600;  // initData accepté pendant 1 h après son émission
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_ORDERS = 5;    // par utilisateur et par fenêtre (best effort : mémoire d'instance)
const TELEGRAM_TIMEOUT_MS = 8000;

const recentOrders = new Map(); // user.id -> [timestamps]

function rateLimited(userId) {
  const now = Date.now();
  const hits = (recentOrders.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_ORDERS) {
    recentOrders.set(userId, hits);
    return true;
  }
  hits.push(now);
  recentOrders.set(userId, hits);
  return false;
}

// Vérifie la signature Telegram et la fraîcheur de auth_date. Renvoie l'utilisateur ou null.
function verifyInitData(initData, botToken) {
  try {
    if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
    const given = Buffer.from(hash, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || now - authDate > MAX_AUTH_AGE_S || authDate - now > 60) return null;

    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isInteger(user.id)) return null;
    return user;
  } catch (e) {
    return null;
  }
}

// Valide le panier et recalcule le total côté serveur. Renvoie { lines, total } ou null.
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) return null;

  const merged = new Map(); // "id|g" -> qty
  for (const it of items) {
    if (!it || typeof it !== 'object') return null;
    const product = CATALOG.get(it.id);
    if (!product) return null;
    if (!Number.isInteger(it.g) || !product.prices.has(it.g)) return null;
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_PER_LINE) return null;

    const key = `${it.id}|${it.g}`;
    merged.set(key, (merged.get(key) || 0) + it.qty);
  }

  let totalQty = 0;
  let total = 0;
  const lines = [];
  for (const [key, qty] of merged) {
    const [id, gStr] = key.split('|');
    const g = Number(gStr);
    const product = CATALOG.get(id);
    const unit = product.prices.get(g);
    totalQty += qty;
    total += unit * qty;
    lines.push({ name: `${product.name} ${g} g`, qty, lineTotal: unit * qty });
  }
  if (totalQty > MAX_QTY_TOTAL) return null;
  return { lines, total };
}

// Texte brut, sans retours à la ligne ni caractères de contrôle, tronqué.
function clean(value, max = 64) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const eur = n => n.toFixed(2).replace('.', ',') + ' €';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  if (!BOT_TOKEN || !OWNER_CHAT_ID) {
    console.error('Variables BOT_TOKEN / OWNER_CHAT_ID manquantes');
    return res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const user = verifyInitData(body.initData, BOT_TOKEN);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Session expirée ou invalide. Rouvre la boutique et réessaie.' });
    }

    const cart = priceCart(body.items);
    if (!cart) {
      return res.status(400).json({ ok: false, error: 'Panier invalide. Vérifie ta commande.' });
    }

    if (rateLimited(user.id)) {
      return res.status(429).json({ ok: false, error: 'Trop de commandes en peu de temps. Réessaie plus tard.' });
    }

    const fullName = clean(`${user.first_name || ''} ${user.last_name || ''}`, 100) || 'Client';
    const username = user.username ? clean(user.username, 40) : '';

    // Message simple, en texte brut (pas de Markdown ni HTML)
    let text = 'Nouvelle commande\n\n';
    text += `${fullName}${username ? ` (@${username})` : ''}\n`;
    text += `ID : ${user.id}\n\n`;
    for (const l of cart.lines) {
      text += `${l.name} x${l.qty} : ${eur(l.lineTotal)}\n`;
    }
    text += `\nTotal : ${eur(cart.total)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    let tgData;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text }),
        signal: controller.signal
      });
      tgData = await tgRes.json();
    } finally {
      clearTimeout(timer);
    }

    if (!tgData || !tgData.ok) {
      console.error('Echec sendMessage Telegram :', tgData && tgData.description);
      return res.status(500).json({ ok: false, error: 'Erreur serveur' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Erreur commande :', e && e.message);
    return res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
