/**
 * jobs/reminders.js — Recordatorio de turno ~24 hs antes, al cliente.
 *
 * Corre 1 vez por día (11:00 hora Argentina) y le recuerda el turno a todos los
 * clientes que tienen turno MAÑANA y que todavía no recibieron el recordatorio.
 * Como la tabla `appointments` es la fuente de verdad, cubre tanto los turnos del
 * sistema propio como los espejados en Google. On/off con `reminder_enabled`.
 */
const cron = require('node-cron');
const { getConfig, getBusinessName, getAppointmentsBetween, updateAppointment } = require('../database/db');
const local = require('../calendar/local-calendar');

const TZ = 'America/Argentina/Buenos_Aires';

function prettyDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

function reminderText(appt) {
  const address = (getConfig('business_address') || '').trim();
  return (
    `🔔 Hola${appt.client_name ? ' ' + appt.client_name : ''}, te recordamos tu turno en *${getBusinessName()}* ` +
    `para mañana ${prettyDate(appt.date)}${appt.time ? ' a las ' + appt.time + ' hs' : ''}.\n` +
    (address ? `📍 ${address}.\n` : '') +
    `Si no podés venir o querés reprogramarlo, avisanos. ¡Te esperamos!`
  );
}

async function sendReminders({ force = false } = {}) {
  if (!force && getConfig('reminder_enabled') !== 'true') {
    return { ok: false, sent: 0, reason: 'Los recordatorios están desactivados.' };
  }

  const tomorrow = local.addDays(local.todayAR(), 1);
  const pendientes = getAppointmentsBetween(tomorrow, tomorrow)
    .filter((a) => a.status === 'scheduled' && !a.reminder_sent);

  if (!pendientes.length) return { ok: true, sent: 0, reason: 'No hay turnos para recordar mañana.' };

  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    return { ok: false, sent: 0, reason: 'WhatsApp no está conectado.' };
  }

  let sent = 0;
  for (const appt of pendientes) {
    try {
      await sendMessage(`${appt.client_phone}@s.whatsapp.net`, reminderText(appt));
      updateAppointment(appt.id, { reminder_sent: 1 });
      sent++;
    } catch (err) {
      console.error(`[REMINDER] Error recordando turno ${appt.id}:`, err.message);
    }
  }
  console.log(`[REMINDER] ✅ ${sent}/${pendientes.length} recordatorio(s) enviado(s) para ${tomorrow}`);
  return { ok: true, sent, total: pendientes.length };
}

/** Programa los recordatorios diarios a las 11:00 hora Argentina. */
function startReminders() {
  cron.schedule('0 11 * * *', () => {
    console.log('[REMINDER] 🕚 Disparando recordatorios de turno (11:00 ART)...');
    sendReminders().catch((err) => console.error('[REMINDER] Error:', err.message));
  }, { timezone: TZ });
  console.log('[REMINDER] ✅ Recordatorios de turno programados para las 11:00 (ART)');
}

module.exports = { startReminders, sendReminders };
