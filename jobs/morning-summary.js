/**
 * jobs/morning-summary.js — Resumen matutino para Lucas (08:00 hora Argentina).
 *
 * Incluye los turnos de HOY (bloque determinístico) + un resumen de la actividad
 * de AYER (contactos que escribieron), redactado con IA. Se envía al número de
 * Lucas (config `lucas_number`, con fallback a `summary_number`).
 * On/off con la config `morning_summary_enabled`.
 */
const cron = require('node-cron');
const { getConfig, getMessagesBetween, getAppointmentsBetween, normalizePhone } = require('../database/db');
const { simpleCompletion } = require('../ai/openrouter');
const { notifyLucas } = require('../whatsapp/notify');
const local = require('../calendar/local-calendar');

const TZ = 'America/Argentina/Buenos_Aires';

function prettyDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** Límites UTC ('YYYY-MM-DD HH:MM:SS') de un día de Argentina. */
function dayBoundsUTC(dateStr) {
  const toSqlite = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
  return {
    start: toSqlite(`${dateStr}T00:00:00-03:00`),
    end: toSqlite(`${local.addDays(dateStr, 1)}T00:00:00-03:00`),
  };
}

/** Bloque de turnos de hoy (determinístico). */
function appointmentsBlock(dateStr) {
  const appts = getAppointmentsBetween(dateStr, dateStr);
  if (!appts.length) return '📋 *Turnos de hoy:* no hay turnos agendados.';
  const lines = appts.map((a) => {
    const hora = a.time || '—';
    const veh = a.car_info ? ` (${a.car_info})` : '';
    const serv = a.service ? ` · ${a.service}` : '';
    return `• ${hora} — ${a.client_name || a.client_phone}${veh}${serv}`;
  });
  return `📋 *Turnos de hoy* (${appts.length}):\n${lines.join('\n')}`;
}

/** Bloque de actividad de ayer (IA con fallback a plantilla). */
async function yesterdayBlock(yesterdayStr) {
  const { start, end } = dayBoundsUTC(yesterdayStr);
  const msgs = getMessagesBetween(start, end);

  const byPhone = new Map();
  for (const m of msgs) {
    const num = normalizePhone(m.phone);
    if (!byPhone.has(num)) byPhone.set(num, []);
    byPhone.get(num).push(m);
  }
  if (!byPhone.size) return `📨 *Ayer* (${prettyDate(yesterdayStr)}): no hubo mensajes nuevos.`;

  const transcript = [...byPhone.entries()]
    .map(([num, list]) => `--- Cliente ${num} ---\n` +
      list.map((m) => `${m.direction === 'incoming' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n'))
    .join('\n')
    .slice(0, 7000);

  const sys =
    'Redactá en español rioplatense un resumen BREVE (máx ~8 líneas) de la actividad de ayer en el ' +
    'WhatsApp de un taller mecánico, para el dueño. Usá viñetas con • y *negritas* para destacar. ' +
    'Mencioná cuántos clientes escribieron, qué pidieron, posibles turnos/interesados y quién pidió un humano. Sin saludos.';
  const user = `Conversaciones de ayer (${byPhone.size} clientes):\n${transcript}`;

  const ai = await simpleCompletion(sys, user);
  if (ai) return `📨 *Ayer* (${prettyDate(yesterdayStr)}):\n${ai.trim()}`;
  return `📨 *Ayer* (${prettyDate(yesterdayStr)}): ${byPhone.size} chat(s) con actividad.`;
}

async function generateAndSend({ force = false } = {}) {
  if (!force && getConfig('morning_summary_enabled') !== 'true') {
    return { ok: false, sent: false, reason: 'El resumen matutino está desactivado.' };
  }

  const today = local.todayAR();
  const yesterday = local.addDays(today, -1);

  const text =
    `☀️ *Buen día, Lucas* — ${prettyDate(today)}\n\n` +
    `${appointmentsBlock(today)}\n\n` +
    `${await yesterdayBlock(yesterday)}`;

  const sent = await notifyLucas(text);
  if (!sent) return { ok: false, sent: false, reason: 'No se pudo enviar (¿WhatsApp desconectado o sin número de Lucas?).', text };
  console.log('[MORNING] ✅ Resumen matutino enviado a Lucas');
  return { ok: true, sent: true, text };
}

/** Programa el resumen matutino a las 08:00 hora Argentina. */
function startMorningSummary() {
  cron.schedule('0 8 * * *', () => {
    console.log('[MORNING] 🕗 Disparando resumen matutino (08:00 ART)...');
    generateAndSend().catch((err) => console.error('[MORNING] Error:', err.message));
  }, { timezone: TZ });
  console.log('[MORNING] ✅ Resumen matutino programado para las 08:00 (ART)');
}

module.exports = { startMorningSummary, generateAndSend };
