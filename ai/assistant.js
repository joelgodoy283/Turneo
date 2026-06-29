/**
 * ai/assistant.js — Modo asistente del dueño.
 *
 * Cuando un mensaje llega del número del dueño (config `owner_number`), en vez de
 * atenderlo como cliente se lo procesa acá: prompt y herramientas distintas para
 * gestionar la agenda (consultar/crear/cancelar/reagendar turnos, ver contactos
 * del día, marcar cuándo queda listo un pedido).
 */
const {
  getConfig, setConfig, getBusinessName, getConversationState, saveConversationState,
  getAppointmentById, getAppointmentsBetween, getAllAppointmentsBetween, getMessagesBetween,
  updateAppointment, normalizePhone, searchAppointments,
  addBlockedSlot, removeBlocksOnDate, getBlockedSlots,
  pauseContact, resumeContact, isPaused,
} = require('../database/db');
const cal = require('../calendar');
const local = require('../calendar/local-calendar');
const { callOpenRouter, currentDateLine, normalizeInput, withCurrentMedia } = require('./openrouter');

const TZ = 'America/Argentina/Buenos_Aires';
const MAX_HISTORY_MESSAGES = 20;

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildAssistantPrompt() {
  const base = getConfig('assistant_prompt') || 'Sos el asistente personal del dueño/encargado del negocio.';
  const { texto, iso } = currentDateLine();
  return `${base}

ADEMÁS DE LA AGENDA, PODÉS (tenés herramientas para esto):
- Ver horarios libres de un día o los próximos días con cupo (check_free_slots).
- Buscar turnos por nombre, teléfono, patente/pedido o servicio (search_appointments).
- Bloquear/desbloquear días completos u horarios puntuales: feriados, vacaciones, imprevistos (block_schedule / unblock_schedule / list_blocks).
- Dar métricas: cuántos turnos hay en un rango, por estado, por servicio, cuántos clientes escribieron (business_metrics).
- Armar el resumen del día: turnos + quién escribió (day_summary).
- Poner a un cliente en modo MANUAL (lo atendés vos, el bot no le responde) o devolverlo a modo BOT (set_contact_bot_mode).
- Cambiar de forma simple la agenda: capacidad por día, horarios ofrecidos, días laborables (set_business_hours).
Cuando una acción afecta a un cliente real o cambia la configuración, confirmá con el dueño antes.

FECHA Y HORA ACTUAL:
Hoy es ${texto}. En ISO: ${iso}. Usá SIEMPRE esta fecha para interpretar "hoy", "mañana", "el viernes", etc., y pasá las fechas a las herramientas en formato YYYY-MM-DD.`;
}

// ─── Herramientas del asistente ───────────────────────────────────────────────

