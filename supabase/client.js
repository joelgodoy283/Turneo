/**
 * supabase/client.js — Memoria de largo plazo en Supabase (Postgres).
 *
 * Guarda el historial completo de mensajes (lc_mensajes) y un perfil por
 * cliente (lc_clientes) para personalizar el trato. Si SUPABASE_URL /
 * SUPABASE_SECRET_KEY no están configuradas, todas las funciones son no-op
 * y el bot sigue funcionando con su base local normalmente.
 */
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

let supabase = null;

if (URL && KEY) {
  supabase = createClient(URL, KEY, { auth: { persistSession: false } });
  console.log('[SUPABASE] ✅ Memoria de largo plazo activa:', URL);
} else {
  console.log('[SUPABASE] ⚠️  No configurado — memoria de largo plazo desactivada');
}

function isEnabled() {
  return !!supabase;
}

/** Inserta un mensaje en el historial (fire-and-forget). */
async function logMessage(phone, direction, content) {
  if (!supabase) return;
  try {
    await supabase.from('lc_mensajes').insert({ phone, direction, content });
  } catch (err) {
    console.error('[SUPABASE] Error guardando mensaje:', err.message);
  }
}

/** Devuelve el perfil del cliente o null. */
async function getClientProfile(phone) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('lc_clientes')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[SUPABASE] Error leyendo perfil:', err.message);
    return null;
  }
}

/** Crea o actualiza el perfil del cliente. */
async function upsertClientProfile(phone, fields) {
  if (!supabase) return;
  try {
    await supabase
      .from('lc_clientes')
      .upsert({ phone, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
  } catch (err) {
    console.error('[SUPABASE] Error guardando perfil:', err.message);
  }
}

module.exports = { isEnabled, logMessage, getClientProfile, upsertClientProfile };
