/**
 * Google Calendar Integration — OAuth2 web flow
 *
 * CONFIGURACIÓN (una sola vez):
 * 1. Ir a https://console.cloud.google.com
 * 2. Crear proyecto → APIs y Servicios → Biblioteca → habilitar "Google Calendar API"
 * 3. Credenciales → Crear → ID de cliente OAuth 2.0
 *    - Tipo: Aplicación web
 *    - Orígenes JS autorizados: http://localhost:3000
 *    - URIs de redireccionamiento autorizados: http://localhost:3000/auth/google/callback
 * 4. Descargar JSON y guardarlo como credentials.json en la raíz del proyecto
 * 5. En el Dashboard → sección "Turnos" → clic en "Iniciar sesión con Google"
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH   = process.env.GOOGLE_TOKEN_PATH || path.join(__dirname, '..', 'token.json');
const CALENDAR_ID  = process.env.GOOGLE_CALENDAR_ID || 'primary';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// ─── Helpers de credenciales ────────────────────────────────────────────────

function getClientCredentials() {
  // Primero intenta desde .env, luego desde credentials.json (compatibilidad)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
  }
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(credPath)) {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return raw.web || raw.installed;
  }
  return null;
}

function createOAuthClient() {
  const creds = getClientCredentials();
  if (!creds) throw new Error('Configurá GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env');
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
}

function getAuthClient() {
  const oAuth2Client = createOAuthClient();

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('No autenticado. Iniciá sesión con Google desde el Dashboard → Turnos.');
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  oAuth2Client.on('tokens', (newTokens) => {
    const current = fs.existsSync(TOKEN_PATH)
      ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
      : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...newTokens }, null, 2));
  });

  return oAuth2Client;
}

// ─── Flujo OAuth2 web ────────────────────────────────────────────────────────

function generateAuthUrl() {
  const oAuth2Client = createOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

async function handleOAuthCallback(code) {
  const oAuth2Client = createOAuthClient();

  // El POST a oauth2.googleapis.com/token a veces falla con "Premature close"
  // (reset transitorio del socket TCP). Reintentamos un par de veces antes de
  // rendirnos, ya que el código de Google es de un solo uso pero sigue válido
  // mientras no se haya canjeado con éxito.
  let tokens;
  let lastErr;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      ({ tokens } = await oAuth2Client.getToken(code));
      break;
    } catch (err) {
      lastErr = err;
      const transitorio = /premature close|ECONNRESET|ETIMEDOUT|socket hang up|network|fetch failed/i.test(err.message || '');
      if (!transitorio || intento === 3) throw err;
      console.warn(`[GOOGLE AUTH] Intento ${intento} falló (${err.message}). Reintentando...`);
      await new Promise(r => setTimeout(r, 800 * intento));
    }
  }
  if (!tokens) throw lastErr;

  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

// ─── Estado ─────────────────────────────────────────────────────────────────

function isCalendarConfigured() {
  return hasCredentials() && fs.existsSync(TOKEN_PATH);
}

function hasCredentials() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) ||
    fs.existsSync(process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, '..', 'credentials.json'));
}

// ─── Disponibilidad ─────────────────────────────────────────────────────────

async function getAvailability(dateStr) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const timeMin = new Date(`${dateStr}T00:00:00-03:00`).toISOString();
  const timeMax = new Date(`${dateStr}T23:59:59-03:00`).toISOString();

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];

  if (events.length === 0) {
    return {
      available: true,
      events: [],
      message: `El día ${dateStr} está libre. Podemos agendar tu turno.`,
    };
  }

  const eventList = events.map(e => {
    const start = e.start.dateTime || e.start.date;
    const end   = e.end.dateTime   || e.end.date;
    return `${formatTime(start)} - ${formatTime(end)}: ${e.summary || 'Ocupado'}`;
  });

  return {
    available: events.length < 5,
    events: eventList,
    message: `El día ${dateStr} tiene ${events.length} turno(s): ${eventList.join(', ')}. ${events.length < 5 ? 'Aún hay lugar disponible.' : 'El día está completo.'}`,
  };
}

// ─── Crear turno ─────────────────────────────────────────────────────────────

async function createAppointment({ summary, description, dateStr, startTime, endTime, clientPhone }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary,
    description: `${description}\n\nWhatsApp: ${clientPhone}`,
    start: {
      dateTime: new Date(`${dateStr}T${startTime}:00-03:00`).toISOString(),
      timeZone: 'America/Argentina/Buenos_Aires',
    },
    end: {
      dateTime: new Date(`${dateStr}T${endTime}:00-03:00`).toISOString(),
      timeZone: 'America/Argentina/Buenos_Aires',
    },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 60 }],
    },
  };

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event,
  });

  return {
    success: true,
    eventId: response.data.id,
    link: response.data.htmlLink,
    message: `¡Turno agendado! ${summary} el ${dateStr} a las ${startTime} hs. el dueño recibirá una notificación.`,
  };
}

// ─── Próximos eventos (dashboard) ────────────────────────────────────────────

async function getUpcomingEvents(days = 7) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  return response.data.items || [];
}

// ─── Borrar evento (cancelación de turno) ────────────────────────────────────

async function deleteEvent(eventId) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  return { success: true };
}

function formatTime(dateTimeStr) {
  if (!dateTimeStr) return '';
  const d = new Date(dateTimeStr);
  if (isNaN(d.getTime())) return dateTimeStr;
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

module.exports = {
  generateAuthUrl,
  handleOAuthCallback,
  getAvailability,
  createAppointment,
  getUpcomingEvents,
  deleteEvent,
  isCalendarConfigured,
  hasCredentials,
};
