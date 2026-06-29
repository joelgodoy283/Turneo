const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  isJidBroadcast,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { saveMessage, isPaused, pauseContact, isBlocked } = require('../database/db');
const { processMessage, describeMedia } = require('../ai/openrouter');
const { processAssistantMessage } = require('../ai/assistant');
const { isAdmin } = require('./admins');
const { logMessage } = require('../supabase/client');

const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '..', 'sessions');

// Frases que activan el handoff a humano
const HUMAN_TRIGGERS = [
  'hablar con una persona', 'quiero un humano', 'humano', 'persona real',
  'hablar con una persona', 'atencion humana', 'atención humana',
  'agente', 'hablar con alguien', 'no quiero el bot',
];

let sock = null;
let connectionState = { status: 'disconnected', qr: null };
let reconnectTimeout = null;

// Logger silencioso para la descarga de medios (audios/imágenes)
const mediaLogger = pino({ level: 'silent' });

// Límite defensivo de tamaño de medio a procesar (~12 MB en base64 ≈ 9 MB real)
const MAX_MEDIA_BYTES = 9 * 1024 * 1024;

function getConnectionState() {
  return connectionState;
}

async function startWhatsApp() {
  clearTimeout(reconnectTimeout);

  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA] Usando Baileys v${version.join('.')} | ¿Última versión? ${isLatest}`);

  // Logger silencioso (solo errores) para no ensuciar la consola
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false, // Lo mandamos al dashboard via Socket.io
    browser: ['Turneo Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  // ─── Credenciales ───────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ─── Estado de conexión ─────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR generado, enviando al Dashboard...');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr, { width: 300 });
        connectionState = { status: 'qr', qr: qrDataUrl };
        global.io?.emit('whatsapp:qr', qrDataUrl);
        global.io?.emit('whatsapp:status', connectionState);
      } catch (err) {
        console.error('[WA] Error generando QR:', err.message);
      }
    }

    if (connection === 'open') {
      console.log('[WA] ✅ Conectado a WhatsApp');
      connectionState = { status: 'connected', qr: null };
      global.io?.emit('whatsapp:status', connectionState);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[WA] Conexión cerrada. Razón: ${reason}`);

      connectionState = { status: 'disconnected', qr: null };
      global.io?.emit('whatsapp:status', connectionState);

      // Lógica de reconexión
      const shouldReconnect =
        reason !== DisconnectReason.loggedOut &&
        reason !== DisconnectReason.forbidden;

      if (shouldReconnect) {
        const delay = reason === DisconnectReason.connectionReplaced ? 10000 : 5000;
        console.log(`[WA] Reconectando en ${delay / 1000}s...`);
        reconnectTimeout = setTimeout(startWhatsApp, delay);
      } else {
        console.log('[WA] Sesión cerrada por el usuario o prohibida. Borrando sesión...');
        // Si el usuario cerró sesión desde el teléfono, limpiar credenciales
        const fs = require('fs');
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR);
        }
        reconnectTimeout = setTimeout(startWhatsApp, 3000);
      }
    }
  });

  // ─── Mensajes entrantes ─────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar mensajes propios, de grupos y broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const phone = msg.key.remoteJid;

      // Excepciones: números personales que deben ignorarse por completo
      // (no se guardan, no aparecen en el panel y no se responden).
      if (isBlocked(phone)) {
        console.log(`[WA] Número en excepciones, ignorando: ${phone}`);
        continue;
      }

      const content = await extractContent(msg);

      if (!content) continue;

      // Si llegó un medio procesable, generamos una descripción/transcripción útil
      // para guardar en el historial (en vez de "[Imagen]"/"[Nota de voz]" a secas).
      if (content.media) {
        try {
          const desc = await describeMedia(content.media, content.text);
          if (desc) content.logText = desc;
        } catch (err) {
          console.error('[WA] No se pudo describir el medio:', err.message);
        }
      }

      const logText = content.logText;
      console.log(`[WA] Mensaje de ${phone}: "${logText.substring(0, 80)}"`);

      // Guardar en DB y emitir al dashboard (placeholder legible para los medios)
      saveMessage(phone, 'incoming', logText);
      logMessage(phone, 'incoming', logText); // historial de largo plazo (Supabase)
      global.io?.emit('chat:new_message', { phone, direction: 'incoming', content: logText, timestamp: new Date().toISOString() });

      // ─── Medio no procesable o no soportado, SIN texto que podamos atender ────
      // (video/documento/sticker, o un audio/imagen que no se pudo descargar).
      // Respondemos una guía clara y no llamamos a la IA. Si el cliente ya está en
      // manos de un humano (pausado y no es admin), no interrumpimos.
      if (!content.text && (content.failed || content.unsupported)) {
        if (isPaused(phone) && !isAdmin(phone)) continue;
        const guide = unsupportedMediaReply(content);
        await sendMessage(phone, guide);
        continue;
      }

      // ─── Modo asistente interno: si escribe un ADMIN autorizado (dueño/encargado),
      // lo atiende su asistente interno con herramientas de gestión, no el bot de clientes.
      if (isAdmin(phone)) {
        console.log(`[WA] Mensaje de ADMIN (modo asistente): "${logText.substring(0, 60)}"`);
        await sock.sendPresenceUpdate('composing', phone);
        try {
          const reply = await processAssistantMessage(phone, content);
          await sendMessage(phone, reply);
        } catch (err) {
          console.error('[WA] Error en modo asistente:', err.message);
          await sendMessage(phone, 'Uh, tuve un error técnico. Probá de nuevo.');
        } finally {
          await sock.sendPresenceUpdate('paused', phone);
        }
        continue;
      }

      // Verificar si es un trigger de handoff humano (sobre el texto, si lo hay)
      const textNormalized = (content.text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const isHumanRequest = HUMAN_TRIGGERS.some(t => textNormalized.includes(t));

      if (isHumanRequest) {
        pauseContact(phone);
        const pauseMsg = '🤝 Entendido, voy a avisarle al dueño para que te atienda personalmente. Por favor esperá unos minutos.';
        await sendMessage(phone, pauseMsg);
        global.io?.emit('chat:paused', { phone, reason: 'human_request' });
        global.io?.emit('notification', { type: 'handoff', phone, message: `El cliente ${phone} pidió atención humana.` });
        continue;
      }

      // Si el bot está pausado para este número, no responder
      if (isPaused(phone)) {
        console.log(`[WA] Bot pausado para ${phone}, ignorando mensaje`);
        continue;
      }

      // Indicador de "escribiendo..."
      await sock.sendPresenceUpdate('composing', phone);

      // Procesar con IA
      try {
        const reply = await processMessage(phone, content);
        await sendMessage(phone, reply);
      } catch (err) {
        console.error('[WA] Error procesando mensaje con IA:', err.message);
        await sendMessage(phone, 'Lo siento, tuve un error técnico. Por favor escribí "hablar con una persona" para atención directa.');
      } finally {
        await sock.sendPresenceUpdate('paused', phone);
      }
    }
  });
}

