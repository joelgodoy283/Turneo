/**
 * jobs/reviews.js — Pedido de reseña post-servicio.
 *
 * 1) 10:00 ART: a los vehículos que quedaron listos AYER (status terminado), se
 *    les pide al cliente una reseña en Google (config `google_review_url`).
 * 2) Fallback (poller c/30'): si pasaron ~5 hs del pedido y el cliente no
 *    respondió, se le manda la pregunta del 1 al 10.
 * La nota la captura el bot de clientes con la herramienta record_service_rating.
 * On/off con `review_enabled`.
 */
const cron = require('node-cron');
const {
  getConfig, getBusinessName, getAppointmentsForReview, getReviewFallbackPending, updateAppointment,
} = require('../database/db');
const local = require('../calendar/local-calendar');

const TZ = 'America/Argentina/Buenos_Aires';
const FALLBACK_HOURS = 5;

function googleReviewText(appt, url) {
  return (
    `🙌 ¡Gracias por elegir *${getBusinessName()}*${appt.client_name ? ', ' + appt.client_name : ''}! ` +
    `Esperamos que tu ${appt.car_info || 'vehículo'} haya quedado perfecto.\n` +
    `¿Nos dejarías una reseña en Google? Nos ayuda muchísimo a seguir creciendo 🙏\n${url}`
  );
}

function ratingText(appt) {
  return (
    `Para seguir mejorando${appt.client_name ? ', ' + appt.client_name : ''}: del *1 al 10*, ` +
    `¿cómo calificarías la atención y el servicio que recibiste en *${getBusinessName()}*? 🙏`
  );
}

function hoursSince(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}

// ─── Pedido de reseña (10:00) ─────────────────────────────────────────────────

async function sendReviewRequests({ force = false } = {}) {
  if (!force && getConfig('review_enabled') !== 'true') {
    return { ok: false, sent: 0, reason: 'Los pedidos de reseña están desactivados.' };
  }
  // Vehículos listos ayer → reseña hoy (día siguiente al servicio).
  const reviewDate = local.addDays(local.todayAR(), -1);
  const appts = getAppointmentsForReview(reviewDate);
  if (!appts.length) return { ok: true, sent: 0, reason: 'No hay servicios para pedir reseña hoy.' };

  const url = (getConfig('google_review_url') || '').trim();
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    return { ok: false, sent: 0, reason: 'WhatsApp no está conectado.' };
  }

  let sent = 0;
  for (const appt of appts) {
    try {
      const now = new Date().toISOString();
      if (url) {
        await sendMessage(`${appt.client_phone}@s.whatsapp.net`, googleReviewText(appt, url));
        updateAppointment(appt.id, { review_requested: 1, review_requested_at: now });
      } else {
        // Sin link de Google → vamos directo a la pregunta del 1 al 10.
        await sendMessage(`${appt.client_phone}@s.whatsapp.net`, ratingText(appt));
        updateAppointment(appt.id, { review_requested: 1, review_requested_at: now, review_fallback_sent: 1 });
      }
      sent++;
    } catch (err) {
      console.error(`[REVIEW] Error pidiendo reseña del turno ${appt.id}:`, err.message);
    }
  }
  console.log(`[REVIEW] ✅ ${sent} pedido(s) de reseña enviado(s)`);
  return { ok: true, sent };
}

// ─── Fallback 1-10 (poller) ───────────────────────────────────────────────────

async function sendReviewFallbacks({ force = false } = {}) {
  if (!force && getConfig('review_enabled') !== 'true') return { ok: false, sent: 0 };

  const due = getReviewFallbackPending().filter((a) => force || hoursSince(a.review_requested_at) >= FALLBACK_HOURS);
  if (!due.length) return { ok: true, sent: 0 };

  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') return { ok: false, sent: 0, reason: 'WhatsApp no conectado.' };

  let sent = 0;
  for (const appt of due) {
    try {
      await sendMessage(`${appt.client_phone}@s.whatsapp.net`, ratingText(appt));
      updateAppointment(appt.id, { review_fallback_sent: 1 });
      sent++;
    } catch (err) {
      console.error(`[REVIEW] Error en fallback 1-10 del turno ${appt.id}:`, err.message);
    }
  }
  if (sent) console.log(`[REVIEW] ✅ ${sent} pregunta(s) 1-10 enviada(s)`);
  return { ok: true, sent };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function startReviews() {
  cron.schedule('0 10 * * *', () => {
    console.log('[REVIEW] 🕙 Pedido de reseñas (10:00 ART)...');
    sendReviewRequests().catch((err) => console.error('[REVIEW] Error:', err.message));
  }, { timezone: TZ });

  cron.schedule('*/30 * * * *', () => {
    sendReviewFallbacks().catch((err) => console.error('[REVIEW] Error en fallback:', err.message));
  }, { timezone: TZ });

  console.log('[REVIEW] ✅ Reseñas programadas (pedido 10:00 + fallback 1-10 c/30min)');
}

module.exports = { startReviews, sendReviewRequests, sendReviewFallbacks };
