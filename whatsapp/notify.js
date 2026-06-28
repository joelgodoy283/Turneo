/**
 * whatsapp/notify.js — Avisos internos a Lucas por WhatsApp.
 *
 * El número de Lucas se guarda en config (`lucas_number`); si no está, cae al
 * `summary_number` (el que ya se usa para el resumen diario). El require de
 * baileys es perezoso (dentro de la función) para evitar el ciclo de require
 * baileys → openrouter → tools → calendar → notify → baileys.
 */
const { getConfig, normalizePhone } = require('../database/db');

/** JID de WhatsApp de Lucas, o null si no hay número configurado. */
function lucasJid() {
  const num = normalizePhone(getConfig('lucas_number') || getConfig('summary_number') || '');
  return num ? `${num}@s.whatsapp.net` : null;
}

/** ¿El mensaje viene del número de Lucas? (recibe un JID o número) */
function isLucas(phoneOrJid) {
  const lucas = normalizePhone(getConfig('lucas_number') || '');
  if (!lucas) return false;
  return normalizePhone(phoneOrJid) === lucas;
}

/** Envía un mensaje a Lucas. Devuelve true si se pudo enviar. */
async function notifyLucas(text) {
  const jid = lucasJid();
  if (!jid) {
    console.warn('[NOTIFY] No hay número de Lucas configurado; no se envió el aviso.');
    return false;
  }
  const { sendMessage, getConnectionState } = require('./baileys'); // lazy
  if (getConnectionState().status !== 'connected') {
    console.warn('[NOTIFY] WhatsApp no conectado; no se pudo avisar a Lucas.');
    return false;
  }
  try {
    await sendMessage(jid, text);
    return true;
  } catch (err) {
    console.error('[NOTIFY] Error avisando a Lucas:', err.message);
    return false;
  }
}

module.exports = { notifyLucas, lucasJid, isLucas };
