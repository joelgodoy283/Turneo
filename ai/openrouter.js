const axios = require('axios');
const { getConfig, getServices, getConversationState, saveConversationState, getPendingReview } = require('../database/db');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');
const { isEnabled: supabaseEnabled, getClientProfile, upsertClientProfile } = require('../supabase/client');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Ventana de historial dinámica: cliente nuevo (sin perfil) 60, recurrente 30.
const HISTORY_NEW = 60;
const HISTORY_RETURNING = 30;

/**
 * Llama a la API de OpenRouter con soporte de tool calling.
 * Ejecuta el loop de herramientas automáticamente hasta obtener una respuesta final.
 */
async function callOpenRouter(messages, systemPrompt, opts = {}) {
  const {
    clientPhone = null,
    tools = TOOL_DEFINITIONS,
    executeToolFn = executeTool,
  } = opts;

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  if (!apiKey || apiKey === 'sk-or-v1-xxxxxxxxxxxxxxxx') {
    return 'Lo siento, el asistente no está configurado aún. Por favor contactá directamente con Lucas al taller.';
  }

  const allMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  let iteraciones = 0;
  const MAX_ITER = 5; // Máximo de rondas de tool calling para evitar loops infinitos

  while (iteraciones < MAX_ITER) {
    iteraciones++;

    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: allMessages,
        tools,
        tool_choice: 'auto',
        max_tokens: 1024,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lc-performance.com',
          'X-Title': 'LC Performance WhatsApp Bot',
        },
        timeout: 30000,
      }
    );

    const choice = response.data.choices[0];
    const message = choice.message;

    // Agregar la respuesta del asistente al historial de la llamada
    allMessages.push(message);

    // Si el modelo no pidió ninguna tool → respuesta final
    if (choice.finish_reason !== 'tool_calls' || !message.tool_calls?.length) {
      return message.content || 'Disculpá, no pude procesar tu consulta. ¿Podés repetirla?';
    }

    // Ejecutar cada tool call solicitada
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      console.log(`[AI] Ejecutando tool: ${toolName}`, args);
      const toolResult = await executeToolFn(toolName, args, clientPhone);

      allMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    // Volver a llamar con los resultados de las tools
  }

  return 'Lo siento, tuve un problema al procesar tu solicitud. Por favor escribí "hablar con Lucas" para atención personalizada.';
}

/**
 * Devuelve la fecha y hora actual en español, zona horaria de Argentina.
 * Se inyecta en el system prompt para que la IA entienda "hoy", "mañana", etc.
 */
function currentDateLine() {
  const now = new Date();
  const TZ = 'America/Argentina/Buenos_Aires';
  const fecha = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);
  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  // Fecha en formato YYYY-MM-DD (la que esperan las tools del calendario)
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return { texto: `${fecha}, ${hora} hs (hora de Argentina)`, iso };
}

/**
 * Normaliza el input de un mensaje entrante. Acepta un string (texto plano) o
 * un objeto { text, media, logText } (cuando vino con audio/imagen).
 */
function normalizeInput(input) {
  if (typeof input === 'string') return { text: input, media: null, logText: input };
  return {
    text: input?.text || '',
    media: input?.media || null,
    logText: input?.logText || input?.text || '',
  };
}

/** Mapea el mimetype de WhatsApp al formato que espera OpenRouter para audio. */
function audioFormat(mime = '') {
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  if (m.includes('aac')) return 'aac';
  if (m.includes('flac')) return 'flac';
  return 'ogg'; // notas de voz de WhatsApp (audio/ogg; codecs=opus)
}

/**
 * Construye el `content` del mensaje de usuario para la API. Si hay un medio
 * (imagen/audio), devuelve un array multimodal; si no, el texto plano.
 */
function buildUserContent(text, media) {
  if (!media) return text || '';
  if (media.kind === 'image') {
    return [
      { type: 'text', text: text || 'El cliente envió esta imagen. Mirala y respondé en base a lo que muestra.' },
      { type: 'image_url', image_url: { url: `data:${media.mime || 'image/jpeg'};base64,${media.dataB64}` } },
    ];
  }
  if (media.kind === 'audio') {
    return [
      { type: 'text', text: text || 'El cliente envió esta nota de voz. Entendé lo que dice y respondé acorde.' },
      { type: 'input_audio', input_audio: { data: media.dataB64, format: audioFormat(media.mime) } },
    ];
  }
  return text || '';
}

