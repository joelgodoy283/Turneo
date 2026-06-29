const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const {
  getConfig, setConfig,
  getMessages, getRecentChats,
  pauseContact, resumeContact, isPaused,
  getServices, addService, updateService, deleteService,
  getBlockedContacts, addBlockedContact, removeBlockedContact,
  getAllAppointmentsBetween,
} = require('../database/db');
const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
const { sendInstagramMessage } = require('../instagram/instagram');
const { getUpcomingEvents, isCalendarConfigured, hasCredentials } = require('../calendar/google-calendar');
const cal = require('../calendar');
const local = require('../calendar/local-calendar');
const { generateAndSend } = require('../jobs/daily-summary');
const { generateAndSend: morningSummary } = require('../jobs/morning-summary');
const { sendReminders } = require('../jobs/reminders');

// Claves de configuración de turnos/avisos editables desde el dashboard.
const TURNOS_KEYS = [
  'owner_number', 'cal_capacity_per_day', 'cal_slots', 'cal_workdays', 'google_review_url',
  'morning_summary_enabled', 'checkin_enabled', 'reminder_enabled', 'review_enabled',
];

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || path.join(__dirname, '..', 'token.json');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'lc2024';

// ─── Middleware de auth para la API ────────────────────────────────────────
function requireApiAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ─── Estado de WhatsApp ────────────────────────────────────────────────────
router.get('/whatsapp/status', requireApiAuth, (req, res) => {
  res.json(getConnectionState());
});

// ─── Chats ─────────────────────────────────────────────────────────────────
router.get('/chats', requireApiAuth, (req, res) => {
  const chats = getRecentChats();
  res.json(chats);
});

router.get('/chats/:phone/messages', requireApiAuth, (req, res) => {
  const { phone } = req.params;
  const { limit = 50 } = req.query;
  const messages = getMessages(phone, parseInt(limit));
  const paused = isPaused(phone);
  res.json({ messages, paused });
});

