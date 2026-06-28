/**
 * whatsapp/admins.js — Lista de números administradores (dueño/encargado).
 *
 * El bot tiene dos roles: asistente de clientes y asistente interno del dueño.
 * Los mensajes de un número ADMIN se enrutan al "owner assistant" (ai/assistant.js)
 * con herramientas internas; los de cualquier otro número se atienden como cliente.
 * Así un cliente NUNCA puede ejecutar comandos internos ni ver datos del negocio.
 *
 * Fuentes de números admin (se unifican y deduplican):
 *   1. ENV  ADMIN_WHATSAPP_NUMBERS  → lista separada por comas.
 *   2. CONFIG `admin_numbers`        → editable desde el dashboard (coma).
 *   3. CONFIG `lucas_number`         → compatibilidad: el dueño principal.
 *
 * Todos los números se normalizan a solo dígitos (con código de país) para
 * comparar de forma robusta sin importar el formato (+54, espacios, @jid, etc.).
 */
const { getConfig, normalizePhone } = require('../database/db');

/** Devuelve el set de números admin (solo dígitos), unificando ENV + config. */
function adminNumbers() {
  const fromEnv = (process.env.ADMIN_WHATSAPP_NUMBERS || '')
    .split(',')
    .map((s) => normalizePhone(s))
    .filter(Boolean);
  const fromConfig = (getConfig('admin_numbers') || '')
    .split(',')
    .map((s) => normalizePhone(s))
    .filter(Boolean);
  const lucas = normalizePhone(getConfig('lucas_number') || '');
  const all = [...fromEnv, ...fromConfig];
  if (lucas) all.push(lucas);
  return new Set(all);
}

/** ¿El número (JID o teléfono) es un administrador autorizado? */
function isAdmin(phoneOrJid) {
  const num = normalizePhone(phoneOrJid);
  if (!num) return false;
  return adminNumbers().has(num);
}

/** Lista de números admin como array (para mostrar/diagnóstico). */
function listAdmins() {
  return [...adminNumbers()];
}

module.exports = { isAdmin, listAdmins, adminNumbers };
