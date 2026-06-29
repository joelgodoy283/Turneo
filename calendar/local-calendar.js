/**
 * calendar/local-calendar.js — Sistema propio de turnos (sin Google Calendar).
 *
 * Modelo del negocio: cada turno es un cupo de ENTREGA a la mañana (el auto
 * queda el día). La disponibilidad se rige por:
 *   - cal_capacity_per_day : cuántos autos se atienden por día (default 3)
 *   - cal_slots            : horarios de entrega ofrecidos (default 08:00,08:30,09:00)
 *   - cal_workdays         : días laborables, 0=Dom ... 6=Sáb (default Lun-Sáb)
 * Todo configurable por el dueño desde el dashboard.
 */
const {
  getConfig,
  createAppointment: dbCreateAppointment,
  getAppointmentsByDate,
  countAppointmentsOnDate,
  isDayBlocked,
  getBlockedTimes,
} = require('../database/db');

const TZ = 'America/Argentina/Buenos_Aires';
const WD_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function cfgInt(key, def) {
  const v = parseInt(getConfig(key), 10);
  return Number.isFinite(v) ? v : def;
}
function cfgList(key, def) {
  const v = (getConfig(key) || '').trim();
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def;
}

/** Día de la semana (0=Dom ... 6=Sáb) de una fecha YYYY-MM-DD en hora Argentina. */
function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return WD_MAP[name];
}

function isWorkday(dateStr) {
  const workdays = cfgList('cal_workdays', ['1', '2', '3', '4', '5', '6']).map(Number);
  // Un día laborable que el dueño bloqueó (feriado, vacaciones) deja de estar disponible.
  if (isDayBlocked(dateStr)) return false;
  return workdays.includes(weekdayOf(dateStr));
}

/** Fecha de hoy (YYYY-MM-DD) en hora Argentina. */
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Suma n días de calendario a un YYYY-MM-DD (sin drift de zona horaria). */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** ¿La fecha es laborable y todavía tiene cupo? */
function dayHasRoom(dateStr) {
  return isWorkday(dateStr) && countAppointmentsOnDate(dateStr) < cfgInt('cal_capacity_per_day', 3);
}

/**
 * Próximos días con cupo libre, a partir de `fromDateStr` (default: mañana).
 * Devuelve hasta `maxOptions` objetos { date, slots }.
 */
function nextAvailableSlots(maxOptions = 3, fromDateStr = null) {
  let date = fromDateStr || addDays(todayAR(), 1);
  const out = [];
  let guard = 0;
  while (out.length < maxOptions && guard < 90) {
    guard++;
    if (isWorkday(date)) {
      const slots = freeSlots(date);
      if (slots.length) out.push({ date, slots });
    }
    date = addDays(date, 1);
  }
  return out;
}

/** Horarios de entrega libres en una fecha (respetando capacidad del día). */
function freeSlots(dateStr) {
  const slots = cfgList('cal_slots', ['08:00', '08:30', '09:00']);
  const capacity = cfgInt('cal_capacity_per_day', 3);
  const taken = getAppointmentsByDate(dateStr).map((a) => a.time);
  const blocked = getBlockedTimes(dateStr); // horarios puntuales bloqueados por el dueño
  const unavailable = new Set([...taken, ...blocked]);
  const remaining = capacity - taken.length;
  if (remaining <= 0) return [];
  return slots.filter((s) => !unavailable.has(s)).slice(0, remaining);
}

async function getAvailability(dateStr) {
  if (!isWorkday(dateStr)) {
    return {
      available: false,
      slots: [],
      message: `El ${dateStr} el negocio está cerrado. Puedo ofrecerte otro día laborable (lunes a sábado).`,
    };
  }
  const capacity = cfgInt('cal_capacity_per_day', 3);
  const count = countAppointmentsOnDate(dateStr);
  const slots = freeSlots(dateStr);
  if (!slots.length) {
    return {
      available: false,
      slots: [],
      message: `El ${dateStr} ya está completo (${count}/${capacity} turnos). ¿Querés que busque otro día?`,
    };
  }
  return {
    available: true,
    slots,
    message: `El ${dateStr} hay lugar. Horarios de entrega disponibles: ${slots.join(', ')} hs. (${count}/${capacity} cupos ocupados.)`,
  };
}

/**
 * Crea un turno en el sistema propio. Valida día laborable y capacidad.
 * Devuelve { success, appointmentId?, appointment?, message }.
 */
async function createAppointment({
  client_phone, client_name = '', car_info = '', service = '',
  date, start_time, source = 'local', google_event_id = '',
}) {
  if (!isWorkday(date)) {
    return { success: false, message: `El ${date} el negocio está cerrado, no puedo agendar ese día.` };
  }
  const capacity = cfgInt('cal_capacity_per_day', 3);
  if (countAppointmentsOnDate(date) >= capacity) {
    return { success: false, message: `El ${date} ya está completo. Probemos con otro día.` };
  }
  if (start_time && getBlockedTimes(date).includes(start_time)) {
    return { success: false, message: `El horario ${start_time} del ${date} está bloqueado. Elegí otro.` };
  }

  const appt = dbCreateAppointment({
    client_phone, client_name, car_info, service,
    date, time: start_time || '', source, google_event_id,
  });

  return {
    success: true,
    appointmentId: appt.id,
    appointment: appt,
    message: `¡Turno agendado!${client_name ? ' ' + client_name + ' —' : ''} ${date}${start_time ? ' a las ' + start_time + ' hs' : ''}.`,
  };
}

module.exports = {
  getAvailability, createAppointment, isWorkday, freeSlots, weekdayOf,
  todayAR, addDays, dayHasRoom, nextAvailableSlots,
};
