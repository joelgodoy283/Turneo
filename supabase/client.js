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

function channelFromContact(value) {
  return String(value || '').startsWith('ig:') ? 'instagram' : 'whatsapp';
}

function canonicalContactKey(value) {
  const raw = String(value || '');
  return raw.startsWith('ig:') ? raw : raw.replace(/\D/g, '');
}

async function ensureCustomer(contactKey, fields = {}) {
  if (!supabase || !contactKey) return null;
  const channel = fields.channel || channelFromContact(contactKey);
  contactKey = canonicalContactKey(contactKey);
  const payload = { contact_key: contactKey, channel, updated_at: new Date().toISOString() };
  if (fields.display_name) payload.display_name = fields.display_name;
  if (fields.communication_style) payload.communication_style = fields.communication_style;
  if (fields.customer_safe_summary) payload.customer_safe_summary = fields.customer_safe_summary;
  const { data, error } = await supabase.from('lc_customers')
    .upsert(payload, { onConflict: 'contact_key' }).select('*').single();
  if (error) throw error;
  return data;
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

async function getCustomerSafeContext(contactKey) {
  if (!supabase) return null;
  try {
    contactKey = canonicalContactKey(contactKey);
    const { data: customer, error } = await supabase.from('lc_customers')
      .select('id,display_name,communication_style,customer_safe_summary,do_not_contact')
      .eq('contact_key', contactKey).maybeSingle();
    if (error) throw error;
    if (!customer) return null;
    const { data: vehicles, error: vehicleError } = await supabase.from('lc_vehicles')
      .select('label,make,model,model_year').eq('customer_id', customer.id)
      .order('updated_at', { ascending: false });
    if (vehicleError) throw vehicleError;
    return { ...customer, vehicles: vehicles || [] };
  } catch (err) {
    console.error('[SUPABASE] Error leyendo contexto seguro:', err.message);
    return null;
  }
}

async function recordServiceHistory({ contactKey, customerName, vehicleLabel, serviceDate,
  workPerformed, vehicleCondition, mileage, unresolvedItems, appointmentId }) {
  if (!supabase) return { success: false, error: 'Supabase no configurado.' };
  try {
    const customer = await ensureCustomer(contactKey, { display_name: customerName });
    let vehicle = null;
    if (vehicleLabel) {
      const vehiclePayload = {
        customer_id: customer.id, label: vehicleLabel.trim(), updated_at: new Date().toISOString(),
      };
      if (Number.isFinite(Number(mileage))) vehiclePayload.current_mileage = Number(mileage);
      const { data, error } = await supabase.from('lc_vehicles')
        .upsert(vehiclePayload, { onConflict: 'customer_id,label' }).select('*').single();
      if (error) throw error;
      vehicle = data;
    }
    const { data: record, error } = await supabase.from('lc_service_records').insert({
      customer_id: customer.id,
      vehicle_id: vehicle?.id || null,
      local_appointment_id: appointmentId || null,
      service_date: serviceDate || new Date().toISOString().slice(0, 10),
      work_performed: workPerformed,
      vehicle_condition: vehicleCondition || null,
      mileage: Number.isFinite(Number(mileage)) ? Number(mileage) : null,
      unresolved_items: unresolvedItems || null,
      recorded_by: 'owner',
      visibility: 'internal_only',
    }).select('*').single();
    if (error) throw error;
    return { success: true, record, customer, vehicle };
  } catch (err) {
    console.error('[SUPABASE] Error registrando servicio:', err.message);
    return { success: false, error: err.message };
  }
}

async function getInternalCustomerContext(contactKey) {
  if (!supabase) return null;
  try {
    contactKey = canonicalContactKey(contactKey);
    const { data: customer, error } = await supabase.from('lc_customers')
      .select('*').eq('contact_key', contactKey).maybeSingle();
    if (error) throw error;
    if (!customer) return null;
    const [vehicleResult, serviceResult, noteResult] = await Promise.all([
      supabase.from('lc_vehicles').select('*').eq('customer_id', customer.id).order('updated_at', { ascending: false }),
      supabase.from('lc_service_records').select('*,lc_vehicles(label)').eq('customer_id', customer.id).order('service_date', { ascending: false }).limit(10),
      supabase.from('lc_internal_notes').select('*,lc_vehicles(label)').eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(10),
    ]);
    if (vehicleResult.error) throw vehicleResult.error;
    if (serviceResult.error) throw serviceResult.error;
    if (noteResult.error) throw noteResult.error;
    return { customer, vehicles: vehicleResult.data || [], services: serviceResult.data || [], notes: noteResult.data || [] };
  } catch (err) {
    console.error('[SUPABASE] Error leyendo contexto interno:', err.message);
    return null;
  }
}

async function cancelFollowups(contactKey, reason = 'customer_replied') {
  if (!supabase || !contactKey) return;
  contactKey = canonicalContactKey(contactKey);
  const { error } = await supabase.from('lc_followup_sequences')
    .update({ status: 'cancelled', cancel_reason: reason, updated_at: new Date().toISOString() })
    .eq('contact_key', contactKey).in('status', ['pending', 'processing']);
  if (error) console.error('[SUPABASE] Error cancelando seguimientos:', error.message);
}

async function scheduleFollowup({ contactKey, channel, triggerMessageId, nextRunAt, triggerKind = 'conversation' }) {
  if (!supabase || !contactKey) return null;
  try {
    const recipientAddress = String(contactKey);
    contactKey = canonicalContactKey(contactKey);
    await cancelFollowups(contactKey, 'replaced_by_new_question');
    const { data, error } = await supabase.from('lc_followup_sequences').insert({
      contact_key: contactKey, recipient_address: recipientAddress,
      channel: channel || channelFromContact(recipientAddress),
      trigger_message_id: triggerMessageId || null, trigger_kind: triggerKind, next_run_at: nextRunAt,
    }).select('*').single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[SUPABASE] Error programando seguimiento:', err.message);
    return null;
  }
}

async function claimDueFollowups(limit = 25) {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('lc_claim_due_followups', { p_limit: limit });
  if (!error) return data || [];

  // Algunos proyectos no refrescan/publican la RPC inmediatamente. En ese caso
  // usamos compare-and-set sobre cada fila: solo una instancia puede cambiarla
  // de pending a processing, evitando envíos duplicados.
  if (error.code !== 'PGRST202') {
    console.error('[SUPABASE] Error tomando seguimientos:', error.message);
    return [];
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  await supabase.from('lc_followup_sequences')
    .update({ status: 'pending', locked_at: null, updated_at: now.toISOString() })
    .eq('status', 'processing')
    .lt('locked_at', staleBefore);

  const { data: candidates, error: selectError } = await supabase
    .from('lc_followup_sequences')
    .select('*')
    .eq('status', 'pending')
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  if (selectError) {
    console.error('[SUPABASE] Error buscando seguimientos:', selectError.message);
    return [];
  }

  const claimed = [];
  for (const row of candidates || []) {
    const { data: updated, error: updateError } = await supabase
      .from('lc_followup_sequences')
      .update({ status: 'processing', locked_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (updateError) {
      console.error('[SUPABASE] Error bloqueando seguimiento:', updateError.message);
    } else if (updated) {
      claimed.push(updated);
    }
  }
  return claimed;
}

async function completeFollowupAttempt(id, attemptCount, nextRunAt = null) {
  if (!supabase) return;
  const exhausted = attemptCount >= 2;
  const { error } = await supabase.from('lc_followup_sequences').update({
    attempt_count: attemptCount, status: exhausted ? 'exhausted' : 'pending',
    next_run_at: exhausted ? new Date().toISOString() : nextRunAt,
    last_attempt_at: new Date().toISOString(), locked_at: null, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'processing');
  if (error) console.error('[SUPABASE] Error completando seguimiento:', error.message);
}

async function releaseFollowup(id, retryAt, reason = null, failureCount = 1) {
  if (!supabase) return;
  const cancelled = failureCount >= 3;
  const { error } = await supabase.from('lc_followup_sequences').update({
    status: cancelled ? 'cancelled' : 'pending',
    next_run_at: retryAt, locked_at: null,
    send_failure_count: Math.min(3, failureCount), cancel_reason: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'processing');
  if (error) console.error('[SUPABASE] Error liberando seguimiento:', error.message);
}

module.exports = {
  isEnabled, logMessage, getClientProfile, upsertClientProfile,
  canonicalContactKey, ensureCustomer, getCustomerSafeContext,
  recordServiceHistory, getInternalCustomerContext,
  scheduleFollowup, cancelFollowups, claimDueFollowups, completeFollowupAttempt, releaseFollowup,
};
