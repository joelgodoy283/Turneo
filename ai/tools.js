/**
 * Definición de herramientas (Tool Calling) disponibles para la IA.
 * Cada tool tiene: nombre, descripción, parámetros JSON Schema, y función ejecutora.
 */
const { getAvailability, createAppointment, isConfigured } = require('../calendar');
const { getPendingReview, updateAppointment } = require('../database/db');

// ─── Definición de tools para OpenRouter (formato OpenAI) ─────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'check_calendar_availability',
      description: 'Consulta la disponibilidad del negocio en una fecha específica. Úsala cuando el cliente quiera conocer los días u horarios disponibles para un turno.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Fecha a consultar en formato YYYY-MM-DD. Calculala a partir de la FECHA ACTUAL indicada en el system prompt (ej: si hoy es 2026-06-22 y el cliente dice "mañana", usá "2026-06-23").',
          },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment',
      description: 'Crea un turno en el calendario del negocio. Úsala solo cuando el cliente confirmó todos sus datos (nombre, auto, problema) y eligió fecha y hora.',
      parameters: {
        type: 'object',
        properties: {
          client_name: {
            type: 'string',
            description: 'Nombre completo del cliente',
          },
          car_info: {
            type: 'string',
            description: 'Descripción del vehículo: marca, modelo, año y problema. Ejemplo: "Ford Focus 2018 - Cambio de pastillas de freno"',
          },
          date: {
            type: 'string',
            description: 'Fecha del turno en formato YYYY-MM-DD. Calculala a partir de la FECHA ACTUAL indicada en el system prompt (ej: "mañana", "el lunes" → fecha real).',
          },
          start_time: {
            type: 'string',
            description: 'Hora de inicio en formato HH:MM. Ejemplo: "10:00"',
          },
          end_time: {
            type: 'string',
            description: 'Hora de fin estimada en formato HH:MM (generalmente 1 hora después). Ejemplo: "11:00"',
          },
          client_phone: {
            type: 'string',
            description: 'NO completar: el sistema adjunta automáticamente el número de WhatsApp del cliente. Dejalo vacío.',
          },
        },
        required: ['client_name', 'car_info', 'date', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_service_rating',
      description: 'Registra la valoración del cliente sobre el servicio recibido. Usala SOLO cuando el cliente tiene un pedido de reseña pendiente y te da una nota del 1 al 10, o te confirma que dejó la reseña en Google.',
      parameters: {
        type: 'object',
        properties: {
          rating: { type: 'number', description: 'Nota del 1 al 10 que dio el cliente (si la dio).' },
          left_google_review: { type: 'boolean', description: 'true si el cliente confirma que dejó la reseña en Google.' },
        },
        required: [],
      },
    },
  },
];

// ─── Ejecutor de tools ────────────────────────────────────────────────────

async function executeTool(toolName, args, clientPhone) {
  if (!isConfigured()) {
    return JSON.stringify({
      error: 'El sistema de turnos no está disponible. Dejá tu nombre y número para que el dueño te contacte.',
    });
  }

  try {
    if (toolName === 'check_calendar_availability') {
      const result = await getAvailability(args.date);
      return JSON.stringify(result);
    }

    if (toolName === 'create_appointment') {
      const result = await createAppointment({
        client_name:  args.client_name,
        car_info:     args.car_info,
        date:         args.date,
        start_time:   args.start_time,
        end_time:     args.end_time,
        client_phone: args.client_phone || clientPhone,
      });
      return JSON.stringify(result);
    }

    if (toolName === 'record_service_rating') {
      const pending = getPendingReview(clientPhone);
      if (!pending) {
        return JSON.stringify({ success: false, error: 'No hay ninguna reseña pendiente para este cliente.' });
      }
      const fields = { review_done: 1 };
      if (typeof args.rating === 'number') {
        fields.review_rating = Math.max(1, Math.min(10, Math.round(args.rating)));
      }
      updateAppointment(pending.id, fields);
      console.log(`[REVIEW] Cliente ${clientPhone} valoró el servicio:`, fields.review_rating ?? '(reseña en Google)');
      return JSON.stringify({ success: true, recorded_rating: fields.review_rating ?? null });
    }

    return JSON.stringify({ error: `Tool desconocida: ${toolName}` });
  } catch (err) {
    console.error(`[TOOL] Error ejecutando ${toolName}:`, err.message);
    return JSON.stringify({ error: `No se pudo ejecutar la acción: ${err.message}` });
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
