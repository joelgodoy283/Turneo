/**
 * whatsapp/notify.js — Avisos internos al dueño/encargado por WhatsApp.
 *
 * El número del dueño se guarda en config (`owner_number`); si no está, cae al
 * `summary_number` (el que ya se usa para el resumen diario). El require de
 * baileys es perezoso (dentro de la función) para evitar el ciclo de require
 * baileys → openrouter → tools → calendar → notify → baileys.
 */
const { getConfig, normalizePhone } = require('../database/db');

/** JID de WhatsApp del dueño, o null si no hay número configurado. */
function ownerJid() {
  const num = normalizePhone(getConfig('owner_number') || getConfig('summary_number') || '');
  return num ? `${num}@s.whatsapp.net` : null;
}

/** ¿El mensaje viene del número del dueño? (recibe un JID o número) */
function isOwner(phoneOrJid) {
  const owner = normalizePhone(getConfig('owner_number') || '');
  if (!owner) return false;
  return normalizePhone(phoneOrJid) === owner;
}

/** Envía un mensaje al dueño. Devuelve true si se pudo enviar. */
async function notifyOwner(text) {
  const jid = ownerJid();
  if (!jid) {
    console.warn('[NOTIFY] No hay número del dueño configurado; no se envió el aviso.');
    return false;
  }
  const { sendMessage, getConnectionState } = require('./baileys'); // lazy
  if (getConnectionState().status !== 'connected') {
    console.warn('[NOTIFY] WhatsApp no conectado; no se pudo avisar al dueño.');
    return false;
  }
  try {
    await sendMessage(jid, text);
    return true;
  } catch (err) {
    console.error('[NOTIFY] Error avisando al dueño:', err.message);
    return false;
  }
}

module.exports = { notifyOwner, ownerJid, isOwner };