// ─── Enviar mensaje desde el dashboard (el dueño interviene) ─────────────────
router.post('/chats/:phone/send', requireApiAuth, async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: 'Texto vacío' });

  try {
    if (phone.startsWith('ig:')) {
      await sendInstagramMessage(phone.replace('ig:', ''), text.trim());
    } else {
      await sendMessage(phone, text.trim());
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pausa / Reanuda bot por número ───────────────────────────────────────
router.post('/chats/:phone/pause', requireApiAuth, (req, res) => {
  pauseContact(req.params.phone);
  global.io?.emit('chat:paused', { phone: req.params.phone });
  res.json({ success: true, paused: true });
});

router.post('/chats/:phone/resume', requireApiAuth, (req, res) => {
  resumeContact(req.params.phone);
  global.io?.emit('chat:resumed', { phone: req.params.phone });
  res.json({ success: true, paused: false });
});

// ─── Configuración de IA ───────────────────────────────────────────────────
router.get('/config/prompt', requireApiAuth, (req, res) => {
  const prompt = getConfig('ai_prompt') || '';
  res.json({ prompt });
});

router.post('/config/prompt', requireApiAuth, (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt vacío' });
  setConfig('ai_prompt', prompt.trim());
  res.json({ success: true });
});

// ─── Compartir precios (la IA informa montos o no) ──────────────────────────
router.get('/config/share-prices', requireApiAuth, (req, res) => {
  res.json({ sharePrices: getConfig('share_prices') === 'true' });
});

router.post('/config/share-prices', requireApiAuth, (req, res) => {
  setConfig('share_prices', req.body?.sharePrices ? 'true' : 'false');
  res.json({ success: true });
});

// ─── Google Calendar ────────────────────────────────────────────────────────
router.get('/calendar/events', requireApiAuth, async (req, res) => {
  if (!isCalendarConfigured()) {
    return res.json({ configured: false, events: [] });
  }
  try {
    const events = await getUpcomingEvents(14);
    res.json({ configured: true, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/google/disconnect', requireApiAuth, (req, res) => {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Servicios ───────────────────────────────────────────────────────────────
router.get('/services', requireApiAuth, (req, res) => {
  res.json(getServices());
});

router.post('/services', requireApiAuth, (req, res) => {
  const { name, description, price, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  addService({ name: name.trim(), description, price, notes });
  res.json({ success: true });
});

router.put('/services/:id', requireApiAuth, (req, res) => {
  const { name, description, price, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
  updateService(parseInt(req.params.id), { name: name.trim(), description, price, notes });
  res.json({ success: true });
});

router.delete('/services/:id', requireApiAuth, (req, res) => {
  deleteService(parseInt(req.params.id));
  res.json({ success: true });
});

// ─── Excepciones (números que el bot ignora) ─────────────────────────────────
router.get('/exceptions', requireApiAuth, (req, res) => {
  res.json(getBlockedContacts());
});

router.post('/exceptions', requireApiAuth, (req, res) => {
  const { phone, note } = req.body;
  if (!phone?.trim()) return res.status(400).json({ error: 'El número es obligatorio' });
  addBlockedContact(phone.trim(), (note || '').trim());
  res.json({ success: true });
});

router.delete('/exceptions/:phone', requireApiAuth, (req, res) => {
  removeBlockedContact(req.params.phone);
  res.json({ success: true });
});

// ─── Resumen diario ──────────────────────────────────────────────────────────
router.get('/summary/config', requireApiAuth, (req, res) => {
  res.json({
    number: getConfig('summary_number') || '',
    enabled: getConfig('summary_enabled') === 'true',
  });
});

router.post('/summary/config', requireApiAuth, (req, res) => {
  const { number, enabled } = req.body;
  setConfig('summary_number', (number || '').trim());
  setConfig('summary_enabled', enabled ? 'true' : 'false');
  res.json({ success: true });
});

router.post('/summary/test', requireApiAuth, async (req, res) => {
  try {
    const result = await generateAndSend({ force: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Configuración de turnos y avisos ────────────────────────────────────────
router.get('/config/turnos', requireApiAuth, (req, res) => {
  const cfg = {};
  for (const k of TURNOS_KEYS) cfg[k] = getConfig(k) ?? '';
  res.json(cfg);
});

router.post('/config/turnos', requireApiAuth, (req, res) => {
  for (const k of TURNOS_KEYS) {
    if (k in req.body) setConfig(k, String(req.body[k] ?? '').trim());
  }
  res.json({ success: true });
});

// ─── Prompt del asistente del dueño ───────────────────────────────────────────
router.get('/config/assistant-prompt', requireApiAuth, (req, res) => {
  res.json({ prompt: getConfig('assistant_prompt') || '' });
});

router.post('/config/assistant-prompt', requireApiAuth, (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt vacío' });
  setConfig('assistant_prompt', prompt.trim());
  res.json({ success: true });
});

// ─── Turnos (sistema propio, fuente de verdad) ───────────────────────────────
router.get('/appointments', requireApiAuth, (req, res) => {
  // Ventana: desde hace 3 días hasta dentro de 21 (incluye recién terminados).
  const today = local.todayAR();
  const from = local.addDays(today, -3);
  const to = local.addDays(today, 21);
  res.json({ appointments: getAllAppointmentsBetween(from, to), today });
});

router.post('/appointments/:id/cancel', requireApiAuth, async (req, res) => {
  try {
    const result = await cal.cancelAppointment(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tests de avisos (envían ya, forzando) ───────────────────────────────────
router.post('/turnos/test-morning', requireApiAuth, async (req, res) => {
  try { res.json(await morningSummary({ force: true })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/turnos/test-reminders', requireApiAuth, async (req, res) => {
  try { res.json(await sendReminders({ force: true })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Auth API ───────────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

module.exports = router;
