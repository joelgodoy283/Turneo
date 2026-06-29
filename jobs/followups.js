/** Seguimientos comerciales persistentes: máximo dos intentos, sin bucles. */
const cron = require('node-cron');
const { getConfig, getMessages, isPaused, isBlocked } = require('../database/db');
const {
  isEnabled: supabaseEnabled,
  scheduleFollowup, cancelFollowups, claimDueFollowups,
  completeFollowupAttempt, releaseFollowup,
} = require('../supabase/client');

const TZ = 'America/Argentina/Buenos_Aires';
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function dateAtAR(dateStr, time) {
  return new Date(`${dateStr}T${time}:00-03:00`);
}

function addDateDays(dateStr, amount) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + amount));
  return dt.toISOString().slice(0, 10);
}

function weekday(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(dateAtAR(dateStr, '12:00'));
}

function configuredWorkdays() {
  try {
    const raw = getConfig('cal_workdays');
    if (raw) return raw.split(',').map(Number).filter(Number.isInteger);
  } catch { /* pruebas unitarias sin DB inicializada */ }
  return [1, 2, 3, 4, 5, 6];
}

function workdayNumber(dateStr) {
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[weekday(dateStr)];
}

function nextWorkday(dateStr) {
  let date = dateStr;
  for (let i = 0; i < 8; i++) {
    date = addDateDays(date, 1);
    if (configuredWorkdays().includes(workdayNumber(date))) return date;
  }
  return addDateDays(dateStr, 1);
}

function clampToBusinessHours(date) {
  const p = localParts(date);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const day = p.weekday;
  const open = day === 'Sat' ? 9 * 60 : 8 * 60 + 15;
  const close = day === 'Sat' ? 13 * 60 : 17 * 60 + 15;

  if (!configuredWorkdays().includes(workdayNumber(dateStr))) {
    return dateAtAR(nextWorkday(dateStr), '09:00');
  }
  if (minutes < open) return dateAtAR(dateStr, day === 'Sat' ? '09:00' : '08:15');
  if (minutes >= close) return dateAtAR(nextWorkday(dateStr), '09:00');
  return date;
}

function firstFollowupAt() {
  return clampToBusinessHours(new Date(Date.now() + THREE_HOURS_MS));
}

function secondFollowupAt() {
  const p = localParts();
  const today = `${p.year}-${p.month}-${p.day}`;
  return dateAtAR(nextWorkday(today), '10:00');
}

function shouldScheduleFollowup(text) {
  if (getConfig('followup_enabled') === 'false') return false;
  if (!text || !/[?¿]/.test(text)) return false;
  const value = text.toLowerCase();
  const excluded = [
    'hablar con lucas', 'error técnico', 'problema técnico', 'reseña',
    'del 1 al 10', 'puede pasar a retirar', 'turno agendado', 'turno confirmado',
  ];
  return !excluded.some((term) => value.includes(term));
}

async function queueFollowup(contactKey, replyText, triggerKind = 'conversation') {
  if (!supabaseEnabled() || !shouldScheduleFollowup(replyText)) return null;
  if (isPaused(contactKey) || isBlocked(contactKey)) return null;
  return scheduleFollowup({
    contactKey,
    channel: String(contactKey).startsWith('ig:') ? 'instagram' : 'whatsapp',
    triggerKind,
    nextRunAt: firstFollowupAt().toISOString(),
  });
}

function followupText(attempt) {
  if (attempt === 1) {
    return 'Hola, ¿pudiste ver mi mensaje? Si querés, te ayudo a resolver la consulta o a coordinar un turno.';
  }
  return 'Te dejo este último mensaje por acá. Si querés continuar o coordinar un turno, escribinos cuando puedas 🙌';
}

async function sendFollowup(row, text) {
  const recipient = row.recipient_address || row.contact_key;
  if (row.channel === 'instagram') {
    const { sendInstagramMessage } = require('../instagram/instagram');
    await sendInstagramMessage(String(recipient).replace(/^ig:/, ''), text);
    return;
  }
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') throw new Error('WhatsApp no conectado');
  const jid = String(recipient).includes('@') ? recipient : `${recipient}@s.whatsapp.net`;
  await sendMessage(jid, text);
}

async function processDueFollowups() {
  if (!supabaseEnabled() || getConfig('followup_enabled') === 'false') return { ok: false, sent: 0 };
  const due = await claimDueFollowups(25);
  let sent = 0;

  for (const row of due) {
    try {
      const recipient = row.recipient_address || row.contact_key;
      if (isPaused(recipient) || isBlocked(recipient)) {
        await cancelFollowups(row.contact_key, 'paused_or_blocked');
        continue;
      }
      const last = getMessages(recipient, 1)[0];
      if (last && ['incoming', 'in'].includes(last.direction)) {
        await cancelFollowups(row.contact_key, 'customer_replied');
        continue;
      }

      const attempt = Math.min(2, Number(row.attempt_count || 0) + 1);
      await sendFollowup(row, followupText(attempt));
      await completeFollowupAttempt(row.id, attempt, attempt < 2 ? secondFollowupAt().toISOString() : null);
      sent++;
    } catch (err) {
      console.error(`[FOLLOWUP] Error en ${row.id}:`, err.message);
      await releaseFollowup(
        row.id,
        new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        'temporary_send_error',
        Number(row.send_failure_count || 0) + 1
      );
    }
  }
  return { ok: true, claimed: due.length, sent };
}

function startFollowups() {
  cron.schedule('*/5 * * * *', () => {
    processDueFollowups().catch((err) => console.error('[FOLLOWUP] Error:', err.message));
  }, { timezone: TZ });
  console.log('[FOLLOWUP] ✅ Seguimientos programados cada 5 min (máximo 2 intentos)');
}

module.exports = {
  startFollowups, processDueFollowups, queueFollowup, shouldScheduleFollowup,
  firstFollowupAt, secondFollowupAt, clampToBusinessHours, followupText,
};
