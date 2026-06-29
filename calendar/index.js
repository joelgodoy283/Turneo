/**
 * calendar/index.js — Fachada de calendario.
 *
 * Fuente de verdad: SIEMPRE la tabla `appointments` (estados, recordatorios y
 * reseñas viven ahí). Si Google Calendar está configurado, además se espeja el
 * turno como evento en Google para que el dueño lo vea en su agenda.
 *
 * La disponibilidad la gobierna siempre el modelo de capacidad del negocio
 * (capacidad/día + horarios de entrega), porque refleja la realidad del local.
 */
const google = require('./google-calendar');
const local = require('./local-calendar');
const db = require('../database/db');
const { notifyOwner } = require('../whatsapp/notify');

/** ¿Está Google Calendar configurado (credenciales + token)? */
function usingGoogle() {
  return google.isCalendarConfigured();
}

/** El calendario siempre está disponible: el sistema propio no requiere setup. */
function isConfigured() {
  return true;
}

/** Suma una hora a un "HH:MM" → "HH:MM" (para la duración por defecto del evento). */
function addOneHour(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  const end = new Date(2000, 0, 1, h + 1, m);
  return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

async function getAvailability(dateStr) {
  return local.getAvailability(dateStr);
}

/**
 * Crea un turno. data: { client_phone, client_name, detail, service, date,
 * start_time, end_time? }. Inserta en la DB (fuente de verdad), espeja en
 * Google si está configurado, y avisa al dueño.
 */
async function createAppointment(data) {
  const res = await local.createAppointment({
    client_phone: data.client_phone,
    client_name: data.client_name,
    detail: data.detail,
    service: data.service,
    date: data.date,
    start_time: data.start_time,
    source: usingGoogle() ? 'google' : 'local',
  });
  if (!res.success) return res;

  // Espejo en Google Calendar (no bloqueante: si falla, el turno propio queda igual)
  if (usingGoogle() && data.start_time) {
    try {
      const ev = await google.createAppointment({
        summary: `Turno: ${data.client_name || ''} - ${data.detail || ''}`,
        description:
          `Cliente: ${data.client_name || ''}\nDetalle: ${data.detail || ''}` +
          (data.service ? `\nServicio: ${data.service}` : ''),
        dateStr: data.date,
        startTime: data.start_time,
        endTime: data.end_time || addOneHour(data.start_time),
        clientPhone: data.client_phone,
      });
      if (ev?.eventId) db.updateAppointment(res.appointmentId, { google_event_id: ev.eventId });
      res.link = ev?.link;
    } catch (err) {
      console.error('[CAL] No se pudo espejar en Google (sigo con el turno propio):', err.message);
    }
  }

  // Aviso al dueño (se omite si lo creó el propio el dueño a mano)
  if (data.notifyOwner !== false) {
    const tel = db.normalizePhone(data.client_phone);
    const ownerMsg =
      `🗓️ *Nuevo turno agendado*\n` +
      `Cliente: ${data.client_name || '—'}\n` +
      `Detalle: ${data.detail || '—'}\n` +
      (data.service ? `Servicio: ${data.service}\n` : '') +
      `Día: ${data.date}${data.start_time ? ` a las ${data.start_time} hs` : ''}\n` +
      `Tel: ${tel}`;
    notifyOwner(ownerMsg).catch(() => {});
  }

  return res;
}

/**
 * Reagenda un turno a otra fecha/hora. Valida cupo del nuevo día, resetea el
 * recordatorio y re-espeja en Google si corresponde.
 */
async function rescheduleAppointment(id, newDate, newTime) {
  const appt = db.getAppointmentById(id);
  if (!appt) return { success: false, message: 'No encontré ese turno.' };

  if (newDate && newDate !== appt.date && !local.dayHasRoom(newDate)) {
    return { success: false, message: `El ${newDate} no tiene lugar (cerrado o completo).` };
  }
  const date = newDate || appt.date;
  const time = newTime || appt.time;

  db.updateAppointment(id, { date, time, status: 'scheduled', reminder_sent: 0 });

  // Re-espejar en Google (borrar el evento viejo y crear uno nuevo)
  if (appt.google_event_id) {
    try { await google.deleteEvent(appt.google_event_id); } catch (e) { /* noop */ }
  }
  let newEventId = '';
  if (usingGoogle() && time) {
    try {
      const ev = await google.createAppointment({
        summary: `Turno: ${appt.client_name || ''} - ${appt.detail || ''}`,
        description: `Cliente: ${appt.client_name || ''}\nDetalle: ${appt.detail || ''}`,
        dateStr: date,
        startTime: time,
        endTime: addOneHour(time),
        clientPhone: appt.client_phone,
      });
      newEventId = ev?.eventId || '';
    } catch (e) {
      console.error('[CAL] No se pudo re-espejar en Google:', e.message);
    }
  }
  db.updateAppointment(id, { google_event_id: newEventId });

  return { success: true, appointment: db.getAppointmentById(id) };
}

/** Cancela un turno (por id de la DB). Borra el evento de Google si existía. */
async function cancelAppointment(id) {
  const appt = db.getAppointmentById(id);
  if (!appt) return { success: false, message: 'No encontré ese turno.' };
  db.updateAppointment(id, { status: 'cancelled' });
  if (appt.google_event_id) {
    try {
      await google.deleteEvent(appt.google_event_id);
    } catch (err) {
      console.error('[CAL] No se pudo borrar el evento de Google:', err.message);
    }
  }
  return { success: true, appointment: db.getAppointmentById(id) };
}

module.exports = {
  usingGoogle,
  isConfigured,
  getAvailability,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
};