const ASSISTANT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_appointments',
      description: 'Lista los turnos de un día (o un rango de días). Si no se pasa fecha, usa hoy. Devolvé los ids para poder operar después.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día a consultar YYYY-MM-DD. Si se omite, hoy.' },
          date_to: { type: 'string', description: 'Opcional: fin del rango YYYY-MM-DD para listar varios días.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_day_contacts',
      description: 'Lista los contactos/clientes que escribieron al negocio por WhatsApp en un día, con su conversación, para que puedas resumirle al dueño quiénes fueron y qué pidieron. Si no se pasa fecha, usa hoy.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día YYYY-MM-DD. Si se omite, hoy.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela un turno por su id. Por defecto le avisa al cliente y le ofrece otra fecha con prioridad. Confirmá con el dueño antes de usarla.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number', description: 'Id del turno (obtenido de list_appointments).' },
          reason: { type: 'string', description: 'Motivo opcional, se incluye en el aviso al cliente.' },
          notify_client: { type: 'boolean', description: 'Si avisar al cliente. Default true.' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment_manual',
      description: 'Crea un turno manualmente (cuando el dueño coordina por otro medio). Necesita el teléfono del cliente.',
      parameters: {
        type: 'object',
        properties: {
          client_name: { type: 'string' },
          client_phone: { type: 'string', description: 'Número de WhatsApp del cliente (con código de país).' },
          detail: { type: 'string', description: 'Marca, modelo, año y/o problema.' },
          service: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM (horario de entrega).' },
        },
        required: ['client_name', 'client_phone', 'date', 'start_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reagenda un turno existente a otra fecha y/u hora. Por defecto le avisa al cliente.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          new_date: { type: 'string', description: 'YYYY-MM-DD' },
          new_time: { type: 'string', description: 'HH:MM (opcional, mantiene la anterior si no se pasa).' },
          notify_client: { type: 'boolean', description: 'Si avisar al cliente. Default true.' },
        },
        required: ['appointment_id', 'new_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_ready_date',
      description: 'Registra/ajusta el día en que un pedido va a estar listo (ej: "el pedido de Fulano está para el viernes"). Sirve para coordinar el aviso de retiro y el pedido de reseña.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          ready_date: { type: 'string', description: 'YYYY-MM-DD en que el pedido queda listo.' },
        },
        required: ['appointment_id', 'ready_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_attendance',
      description: 'Marca si un cliente asistió o no a su turno (lo usás cuando el dueño te confirma quién vino). Si no asistió, libera el cupo.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          attended: { type: 'boolean', description: 'true si vino, false si no se presentó.' },
        },
        required: ['appointment_id', 'attended'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_estimated_finish',
      description: 'Carga la hora estimada en que un pedido va a estar listo HOY (la que dice el dueño). A esa hora se le va a preguntar al dueño si terminó.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          time: { type: 'string', description: 'Hora estimada de finalización HH:MM (24h).' },
        },
        required: ['appointment_id', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_finished',
      description: 'Marca un pedido como TERMINADO cuando el dueño lo confirma. Le avisa automáticamente al cliente que puede pasar a retirarlo. Usala SIEMPRE que el dueño confirme que terminó un pedido.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_reschedule_to_client',
      description: 'Le escribe al cliente ofreciéndole los próximos cupos con prioridad para reagendar (ej: tras una inasistencia, si el dueño te lo pide).',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          reason: { type: 'string', description: 'Motivo opcional para el mensaje.' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_free_slots',
      description: 'Muestra los horarios LIBRES de un día puntual, o los próximos días con cupo si no se pasa fecha. Usala cuando el dueño pregunta "qué horarios tengo libres mañana" o "cuándo tengo lugar".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día puntual YYYY-MM-DD. Si se omite, devuelve los próximos días con cupo.' },
          days: { type: 'number', description: 'Cuántos días con cupo listar cuando no se pasa fecha (default 5).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_appointments',
      description: 'Busca turnos por nombre del cliente, teléfono, patente/pedido o servicio. Usala cuando el dueño dice "buscá el turno de Pedro", "el turno del Gol blanco", "turnos de tal patente", etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar: nombre, teléfono, patente, modelo o servicio.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'block_schedule',
      description: 'Bloquea la agenda para que el bot no ofrezca ni agende esos momentos. Sin "times" bloquea el/los día(s) completo(s) (feriado, vacaciones). Con "times" bloquea solo esos horarios de ese día.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día a bloquear YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'Opcional: fin del rango YYYY-MM-DD para bloquear varios días completos.' },
          times: { type: 'array', items: { type: 'string' }, description: 'Opcional: horarios HH:MM a bloquear ese día (ej: ["14:00","14:30"]). Si se omite, se bloquea el día completo.' },
          note: { type: 'string', description: 'Motivo opcional (feriado, vacaciones, etc.).' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unblock_schedule',
      description: 'Quita los bloqueos de un día (o rango), volviendo a habilitar la agenda.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día a desbloquear YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'Opcional: fin del rango YYYY-MM-DD.' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_blocks',
      description: 'Lista los bloqueos de agenda vigentes en un rango (por defecto los próximos 60 días).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (default hoy).' },
          date_to: { type: 'string', description: 'Fin del rango YYYY-MM-DD (default +60 días).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'business_metrics',
      description: 'Devuelve métricas del negocio en un rango: cantidad de turnos, por estado, por servicio, clientes que escribieron y volumen de mensajes. Usala para "cuántos turnos tengo esta semana", "qué servicios se piden más", "pasame números del día/semana".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (default hoy).' },
          date_to: { type: 'string', description: 'Fin del rango YYYY-MM-DD (default = date).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'day_summary',
      description: 'Arma el resumen del día: turnos de hoy y qué clientes escribieron. Usala cuando el dueño pide "pasame el resumen del día" o "cómo viene hoy".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día YYYY-MM-DD (default hoy).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_contact_bot_mode',
      description: 'Pone a un cliente en modo MANUAL (el bot deja de responderle, lo atiendel dueño) o lo devuelve a modo BOT (el bot vuelve a atenderlo). Identificá al cliente por teléfono o por nombre. Usala para "poné el bot en modo manual para este cliente" / "reactivá el bot para tal cliente".',
      parameters: {
        type: 'object',
        properties: {
          client_phone: { type: 'string', description: 'Teléfono del cliente (con código de país). Preferí esto si lo tenés.' },
          client_name: { type: 'string', description: 'Nombre del cliente si no tenés el teléfono (se busca en los turnos).' },
          mode: { type: 'string', enum: ['manual', 'bot'], description: 'manual = lo atiendel dueño; bot = lo atiende el asistente.' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_business_hours',
      description: 'Cambia de forma simple la configuración de la agenda: capacidad de turnos por día, horarios de entrega ofrecidos y/o días laborables. Confirmá con el dueño antes de cambiar.',
      parameters: {
        type: 'object',
        properties: {
          capacity_per_day: { type: 'number', description: 'Cuántos turnos por día.' },
          slots: { type: 'array', items: { type: 'string' }, description: 'Horarios de entrega ofrecidos HH:MM (ej: ["08:00","08:30","09:00"]).' },
          workdays: { type: 'array', items: { type: 'number' }, description: 'Días laborables 0=Dom..6=Sáb (ej: [1,2,3,4,5,6]).' },
        },
        required: [],
      },
    },
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function prettyDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' }).format(d);
}

function fmtAppt(a) {
  return {
    id: a.id, date: a.date, time: a.time, status: a.status,
    client_name: a.client_name, detail: a.detail, service: a.service,
    estimated_finish: a.estimated_finish || null, ready_date: a.ready_date || null,
    phone: a.client_phone,
  };
}

function slotOptionsText(options) {
  if (!options.length) return 'En los próximos días no tengo cupos libres; te contacto cuando se libere uno.';
  return options.map((o) => `• ${prettyDate(o.date)}: ${o.slots.join(', ')} hs`).join('\n');
}

/** Envía un mensaje a un cliente (lazy-require de baileys para evitar ciclos). */
async function sendToClient(phoneDigits, text) {
  const num = normalizePhone(phoneDigits);
  if (!num) return false;
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    console.warn('[ASSISTANT] WhatsApp no conectado; no se pudo escribir al cliente.');
    return false;
  }
  try {
    await sendMessage(`${num}@s.whatsapp.net`, text);
    return true;
  } catch (err) {
    console.error('[ASSISTANT] Error escribiendo al cliente:', err.message);
    return false;
  }
}

/** Mensaje al cliente ofreciéndole reagendar con prioridad. */
function priorityOfferText(appt, reason) {
  const options = local.nextAvailableSlots(3);
  const reasonTxt = reason ? ` (${reason})` : '';
  return (
    `Hola${appt.client_name ? ' ' + appt.client_name : ''}, te escribimos de *${getBusinessName()}*.${reasonTxt ? reasonTxt : ''} ` +
    `Queremos reagendar tu turno y te damos *prioridad*. Tenemos lugar:\n${slotOptionsText(options)}\n\n` +
    `¿Cuál te queda cómodo? Respondé y te lo agendo.`
  );
}

/** Mensaje al cliente avisando que su trabajo/servicio está listo para retirar. */
function pickupText(appt) {
  const address = (getConfig('business_address') || '').trim();
  const addressLine = address ? `Podés pasar a retirarlo por ${address} ` : 'Ya podés pasar a retirarlo ';
  return (
    `✅ ¡Hola${appt.client_name ? ' ' + appt.client_name : ''}! Te escribimos de *${getBusinessName()}*: ` +
    `tu ${appt.detail || 'pedido'} ya está listo. ${addressLine}` +
    `en nuestro horario de atención. ¡Gracias por confiar en nosotros! 🙌`
  );
}

/**
 * Envía un mensaje proactivo al dueño y lo deja en el historial de su asistente,
 * para que cuando responda, el modelo tenga el contexto de lo que se le preguntó.
 */
async function sendToOwnerAndRemember(text) {
  const num = normalizePhone(getConfig('owner_number'));
  if (!num) return false;
  const jid = `${num}@s.whatsapp.net`;
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    console.warn('[ASSISTANT] WhatsApp no conectado; no se pudo escribir al dueño.');
    return false;
  }
  try {
    await sendMessage(jid, text);
    const state = getConversationState(jid);
    const history = [...state.history, { role: 'assistant', content: text }].slice(-MAX_HISTORY_MESSAGES);
    saveConversationState(jid, history, state.step, state.detail, false);
    return true;
  } catch (err) {
    console.error('[ASSISTANT] Error escribiendo al dueño:', err.message);
    return false;
  }
}

// ─── Ejecutor de herramientas ─────────────────────────────────────────────────

async function executeAssistantTool(toolName, args) {
  try {
    if (toolName === 'list_appointments') {
      const from = args.date || local.todayAR();
      const to = args.date_to || from;
      const appts = getAppointmentsBetween(from, to);
      return JSON.stringify({ from, to, count: appts.length, appointments: appts.map(fmtAppt) });
    }

    if (toolName === 'list_day_contacts') {
      const date = args.date || local.todayAR();
      const startUTC = new Date(`${date}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const endUTC = new Date(`${local.addDays(date, 1)}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const msgs = getMessagesBetween(startUTC, endUTC);
      const byPhone = new Map();
      for (const m of msgs) {
        const num = normalizePhone(m.phone);
        if (!byPhone.has(num)) byPhone.set(num, []);
        byPhone.get(num).push({ dir: m.direction, content: m.content });
      }
      const contacts = [...byPhone.entries()].map(([phone, list]) => ({
        phone,
        total: list.length,
        incoming: list.filter((x) => x.dir === 'incoming').length,
        messages: list.slice(-12), // últimas para resumir
      }));
      return JSON.stringify({ date, contacts_count: contacts.length, contacts }).slice(0, 7000);
    }

    if (toolName === 'cancel_appointment') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      if (appt.status === 'cancelled') return JSON.stringify({ success: false, error: 'Ese turno ya estaba cancelado.' });

      const res = await cal.cancelAppointment(args.appointment_id);
      if (!res.success) return JSON.stringify(res);

      let clientNotified = false;
      if (args.notify_client !== false) {
        const options = local.nextAvailableSlots(3);
        const reasonTxt = args.reason ? ` (${args.reason})` : '';
        const msg =
          `Hola${appt.client_name ? ' ' + appt.client_name : ''}, te escribimos de *${getBusinessName()}*. ` +
          `Tuvimos que cancelar tu turno del ${prettyDate(appt.date)}${appt.time ? ' a las ' + appt.time + ' hs' : ''}${reasonTxt}. ` +
          `Disculpá las molestias 🙏\n\nTe damos *prioridad* para reagendarlo. Tenemos lugar:\n${slotOptionsText(options)}\n\n` +
          `¿Cuál te queda cómodo? Respondé y te lo agendo.`;
        clientNotified = await sendToClient(appt.client_phone, msg);
      }
      return JSON.stringify({
        success: true, cancelled_id: appt.id, client_notified: clientNotified,
        message: `Turno de ${appt.client_name || appt.client_phone} (${appt.date}) cancelado.${clientNotified ? ' Le avisé al cliente y le ofrecí reagendar con prioridad.' : ''}`,
      });
    }

    if (toolName === 'create_appointment_manual') {
      const res = await cal.createAppointment({
        client_name: args.client_name, client_phone: args.client_phone,
        detail: args.detail, service: args.service,
        date: args.date, start_time: args.start_time,
        notifyOwner: false, // lo está creando el propio el dueño
      });
      return JSON.stringify(res);
    }

    if (toolName === 'reschedule_appointment') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const res = await cal.rescheduleAppointment(args.appointment_id, args.new_date, args.new_time);
      if (!res.success) return JSON.stringify(res);

      let clientNotified = false;
      if (args.notify_client !== false) {
        const a = res.appointment;
        const msg =
          `Hola${a.client_name ? ' ' + a.client_name : ''}, te escribimos de *${getBusinessName()}*. ` +
          `Reprogramamos tu turno para el ${prettyDate(a.date)}${a.time ? ' a las ' + a.time + ' hs' : ''}. ` +
          `Si no te queda bien, avisanos y lo reacomodamos. ¡Gracias!`;
        clientNotified = await sendToClient(a.client_phone, msg);
      }
      return JSON.stringify({ success: true, appointment: fmtAppt(res.appointment), client_notified: clientNotified });
    }

    if (toolName === 'set_ready_date') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, { ready_date: args.ready_date });
      return JSON.stringify({
        success: true,
        message: `Anotado: el ${appt.detail || 'pedido'} de ${appt.client_name || appt.client_phone} queda listo el ${args.ready_date}.`,
      });
    }

    if (toolName === 'set_attendance') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const who = appt.client_name || appt.client_phone;
      if (args.attended === false) {
        updateAppointment(args.appointment_id, { status: 'no_show' });
        return JSON.stringify({
          success: true, status: 'no_show',
          message: `Marqué que ${who} no asistió y liberé el cupo. ¿Querés que le escriba para reagendar con prioridad?`,
        });
      }
      updateAppointment(args.appointment_id, { status: 'attended' });
      return JSON.stringify({ success: true, status: 'attended', message: `Anotado: ${who} asistió.` });
    }

    if (toolName === 'set_estimated_finish') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, { estimated_finish: args.time, status: 'in_progress', finish_check_sent: 0 });
      return JSON.stringify({
        success: true,
        message: `Listo, ${appt.detail || 'el pedido'} de ${appt.client_name || appt.client_phone} estimado para las ${args.time}. Te aviso a esa hora para confirmar.`,
      });
    }

    if (toolName === 'mark_finished') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, {
        status: 'finished',
        finished_at: new Date().toISOString(),
        ready_date: appt.ready_date || local.todayAR(),
      });
      const notified = await sendToClient(appt.client_phone, pickupText(appt));
      updateAppointment(args.appointment_id, { pickup_notified: notified ? 1 : 0 });
      return JSON.stringify({
        success: true, client_notified: notified,
        message: `Marqué terminado el ${appt.detail || 'pedido'} de ${appt.client_name || appt.client_phone}.` +
          (notified ? ' Le avisé al cliente que puede pasar a retirarlo.' : ' (No pude avisar al cliente: WhatsApp desconectado.)'),
      });
    }

    if (toolName === 'offer_reschedule_to_client') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const notified = await sendToClient(appt.client_phone, priorityOfferText(appt, args.reason));
      return JSON.stringify({
        success: true, client_notified: notified,
        message: notified
          ? `Le escribí a ${appt.client_name || appt.client_phone} ofreciéndole reagendar con prioridad.`
          : 'No pude escribirle al cliente (WhatsApp desconectado).',
      });
    }

    if (toolName === 'check_free_slots') {
      if (args.date) {
        const avail = await local.getAvailability(args.date);
        return JSON.stringify({ date: args.date, ...avail });
      }
      const options = local.nextAvailableSlots(args.days || 5);
      return JSON.stringify({
        next_days: options.map((o) => ({ date: o.date, slots: o.slots })),
        message: options.length ? undefined : 'No hay cupos libres en los próximos días.',
      });
    }

    if (toolName === 'search_appointments') {
      const results = searchAppointments(args.query, 20);
      return JSON.stringify({ query: args.query, count: results.length, appointments: results.map(fmtAppt) });
    }

    if (toolName === 'block_schedule') {
      const from = args.date;
      const to = args.date_to || args.date;
      const note = args.note || '';
      const blocked = [];
      if (Array.isArray(args.times) && args.times.length) {
        // Bloqueo de horarios puntuales (solo aplica al día `from`).
        for (const t of args.times) { addBlockedSlot(from, t, note); blocked.push(`${from} ${t}`); }
      } else {
        // Bloqueo de día(s) completo(s) en el rango.
        let d = from;
        let guard = 0;
        while (d <= to && guard < 120) { addBlockedSlot(d, '', note); blocked.push(d); d = local.addDays(d, 1); guard++; }
      }
      return JSON.stringify({ success: true, blocked, message: `Bloqueé: ${blocked.join(', ')}.` });
    }

    if (toolName === 'unblock_schedule') {
      const from = args.date;
      const to = args.date_to || args.date;
      let d = from;
      let guard = 0;
      const cleared = [];
      while (d <= to && guard < 120) { removeBlocksOnDate(d); cleared.push(d); d = local.addDays(d, 1); guard++; }
      return JSON.stringify({ success: true, unblocked: cleared, message: `Desbloqueé: ${cleared.join(', ')}.` });
    }

    if (toolName === 'list_blocks') {
      const from = args.date || local.todayAR();
      const to = args.date_to || local.addDays(from, 60);
      const blocks = getBlockedSlots(from, to).map((b) => ({
        id: b.id, date: b.date, time: b.time || '(día completo)', note: b.note || '',
      }));
      return JSON.stringify({ from, to, count: blocks.length, blocks });
    }

    if (toolName === 'business_metrics') {
      const from = args.date || local.todayAR();
      const to = args.date_to || from;
      const appts = getAllAppointmentsBetween(from, to);
      const byStatus = {};
      const byService = {};
      for (const a of appts) {
        byStatus[a.status] = (byStatus[a.status] || 0) + 1;
        const s = (a.service || 'sin especificar').trim();
        byService[s] = (byService[s] || 0) + 1;
      }
      // Actividad de mensajería en el rango (límites UTC del rango AR).
      const startUTC = new Date(`${from}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const endUTC = new Date(`${local.addDays(to, 1)}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const msgs = getMessagesBetween(startUTC, endUTC);
      const phones = new Set(msgs.map((m) => normalizePhone(m.phone)));
      const incoming = msgs.filter((m) => m.direction === 'incoming').length;
      return JSON.stringify({
        from, to,
        appointments_total: appts.length,
        appointments_by_status: byStatus,
        appointments_by_service: byService,
        clients_messaged: phones.size,
        incoming_messages: incoming,
      });
    }

    if (toolName === 'day_summary') {
      const date = args.date || local.todayAR();
      const appts = getAppointmentsBetween(date, date).map(fmtAppt);
      const startUTC = new Date(`${date}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const endUTC = new Date(`${local.addDays(date, 1)}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const msgs = getMessagesBetween(startUTC, endUTC);
      const byPhone = new Map();
      for (const m of msgs) {
        const num = normalizePhone(m.phone);
        if (!byPhone.has(num)) byPhone.set(num, { phone: num, incoming: 0, last: '' });
        const e = byPhone.get(num);
        if (m.direction === 'incoming') { e.incoming++; e.last = m.content; }
      }
      return JSON.stringify({
        date,
        appointments_count: appts.length,
        appointments: appts,
        contacts: [...byPhone.values()].filter((c) => c.incoming > 0).slice(0, 30),
      }).slice(0, 7000);
    }

    if (toolName === 'set_contact_bot_mode') {
      let phone = normalizePhone(args.client_phone);
      if (!phone && args.client_name) {
        const matches = searchAppointments(args.client_name, 10);
        const uniquePhones = [...new Set(matches.map((m) => normalizePhone(m.client_phone)))];
        if (uniquePhones.length === 1) phone = uniquePhones[0];
        else if (uniquePhones.length > 1) {
          return JSON.stringify({
            success: false, ambiguous: true,
            message: `Hay varios clientes que coinciden con "${args.client_name}". Pedile al dueño el teléfono o más datos.`,
            candidates: matches.map((m) => ({ name: m.client_name, phone: m.client_phone, car: m.detail })),
          });
        }
      }
      if (!phone) return JSON.stringify({ success: false, error: 'No identifiqué al cliente. Necesito su teléfono o un nombre que coincida con un turno.' });
      const jid = `${phone}@s.whatsapp.net`;
      if (args.mode === 'manual') {
        pauseContact(jid);
        global.io?.emit('chat:paused', { phone: jid, reason: 'admin_manual' });
        return JSON.stringify({ success: true, phone, mode: 'manual', message: `Listo: el bot quedó en modo MANUAL para ${phone}. Lo atendés vos; el bot no le responde.` });
      }
      resumeContact(jid);
      global.io?.emit('chat:resumed', { phone: jid });
      return JSON.stringify({ success: true, phone, mode: 'bot', message: `Listo: reactivé el bot para ${phone}.` });
    }

    if (toolName === 'set_business_hours') {
      const changes = [];
      if (Number.isFinite(args.capacity_per_day)) {
        setConfig('cal_capacity_per_day', String(Math.max(1, Math.round(args.capacity_per_day))));
        changes.push(`capacidad: ${Math.round(args.capacity_per_day)}/día`);
      }
      if (Array.isArray(args.slots) && args.slots.length) {
        const slots = args.slots.map((s) => String(s).trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
        if (slots.length) { setConfig('cal_slots', slots.join(',')); changes.push(`horarios: ${slots.join(', ')}`); }
      }
      if (Array.isArray(args.workdays) && args.workdays.length) {
        const wd = [...new Set(args.workdays.map(Number).filter((n) => n >= 0 && n <= 6))];
        if (wd.length) { setConfig('cal_workdays', wd.join(',')); changes.push(`días laborables: ${wd.join(',')}`); }
      }
      if (!changes.length) return JSON.stringify({ success: false, error: 'No me pasaste ningún cambio válido.' });
      return JSON.stringify({ success: true, message: `Configuración actualizada → ${changes.join(' · ')}.` });
    }

    return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
  } catch (err) {
    console.error(`[ASSISTANT] Error en ${toolName}:`, err.message);
    return JSON.stringify({ success: false, error: `No se pudo ejecutar: ${err.message}` });
  }
}

// ─── Procesamiento del mensaje del dueño ───────────────────────────────────────

async function processAssistantMessage(phone, input) {
  const { text: userText, media, logText } = normalizeInput(input);
  const systemPrompt = buildAssistantPrompt();
  const state = getConversationState(phone);

  const history = [...state.history, { role: 'user', content: logText || userText || '[mensaje]' }]
    .slice(-MAX_HISTORY_MESSAGES);
  const apiMessages = withCurrentMedia(history, userText, media);

  let reply;
  try {
    reply = await callOpenRouter(apiMessages, systemPrompt, {
      clientPhone: phone,
      tools: ASSISTANT_TOOLS,
      executeToolFn: executeAssistantTool,
    });
  } catch (err) {
    console.error('[ASSISTANT] Error llamando a OpenRouter:', err.response?.data || err.message);
    reply = 'Uh, tuve un problema técnico procesando eso. Probá de nuevo en un momento.';
  }

  saveConversationState(phone, [...history, { role: 'assistant', content: reply }], state.step, state.detail, false);
  return reply;
}

module.exports = {
  processAssistantMessage, buildAssistantPrompt, ASSISTANT_TOOLS, executeAssistantTool,
  sendToOwnerAndRemember,
};