/**
 * Envía un mensaje de texto y lo guarda en la DB
 */
async function sendMessage(phone, text) {
  if (!sock) throw new Error('WhatsApp no está conectado');

  try {
    await sock.sendMessage(phone, { text });
    saveMessage(phone, 'outgoing', text);
    logMessage(phone, 'outgoing', text); // historial de largo plazo (Supabase)
    global.io?.emit('chat:new_message', {
      phone,
      direction: 'outgoing',
      content: text,
      timestamp: new Date().toISOString(),
    });
    console.log(`[WA] Enviado a ${phone}: "${text.substring(0, 60)}..."`);
  } catch (err) {
    console.error(`[WA] Error enviando mensaje a ${phone}:`, err.message);
    throw err;
  }
}

/**
 * Extrae el contenido de un mensaje de Baileys. Devuelve:
 *   { text, media, logText, failed }  o  null si no hay nada que procesar.
 * - text:    texto/epígrafe del cliente (puede ser '').
 * - media:   { kind:'image'|'audio', mime, dataB64 }  o null.
 * - logText: lo que se guarda/muestra en el panel (placeholder para medios).
 */
async function extractContent(msg) {
  const m = msg.message;
  if (!m) return null;

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    '';

  // Imagen (con o sin epígrafe)
  if (m.imageMessage) {
    const r = await tryDownloadMedia(msg, m.imageMessage.mimetype || 'image/jpeg', 'image');
    if (r.media) return { text, media: r.media, logText: text ? `🖼️ ${text}` : '[Imagen]' };
    return { text, media: null, logText: text ? `🖼️ ${text}` : '[Imagen no procesable]', failed: true, reason: r.error };
  }

  // Audio / nota de voz
  if (m.audioMessage) {
    const r = await tryDownloadMedia(msg, m.audioMessage.mimetype || 'audio/ogg', 'audio');
    if (r.media) return { text: '', media: r.media, logText: '[Nota de voz]' };
    return { text: '', media: null, logText: '[Nota de voz no procesable]', failed: true, reason: r.error };
  }

  // Video: por ahora no se procesa el contenido. Si trae epígrafe, lo usamos como texto.
  if (m.videoMessage) {
    if (text) return { text, media: null, logText: `🎬 ${text}` };
    return { text: '', media: null, logText: '[Video]', unsupported: 'video' };
  }

  // Otros tipos no soportados (documentos, stickers, ubicación, contactos).
  if (m.documentMessage || m.stickerMessage || m.locationMessage || m.contactMessage) {
    if (text) return { text, media: null, logText: text };
    const kind = m.documentMessage ? 'documento' : m.stickerMessage ? 'sticker'
      : m.locationMessage ? 'ubicación' : 'contacto';
    return { text: '', media: null, logText: `[${kind}]`, unsupported: kind };
  }

  if (text) return { text, media: null, logText: text };
  return null;
}

