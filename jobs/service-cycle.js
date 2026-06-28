/**
 * jobs/service-cycle.js — Ciclo de servicio del día (interacción con Lucas).
 *
 * 1) Check-in 10:00 ART: le pasa a Lucas los turnos de hoy y le pregunta quién
 *    vino y para qué hora estima cada auto. Su respuesta la procesa el asistente
 *    (marca asistencia + carga hora estimada de finalización).
 * 2) Poller (cada 10'): cuando llega la hora estimada de un auto en proceso, le
 *    pregunta a Lucas si lo terminó. Si confirma, el asistente marca terminado y
 *    el cliente recibe el aviso de retiro.
 */
const cron = require('node-cron');
const { getConfig, getAppointmentsBetween, updateAppointment } = require('../database/db');
const local = require('../calendar/local-calendar');
const assistant = require('../ai/assistant');

const TZ = 'America/Argentina/Buenos_Aires';

/** Hora actual "HH:MM" (24h) en Argentina. */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date());
}

// ─── Check-in matutino ────────────────────────────────────────────────────────

async function doCheckin({ force = false } = {}) {
  if (!force && getConfig('checkin_enabled') !== 'true') {
    return { ok: false, reason: 'El check-in de servicio está desactivado.' };
  }
  const today = local.todayAR();
  const appts = getAppointmentsBetween(today, today).filter((a) => a.status === 'scheduled');
  if (!appts.length) return { ok: true, sent: false, reason: 'Hoy no hay turnos para el check-in.' };

  const list = appts
    .map((a) => `• ${a.time || '—'} — ${a.client_name || a.client_phone}${a.car_info ? ` (${a.car_info})` : ''} [id ${a.id}]`)
    .join('\n');
  const text =
    `🔧 *Check-in del día*\nEstos son los turnos de hoy:\n${list}\n\n` +
    `¿Vinieron todos? ¿Para qué hora estimás que va a estar listo cada uno? ` +
    `Decímelo (ej: "vinieron todos, el Focus 17hs y el Gol 15") y lo anoto.`;

  const sent = await assistant.sendToLucasAndRemember(text);
  return { ok: sent, sent, count: appts.length };
}

// ─── Poller de finalización ───────────────────────────────────────────────────

async function doFinishChecks() {
  if (getConfig('checkin_enabled') !== 'true') return { ok: false, asked: 0 };
  const today = local.todayAR();
  const now = nowHHMM();

  const pend = getAppointmentsBetween(today, today).filter(
    (a) => a.status === 'in_progress' && a.estimated_finish && !a.finish_check_sent && a.estimated_finish <= now
  );
  if (!pend.length) return { ok: true, asked: 0 };

  let asked = 0;
  for (const a of pend) {
    const text =
      `🔧 ¿Terminaste el ${a.car_info || 'vehículo'} de ${a.client_name || a.client_phone}? ` +
      `(estimabas ${a.estimated_finish} hs) [id ${a.id}]\n` +
      `Si ya está, confirmámelo y le aviso al cliente que puede retirarlo.`;
    const sent = await assistant.sendToLucasAndRemember(text);
    // Marcamos como preguntado solo si se pudo enviar (si no, se reintenta luego).
    if (sent) { updateAppointment(a.id, { finish_check_sent: 1 }); asked++; }
  }
  return { ok: true, asked };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function startServiceCycle() {
  cron.schedule('0 10 * * *', () => {
    console.log('[SERVICE] 🕙 Check-in de servicio (10:00 ART)...');
    doCheckin().catch((err) => console.error('[SERVICE] Error en check-in:', err.message));
  }, { timezone: TZ });

  cron.schedule('*/10 * * * *', () => {
    doFinishChecks().catch((err) => console.error('[SERVICE] Error en poller de finalización:', err.message));
  }, { timezone: TZ });

  console.log('[SERVICE] ✅ Ciclo de servicio programado (check-in 10:00 + poller de finalización c/10min)');
}

module.exports = { startServiceCycle, doCheckin, doFinishChecks };
