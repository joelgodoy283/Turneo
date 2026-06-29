const axios = require('axios');
const { saveMessage, isPaused, pauseContact, getConfig, setConfig } = require('../database/db');
const { processMessage } = require('../ai/openrouter');

const GRAPH = 'https://graph.facebook.com/v20.0';

const HUMAN_TRIGGERS = [
  'hablar con una persona', 'quiero un humano', 'humano', 'persona real',
  'agente humano', 'quiero hablar con alguien', 'hablar con alguien',
];

// ─── Estado ────────────────────────────────────────────────────────────────

function getInstagramStatus() {
  const accountId = getConfig('instagram_account_id');
  const username  = getConfig('instagram_username');
  const token     = getConfig('instagram_page_token');
  if (accountId && token) return { status: 'connected', username: username || accountId };
  return { status: 'disconnected', username: null };
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

function generateAuthUrl() {
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const appId       = process.env.INSTAGRAM_APP_ID;
  const scopes      = [
    'instagram_basic',
    'instagram_manage_messages',
    'pages_show_list',
    'pages_manage_metadata',
  ].join(',');

  return `https://www.facebook.com/v20.0/dialog/oauth` +
    `?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&response_type=code`;
}

async function handleOAuthCallback(code) {
  const appId       = process.env.INSTAGRAM_APP_ID;
  const appSecret   = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  // 1. Código → token de corto plazo
  let shortRes;
  try {
    shortRes = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    });
  } catch (err) {
    const fbErr = err.response?.data?.error;
    console.error('[IG] Error canje código:', JSON.stringify(fbErr || err.message));
    throw new Error(fbErr?.message || err.message);
  }
  const shortToken = shortRes.data.access_token;

  // 2. Token corto → token largo (60 días)
  const longRes = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  });
  const longToken = longRes.data.access_token;

  // 3. Buscar página de Facebook con cuenta Instagram Business vinculada
  const pagesRes = await axios.get(`${GRAPH}/me/accounts`, {
    params: { access_token: longToken, fields: 'id,name,access_token,instagram_business_account' },
  });

  let pageToken   = null;
  let igAccountId = null;
  let igUsername  = null;

  for (const page of pagesRes.data.data || []) {
    if (page.instagram_business_account) {
      pageToken   = page.access_token;
      igAccountId = page.instagram_business_account.id;

      const igRes = await axios.get(`${GRAPH}/${igAccountId}`, {
        params: { access_token: pageToken, fields: 'username,name' },
      });
      igUsername = igRes.data.username || igRes.data.name || igAccountId;
      break;
    }
  }

  if (!igAccountId) {
    throw new Error(
      'No encontramos una cuenta de Instagram Business vinculada a tus páginas de Facebook. ' +
      'Asegurate de tener una Página de Facebook con una cuenta de Instagram Professional conectada.'
    );
  }

  setConfig('instagram_account_id', igAccountId);
  setConfig('instagram_page_token', pageToken);
  setConfig('instagram_username', igUsername);

  global.io?.emit('instagram:status', { status: 'connected', username: igUsername });
  console.log(`[IG] ✅ Conectado como @${igUsername} (cuenta: ${igAccountId})`);

  return { igAccountId, igUsername };
}

function disconnectInstagram() {
  setConfig('instagram_account_id', '');
  setConfig('instagram_page_token', '');
  setConfig('instagram_username', '');
  global.io?.emit('instagram:status', { status: 'disconnected', username: null });
  console.log('[IG] Desconectado');
}

// ─── Enviar mensaje ────────────────────────────────────────────────────────

async function sendInstagramMessage(recipientId, text) {
  const accountId = getConfig('instagram_account_id');
  const pageToken = getConfig('instagram_page_token');
  if (!accountId || !pageToken) throw new Error('Instagram no está conectado');

  await axios.post(
    `${GRAPH}/${accountId}/messages`,
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
    { params: { access_token: pageToken } }
  );
}

// ─── Webhook: mensaje entrante ─────────────────────────────────────────────

async function handleWebhookMessage(senderId, text) {
  const igPhone = `ig:${senderId}`;

  console.log(`[IG] DM de ${senderId}: ${text.substring(0, 80)}`);

  saveMessage(igPhone, 'in', text);
  global.io?.emit('chat:new_message', {
    phone: igPhone, direction: 'in', content: text, timestamp: new Date().toISOString(),
  });

  const lower = text.toLowerCase().trim();
  if (HUMAN_TRIGGERS.some(t => lower.includes(t))) {
    pauseContact(igPhone);
    const ack = 'Entendido, le aviso al dueño para que te atienda personalmente. Un momento 🙏';
    await sendInstagramMessage(senderId, ack);
    saveMessage(igPhone, 'out', ack);
    global.io?.emit('chat:new_message', { phone: igPhone, direction: 'out', content: ack, timestamp: new Date().toISOString() });
    global.io?.emit('chat:paused', { phone: igPhone });
    global.io?.emit('notification', { type: 'handoff', phone: igPhone });
    return;
  }

  if (isPaused(igPhone)) return;

  try {
    const reply = await processMessage(igPhone, text);
    if (reply) {
      await sendInstagramMessage(senderId, reply);
      saveMessage(igPhone, 'out', reply);
      global.io?.emit('chat:new_message', { phone: igPhone, direction: 'out', content: reply, timestamp: new Date().toISOString() });
    }
  } catch (err) {
    console.error('[IG] Error IA:', err.message);
  }
}

module.exports = {
  getInstagramStatus, generateAuthUrl, handleOAuthCallback,
  disconnectInstagram, sendInstagramMessage, handleWebhookMessage,
};
