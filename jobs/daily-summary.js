/**
 * jobs/daily-summary.js — Resumen diario de chats.
 *
 * Todos los días a las 19:00 (hora Argentina) arma un resumen de las
 * conversaciones del día y lo envía por WhatsApp a un número configurable.
 * El número y el on/off se guardan en la tabla `config`
 * (claves `summary_number` y `summary_enabled`).
 */
const cron = require('node-cron');
const { getConfig, getBusinessName, getMessagesSince, normalizePhone } = require('../database/db');
const { simpleCompletion } = require('../ai/openrouter');
const { sendMessage, getConnectionState } = require('../whatsapp/baileys');

const TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * Devuelve el inicio del día de hoy (00:00 hora Argentina) en el formato
 * UTC que usa SQLite ('YYYY-MM-DD HH:MM:SS'), para comparar con timestamp.
 */
function argentinaDayStartUTC() {
  // Fecha de hoy en Argentina (YYYY-MM-DD)
  const dateAR = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  // 00:00 de ese día en horario argentino (UTC-3)
  const startUTC = new Date(`${dateAR}T00:00:00-03:00`);
  // Formato SQLite UTC: 'YYYY-MM-DD HH:MM:SS'
  return startUTC.toISOString().slice(0, 19).replace('T', ' ');
}

/** Construye las métricas y el transcript del día a partir de los mensajes. */
function buildDayData() {
  const cutoff = argentinaDayStartUTC();
  const messages = getMessagesSince(cutoff);

  const byPhone = new Map();
  for (const m of messages) {
    if (!byPhone.has(m.phone)) byPhone.set(m.phone, []);
    byPhone.get(m.phone).push(m);
  }

  const incoming = messages.filter((m) => m.direction === 'incoming').length;
  const outgoing = messages.filter((m) => m.direction === 'outgoing').length;

  return {
    totalChats: byPhone.size,
    totalMessages: messages.length,
    incoming,
    outgoing,
    byPhone,
  };
}

/** Resumen por plantilla (fallback si la IA no está disponible). */
function templateSummary(data) {
  const fecha = new Date().toLocaleDateString('es-AR', { timeZone: TIMEZONE });
  if (!data.totalMessages) {
    return `📊 *Resumen ${getBusinessName()} — ${fecha}*\n\nHoy no hubo mensajes nuevos.`;
  }
  return (
    `📊 *Resumen ${getBusinessName()} — ${fecha}*\n\n` +
    `• ${data.totalChats} chat(s) con actividad\n` +
    `• ${data.incoming} mensaje(s) recibidos\n` +
    `• ${data.outgoing} respuesta(s) enviadas`
  );
}

/** Arma el transcript compacto para que la IA redacte el resumen. */
function buildTranscript(data) {
  const lines = [];
  for (const [phone, msgs] of data.byPhone) {
    const num = normalizePhone(phone);
    lines.push(`--- Cliente ${num} ---`);
    for (const m of msgs) {
      const who = m.direction === 'incoming' ? 'Cliente' : 'Bot';
      lines.push(`${who}: ${m.content}`);
    }
  }
  return lines.join('\n').slice(0, 8000); // límite defensivo de contexto
}

/**
 * Genera el resumen del día y lo envía por WhatsApp al número configurado.
 * Devuelve { ok, sent, reason, text } para uso del endpoint de prueba.
 */
async function generateAndSend({ force = false } = {}) {
  const enabled = getConfig('summary_enabled');
  if (!force && enabled !== 'true') {
    return { ok: false, sent: false, reason: 'El resumen diario está desactivado.' };
  }

  const number = normalizePhone(getConfig('summary_number'));
  if (!number) {
    return { ok: false, sent: false, reason: 'No hay número de destino configurado.' };
  }

  const data = buildDayData();

  // Redacción con IA; si falla, plantilla
  let text = null;
  if (data.totalMessages) {
    const fecha = new Date().toLocaleDateString('es-AR', { timeZone: TIMEZONE });
    const sys =
      'Sos un asistente que redacta un resumen breve y claro (en español rioplatense) ' +
      'de la actividad diaria de un negocio en WhatsApp. Para WhatsApp: usá ' +
      'viñetas con •, *negritas* para títulos, y máximo ~12 líneas. Destacá: cantidad de ' +
      'clientes, temas/consultas frecuentes, turnos o pedidos importantes y quién pidió ' +
      'hablar con una persona.';
    const user =
      `Fecha: ${fecha}\nClientes con actividad: ${data.totalChats}\n` +
      `Mensajes recibidos: ${data.incoming} | Enviados: ${data.outgoing}\n\n` +
      `Conversaciones del día:\n${buildTranscript(data)}`;
    text = await simpleCompletion(sys, user);
  }

  if (!text) text = templateSummary(data);

  if (getConnectionState().status !== 'connected') {
    return { ok: false, sent: false, reason: 'WhatsApp no está conectado.', text };
  }

  try {
    await sendMessage(`${number}@s.whatsapp.net`, text);
    console.log(`[SUMMARY] ✅ Resumen enviado a ${number}`);
    return { ok: true, sent: true, text };
  } catch (err) {
    console.error('[SUMMARY] Error enviando resumen:', err.message);
    return { ok: false, sent: false, reason: err.message, text };
  }
}

/** Programa el cron diario a las 19:00 hora Argentina. */
function startDailySummary() {
  cron.schedule('0 19 * * *', () => {
    console.log('[SUMMARY] 🕖 Disparando resumen diario (19:00 ART)...');
    generateAndSend().catch((err) => console.error('[SUMMARY] Error:', err.message));
  }, { timezone: TIMEZONE });

  console.log('[SUMMARY] ✅ Resumen diario programado para las 19:00 (ART)');
}

module.exports = { startDailySummary, generateAndSend };