/**
 * Inserta el contenido multimodal en el último mensaje (el actual) del historial
 * que se manda a la API, dejando el resto como texto. Devuelve un array nuevo.
 */
function withCurrentMedia(messages, text, media) {
  if (!media) return messages;
  const copy = messages.map((m) => ({ ...m }));
  copy[copy.length - 1] = { role: 'user', content: buildUserContent(text, media) };
  return copy;
}

/**
 * Genera una descripción/transcripción ÚTIL de un medio (audio/imagen) para
 * guardar en el historial y mostrar en el panel, en lugar de "[Imagen]" o
 * "[Nota de voz]". Para audio devuelve la transcripción; para imagen, una
 * descripción breve. Se puede desactivar con la config `media_transcribe_enabled`.
 *
 * Devuelve un string (con prefijo emoji) o null si no se pudo / está desactivado.
 * No lanza: ante cualquier error devuelve null para que el caller use el placeholder.
 */
async function describeMedia(media, caption = '') {
  if (!media || !media.dataB64) return null;
  if (getConfig('media_transcribe_enabled') === 'false') return null;

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  if (!apiKey || apiKey === 'sk-or-v1-xxxxxxxxxxxxxxxx') return null;

  const isAudio = media.kind === 'audio';
  const sys = isAudio
    ? 'Sos un transcriptor. Transcribí EXACTAMENTE lo que se dice en la nota de voz, en español. ' +
      'Devolvé SOLO la transcripción, sin comillas ni comentarios. Si no se entiende nada, devolvé "(audio inaudible)".'
    : 'Describí en UNA frase breve, en español, qué muestra la imagen (objeto/vehículo/parte/daño/texto visible). ' +
      'Si es una captura con texto, resumí lo importante. Devolvé SOLO la descripción.';

  const userContent = isAudio
    ? [
        { type: 'text', text: caption ? `Contexto del cliente: "${caption}".` : 'Transcribí la nota de voz.' },
        { type: 'input_audio', input_audio: { data: media.dataB64, format: audioFormat(media.mime) } },
      ]
    : [
        { type: 'text', text: caption ? `Epígrafe del cliente: "${caption}".` : 'Describí la imagen.' },
        { type: 'image_url', image_url: { url: `data:${media.mime || 'image/jpeg'};base64,${media.dataB64}` } },
      ];

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userContent },
        ],
        max_tokens: 300,
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lc-performance.com',
          'X-Title': 'LC Performance WhatsApp Bot',
        },
        timeout: 30000,
      }
    );
    const out = (response.data.choices[0]?.message?.content || '').trim();
    if (!out) return null;
    const clean = out.replace(/\s+/g, ' ').slice(0, 500);
    if (isAudio) return `🎤 ${clean}`;
    return caption ? `🖼️ ${caption} — ${clean}` : `🖼️ ${clean}`;
  } catch (err) {
    console.error('[AI] Error describiendo medio:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * Construye el system prompt combinando el prompt configurable con la fecha
 * actual y la lista de servicios cargados desde la solapa "Servicios".
 *
 * Precios: por defecto la IA NO informa precios (los servicios se inyectan sin
 * monto). Se puede habilitar desde el dashboard con la config `share_prices`.
 */
function buildSystemPrompt() {
  const base = getConfig('ai_prompt') || 'Eres un asistente de taller mecánico.';
  const sharePrices = getConfig('share_prices') === 'true';
  const services = getServices();

  const { texto: fechaTexto, iso: fechaIso } = currentDateLine();

  const dateBlock = `FECHA Y HORA ACTUAL:
Hoy es ${fechaTexto}. En formato ISO: ${fechaIso}.
Usá SIEMPRE esta fecha para interpretar expresiones como "hoy", "mañana", "pasado mañana", "el lunes", "la semana que viene", etc. Cuando consultes disponibilidad o agendes un turno, calculá la fecha real a partir de esta fecha actual y pasala a las herramientas en formato YYYY-MM-DD.`;

  // Regla de precios (siempre presente, decide el comportamiento)
  const priceRule = sharePrices
    ? 'PRECIOS: Podés informar los precios de los servicios listados abajo cuando el cliente los pida.'
    : 'PRECIOS: NO informes precios, montos ni presupuestos bajo ninguna circunstancia, aunque el cliente insista. Si preguntan por precios, respondé amablemente que los valores los confirma Lucas personalmente luego de revisar el vehículo, y ofrecé agendar un turno o tomar los datos para que Lucas lo contacte.';

  let prompt = `${base}

${dateBlock}

${priceRule}`;

  if (services.length) {
    const lines = services.map((s) => {
      const parts = [`- ${s.name}`];
      if (s.description) parts.push(s.description);
      let line = parts.join(': ');
      if (sharePrices && s.price) line += ` | Precio: ${s.price}`;
      if (s.notes) line += ` | A tener en cuenta: ${s.notes}`;
      return line;
    });

    const serviciosHeader = sharePrices
      ? 'SERVICIOS DEL TALLER (usá esta información para responder sobre servicios, precios y detalles):'
      : 'SERVICIOS DEL TALLER (usá esta información para responder sobre servicios y detalles, SIN mencionar precios):';

    prompt += `

${serviciosHeader}
${lines.join('\n')}`;
  }

  return prompt;
}

/**
 * Da formato al perfil del cliente para inyectarlo en el system prompt.
 */
function formatClientProfile(p) {
  const parts = [];
  if (p.nombre)          parts.push(`Nombre: ${p.nombre}`);
  if (p.vehiculos)       parts.push(`Vehículo(s): ${p.vehiculos}`);
  if (p.estilo)          parts.push(`Estilo de habla: ${p.estilo}`);
  if (p.ultimo_servicio) parts.push(`Último servicio: ${p.ultimo_servicio}`);
  if (p.resumen)         parts.push(`Resumen: ${p.resumen}`);
  return parts.join('\n');
}

/**
 * Parseo tolerante de JSON (quita fences ```json y texto alrededor).
 */
function parseJsonLoose(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Actualiza (con IA) el perfil del cliente en Supabase a partir de la
 * conversación. Throttle: en el primer mensaje y luego cada 4, para no
 * gastar tokens de más. Fire-and-forget (no bloquea la respuesta).
 */
async function maybeUpdateClientProfile(phone, history) {
  if (!supabaseEnabled()) return;
  try {
    const profile = await getClientProfile(phone);
    const userMsgs = history.filter((m) => m.role === 'user').length;
    if (profile && userMsgs % 4 !== 0) return; // throttle

    const transcript = history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
      .join('\n')
      .slice(-4000);

    const sys =
      'Analizá la conversación y devolvé SOLO un JSON válido (sin texto extra) con las claves: ' +
      'nombre (string|null), vehiculos (string|null), estilo (cómo habla el cliente: formal/informal, ' +
      'usa modismos, mensajes largos/cortos, etc.), resumen (1-2 frases sobre quién es y qué necesita), ' +
      'ultimo_servicio (string|null). Si un dato no aparece, devolvé null o mantené lo ya conocido.';
    const user = (profile ? `Perfil actual: ${JSON.stringify(profile)}\n\n` : '') + `Conversación:\n${transcript}`;

    const raw = await simpleCompletion(sys, user);
    const json = parseJsonLoose(raw);
    if (!json) return;

    await upsertClientProfile(phone, {
      nombre:          json.nombre          ?? profile?.nombre          ?? null,
      vehiculos:       json.vehiculos       ?? profile?.vehiculos       ?? null,
      estilo:          json.estilo          ?? profile?.estilo          ?? null,
      resumen:         json.resumen         ?? profile?.resumen         ?? null,
      ultimo_servicio: json.ultimo_servicio ?? profile?.ultimo_servicio ?? null,
    });
  } catch (err) {
    console.error('[AI] Error actualizando perfil del cliente:', err.message);
  }
}

/**
 * Procesa un mensaje entrante del cliente y retorna la respuesta del bot.
 * Gestiona el historial de conversación desde la base de datos.
 */
async function processMessage(phone, input) {
  const { text: userText, media, logText } = normalizeInput(input);
  const systemPrompt = buildSystemPrompt();
  const state = getConversationState(phone);

  // En el historial guardamos un texto legible (placeholder para audios/imágenes);
  // el medio en sí solo se manda en la llamada actual, no se persiste ni se reenvía.
  const userMessage = { role: 'user', content: logText || userText || '[mensaje]' };

  // Si es la primera interacción, agregar contexto al prompt del sistema
  let contextualPrompt = state.is_new
    ? systemPrompt + '\n\nCONTEXTO: Este es el PRIMER mensaje de este cliente. Debes presentarte como asistente virtual con IA.'
    : systemPrompt;

  // Memoria de largo plazo: inyectar el perfil del cliente si existe
  const profile = await getClientProfile(phone);

  // Ventana de historial: cliente NUEVO (sin perfil/resumen) → 60 mensajes;
  // cliente que ya habló antes (tiene resumen) → 30, porque su memoria de largo
  // plazo ya vive en el perfil y no hace falta arrastrar tanto contexto.
  const historyLimit = profile ? HISTORY_RETURNING : HISTORY_NEW;

  if (profile) {
    contextualPrompt +=
      '\n\nPERFIL DEL CLIENTE (memoria de interacciones previas; usalo para personalizar el trato, ' +
      'saludarlo por su nombre, recordar su vehículo y ADAPTAR TU TONO al de él):\n' +
      formatClientProfile(profile);
  }

  // Reseña pendiente: si a este cliente se le pidió una reseña y aún no respondió,
  // el bot debe captar su valoración (nota 1-10 o confirmación de reseña en Google).
  if (getPendingReview(phone)) {
    contextualPrompt +=
      '\n\nRESEÑA PENDIENTE: A este cliente se le pidió hace poco que valore el servicio recibido. ' +
      'Si en su mensaje da una nota del 1 al 10, o confirma que dejó la reseña en Google, agradecelo ' +
      'cálidamente y registrá su valoración con la herramienta record_service_rating. Si su nota es baja ' +
      '(1 a 6), pedí disculpas y ofrecé que Lucas lo contacte. No insistas si no quiere participar.';
  }

  // Agregar mensaje al historial
  const history = [...state.history, userMessage];

  // Limitar historial según la ventana calculada (60 nuevo / 30 recurrente)
  const trimmedHistory = history.slice(-historyLimit);

  // Para la llamada actual, inyectar el audio/imagen en el último mensaje.
  const apiMessages = withCurrentMedia(trimmedHistory, userText, media);

  let botReply;
  try {
    botReply = await callOpenRouter(apiMessages, contextualPrompt, { clientPhone: phone });
  } catch (err) {
    console.error('[AI] Error llamando a OpenRouter:', err.response?.data || err.message);
    botReply = media
      ? 'Disculpá, no pude procesar bien tu audio/imagen. ¿Me lo escribís en un mensaje? Si preferís, escribí "hablar con Lucas".'
      : 'Disculpá, tuve un problema técnico. Por favor escribí "hablar con Lucas" para atención directa o intentá de nuevo en unos minutos.';
  }

  // Guardar el estado actualizado
  const updatedHistory = [
    ...trimmedHistory,
    { role: 'assistant', content: botReply },
  ];

  saveConversationState(phone, updatedHistory, state.step, state.car_info, false);

  // Actualizar el perfil del cliente en segundo plano (no bloquea la respuesta)
  maybeUpdateClientProfile(phone, updatedHistory).catch(() => {});

  return botReply;
}

/**
 * Completado simple sin tool-calling. Útil para tareas internas como el
 * resumen diario. Devuelve el texto o null si no hay API key / falla.
 */
async function simpleCompletion(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  if (!apiKey || apiKey === 'sk-or-v1-xxxxxxxxxxxxxxxx') return null;

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 600,
        temperature: 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lc-performance.com',
          'X-Title': 'LC Performance WhatsApp Bot',
        },
        timeout: 30000,
      }
    );
    return response.data.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('[AI] Error en simpleCompletion:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  processMessage, buildSystemPrompt, simpleCompletion, callOpenRouter, currentDateLine,
  normalizeInput, withCurrentMedia, describeMedia,
};
