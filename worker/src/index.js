// ============================================================
// Telegram Stars Shop — Cloudflare Worker
// Интеграция: Telegram Stars + Digiseller (Plati.Market)
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org';
const DIGISELLER_API = 'https://api.digiseller.ru/api';

// ---------- Утилиты ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Аутентификация Digiseller ----------

async function getDigisellerToken(env) {
  const timestamp = Date.now().toString();
  const sign = await sha256(env.DIGISELLER_API_KEY + timestamp);

  const res = await fetch(`${DIGISELLER_API}/apilogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seller_id: parseInt(env.DIGISELLER_SELLER_ID, 10),
      timestamp: parseInt(timestamp, 10),
      sign: sign,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Digiseller auth error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  if (data.retval !== 0) {
    throw new Error(`Digiseller auth failed: ${data.desc}`);
  }
  return data.token;
}

// ---------- Каталог товаров ----------

async function getDigisellerCatalog(env) {
  const token = await getDigisellerToken(env);
  const sellerId = env.DIGISELLER_SELLER_ID;

  const url = `${DIGISELLER_API}/products/search2?pagesize=100&owner=${sellerId}&token=${token}`;
  const res = await fetch(url);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Digiseller catalog error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.products || data.items || [];
}

// ---------- Наценка ----------

function applyMarkup(basePrice, markupPercent) {
  const pct = parseFloat(markupPercent) || 0;
  return Math.ceil(basePrice * (1 + pct / 100));
}

// ---------- Telegram Bot API ----------

async function tgRequest(env, method, payload) {
  const url = `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ============================================================
// Основной обработчик
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleOptions();

    // ---------- API: Каталог ----------
    if (url.pathname === '/api/catalog' && request.method === 'GET') {
      try {
        const products = await getDigisellerCatalog(env);
        const items = products.map(p => ({
          id: p.id,
          sku: String(p.id),
          name: p.name,
          description: p.description || '',
          image: p.image || '',
          price: applyMarkup(p.price, env.SUPPLIER_MARKUP_PERCENT),
          supplierPrice: p.price,
        }));
        return json({ items });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- API: Создание инвойса Stars ----------
    if (url.pathname === '/api/create-invoice' && request.method === 'POST') {
      try {
        const { sku, name, price, telegramUserId } = await request.json();

        if (!sku || !name || !price || !telegramUserId) {
          return json({ error: 'Missing required fields' }, 400);
        }

        const invoiceLink = await tgRequest(env, 'createInvoiceLink', {
          title: name,
          description: `Покупка цифрового товара: ${name}`,
          payload: JSON.stringify({ sku, telegramUserId }),
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: name, amount: price }],
        });

        if (!invoiceLink.ok) {
          return json({ error: invoiceLink.description || 'Invoice creation failed' }, 500);
        }
        return json({ invoiceLink: invoiceLink.result });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Вебхук Telegram ----------
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
      } catch (e) { /* ignore */ }
      return json({ ok: true });
    }

    // ---------- Внешний источник выдачи Digiseller ----------
    if (url.pathname === '/api/deliver' && request.method === 'POST') {
      try {
        const data = await request.json();
        // Digiseller запрашивает код у внешнего источника
        // Возвращаем информацию о товаре (код будет выдан платформой)
        return json({
          retval: 0,
          desc: '',
          // Здесь можно добавить логику получения кода от поставщика
        });
      } catch (e) {
        return json({ retval: -1, desc: e.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ============================================================
// Обработка обновлений Telegram
// ============================================================

async function handleTelegramUpdate(update, env) {
  // Pre-checkout (обязательно ответить за 10 секунд)
  if (update.pre_checkout_query) {
    await tgRequest(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: true,
    });
    return;
  }

  // Успешная оплата
  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const chatId = update.message.chat.id;

    let payload;
    try {
      payload = JSON.parse(payment.invoice_payload);
    } catch { return; }

    const { sku } = payload;

    try {
      // Получаем токен Digiseller и информацию о заказе
      const token = await getDigisellerToken(env);

      // Информация о покупке для выдачи
      // Digiseller автоматически выдаст товар через внешний источник
      await tgRequest(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ *Оплата прошла успешно!*\n\n🎁 Товар будет выдан автоматически.\n\nНомер заказа: \`${sku}\``,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      await tgRequest(env, 'sendMessage', {
        chat_id: chatId,
        text: `⚠️ Оплата прошла, но возникла задержка с выдачей. Мы уже работаем над этим.`,
      });
    }
    return;
  }

  // Команда /start
  if (update.message?.text === '/start') {
    const chatId = update.message.chat.id;
    await tgRequest(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Добро пожаловать в Digital Stars Shop! Откройте магазин:',
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: env.WEBAPP_URL } }]],
      },
    });
  }
}