/** Mensaje guía cuando llega un medio que no podemos procesar (sin texto). */
function unsupportedMediaReply(content) {
  if (content.unsupported === 'video') {
    return '🎬 Por ahora no puedo ver videos. Si es por un problema del pedido, contámelo por texto o mandame una *foto* y una *nota de voz*. 🙌';
  }
  if (content.unsupported) {
    return `No puedo abrir ese tipo de archivo (${content.unsupported}). ¿Me lo contás por texto, una foto o un audio?`;
  }
  // failed: era audio/imagen pero no se pudo descargar/procesar
  const isVoice = content.logText?.includes('voz');
  if (content.reason === 'too_large') {
    return isVoice
      ? 'Tu nota de voz es demasiado pesada para procesarla 😅. ¿Me mandás una más corta o me lo escribís por texto?'
      : 'Esa imagen es demasiado pesada para procesarla 😅. ¿Me la mandás en menor calidad o me contás por texto?';
  }
  if (isVoice) {
    return 'No pude procesar tu nota de voz 🙉. ¿Me lo escribís por texto? Si preferís, escribí "hablar con una persona".';
  }
  return 'No pude abrir bien esa imagen. ¿Me la reenviás o me contás por texto qué necesitás? Si preferís, escribí "hablar con una persona".';
}

/** Descarga un medio de WhatsApp y lo devuelve en base64, o null si falla. */
async function tryDownloadMedia(msg, mime, kind) {
  // Validar tipo permitido antes de descargar (defensa básica).
  const okType = kind === 'image' ? /^image\//i.test(mime) : /^audio\//i.test(mime);
  if (!okType) {
    console.warn(`[WA] Tipo de medio no permitido para ${kind}: ${mime}`);
    return { media: null, error: 'bad_type' };
  }
  try {
    const buffer = await downloadMediaMessage(
      msg, 'buffer', {},
      { logger: mediaLogger, reuploadRequest: sock.updateMediaMessage }
    );
    if (!buffer || !buffer.length) return { media: null, error: 'empty' };
    if (buffer.length > MAX_MEDIA_BYTES) {
      console.warn(`[WA] Medio ${kind} omitido (demasiado grande: ${buffer.length} bytes).`);
      return { media: null, error: 'too_large' };
    }
    return { media: { kind, mime, dataB64: buffer.toString('base64') } };
  } catch (err) {
    console.error(`[WA] Error descargando ${kind}:`, err.message);
    return { media: null, error: 'download' };
  }
}

module.exports = { startWhatsApp, sendMessage, getConnectionState };
