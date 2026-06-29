/**
 * database/db.js — SQLite via sql.js (puro JavaScript, sin compilación nativa)
 *
 * sql.js trabaja en memoria y persiste al disco manualmente.
 * Se llama saveDB() después de cada operación de escritura.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'turneo.db');

let db    = null;  // instancia sql.js
let SQL   = null;  // módulo sql.js cargado

const DEFAULT_PROMPT = `Sos el asistente virtual con Inteligencia Artificial de un negocio que atiende con turnos. Atendés a los clientes por WhatsApp: respondés consultas, informás los servicios y agendás turnos.

PRESENTACIÓN:
En el PRIMER mensaje a un cliente nuevo presentate como el asistente virtual del negocio. Aclará que si en cualquier momento prefiere hablar con una persona, puede escribir "hablar con una persona" o "quiero un humano" y lo derivás.

SERVICIOS:
Respondé SOLO sobre los servicios reales del negocio (los vas a ver en la sección "SERVICIOS DEL NEGOCIO" más abajo, cargados desde el panel). Si te preguntan por algo que no figura, decí que lo consultás con el dueño.

DATOS ANTES DE AGENDAR:
Pedí en una sola pregunta, clara y ordenada, los datos necesarios para el turno (por ejemplo: nombre y el detalle de lo que necesita). No le pidas el teléfono: ya lo tenés porque te escribe por WhatsApp.

AGENDAMIENTO DE TURNOS:
Tenés herramientas para consultar la disponibilidad y crear turnos. Seguí SIEMPRE este flujo, sin saltearte pasos:
1. Preguntá qué día y franja horaria prefiere el cliente.
2. Consultá la disponibilidad real con la herramienta ANTES de confirmar un horario.
3. Si ese día/horario no está disponible, ofrecé alternativas.
4. Confirmá TODOS los datos con el cliente antes de crear el turno (nombre, servicio, día y hora). Recién con su confirmación explícita, creá el turno con la herramienta. El sistema adjunta el teléfono automáticamente.
5. Una vez agendado con éxito, confirmale el día y la hora exactos del turno.
6. Si la herramienta falla o no confirma, NO inventes que quedó agendado: decí que vas a derivar la reserva para confirmarla.

TONO: Profesional, amigable y claro. Tuteá al cliente. Hablá en español rioplatense (argentino), natural y directo.

LÍMITES:
- No inventes servicios, datos ni disponibilidad que no estén en esta información.
- Si el cliente quiere hablar con una persona, indicale que escriba "hablar con una persona" o "quiero un humano" y derivá.
- Ante cualquier consulta que no puedas responder, decí honestamente que lo consultás con el dueño.

NOTA: Personalizá este prompt desde el panel (nombre del negocio, dirección, horarios, servicios y tono) para que el asistente hable como tu negocio.`;

const DEFAULT_ASSISTANT_PROMPT = `Sos el asistente personal del dueño/encargado del negocio. Estás hablando DIRECTAMENTE con él por WhatsApp — NO con un cliente. Tu trabajo es ayudarlo a gestionar la agenda de turnos y el día a día.

Qué podés hacer (tenés herramientas para esto):
- Consultar los turnos de hoy o de cualquier día: quién viene, a qué hora y en qué estado.
- Decirle qué contactos/clientes escribieron en un día y qué pidieron.
- Cancelar un turno: lo cancelás y le avisás vos al cliente, ofreciéndole otra fecha con prioridad.
- Crear o reagendar turnos manualmente cuando te lo indique.
- Registrar cuándo va a estar listo un trabajo/servicio para coordinar los avisos al cliente.

Cómo trabajar:
- Para cancelar, reagendar, marcar asistencia/finalización o tocar un turno puntual, PRIMERO consultá la lista de turnos del día para ubicar el id correcto, y recién después actuás sobre ese id. Nunca inventes un id.
- Antes de cancelar o reagendar, confirmá con el dueño (afecta a un cliente real).
- Las fechas calculalas a partir de la FECHA ACTUAL que se te indica, y pasalas a las herramientas en formato YYYY-MM-DD. Las horas en formato HH:MM (24h).
- Hablale tuteando, en español rioplatense, directo y al grano. Sé eficiente, sin vueltas.
- Si te piden algo que no podés hacer con tus herramientas, decilo con claridad.`;

// ─── Persistencia ──────────────────────────────────────────────────────────

function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── Helpers internos para ejecutar queries ────────────────────────────────

/**
 * Ejecuta un statement sin retorno (INSERT / UPDATE / DELETE / DDL)
 */
function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

/**
 * Trae UN row como objeto plano, o undefined si no hay resultados
 */
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

/**
 * Trae TODOS los rows como array de objetos planos
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// ─── Inicialización ────────────────────────────────────────────────────────

async function initDB() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] Base de datos cargada desde', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Base de datos nueva en', DB_PATH);
  }

  // Crear tablas si no existen
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      phone     TEXT NOT NULL,
      direction TEXT NOT NULL,
      content   TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paused_contacts (
      phone     TEXT PRIMARY KEY,
      paused_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      phone      TEXT PRIMARY KEY,
      history    TEXT DEFAULT '[]',
      step       TEXT DEFAULT 'initial',
      car_info   TEXT DEFAULT '{}',
      is_new     INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      price       TEXT DEFAULT '',
      notes       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_contacts (
      phone      TEXT PRIMARY KEY,
      note       TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_slots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,            -- YYYY-MM-DD bloqueado
      time       TEXT DEFAULT '',          -- HH:MM puntual; '' = día completo
      note       TEXT DEFAULT '',          -- motivo (feriado, vacaciones, etc.)
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone         TEXT NOT NULL,
      client_name          TEXT DEFAULT '',
      car_info             TEXT DEFAULT '',
      service              TEXT DEFAULT '',
      date                 TEXT NOT NULL,            -- YYYY-MM-DD del turno (entrega)
      time                 TEXT DEFAULT '',          -- HH:MM de entrega
      status               TEXT DEFAULT 'scheduled', -- scheduled|attended|in_progress|finished|retrieved|cancelled|no_show
      source               TEXT DEFAULT 'local',     -- local|google
      google_event_id      TEXT DEFAULT '',
      estimated_finish     TEXT DEFAULT '',          -- HH:MM estimada de fin (la indica el dueño)
      ready_date           TEXT DEFAULT '',          -- YYYY-MM-DD en que el auto queda listo (ajustable por el dueño)
      finished_at          TEXT DEFAULT '',          -- timestamp ISO cuando el dueño confirmó fin (el dueño)
      reminder_sent        INTEGER DEFAULT 0,        -- recordatorio 24h al cliente
      finish_check_sent    INTEGER DEFAULT 0,        -- ya se le preguntó al dueño si terminó
      pickup_notified      INTEGER DEFAULT 0,        -- ya se avisó al cliente que puede retirar
      review_requested     INTEGER DEFAULT 0,        -- ya se pidió reseña de Google
      review_requested_at  TEXT DEFAULT '',          -- timestamp ISO del pedido de reseña
      review_fallback_sent INTEGER DEFAULT 0,        -- ya se mandó la pregunta 1-10
      review_rating        INTEGER,                  -- nota 1-10 (si la dio)
      review_done          INTEGER DEFAULT 0,        -- el cliente ya respondió la reseña
      created_at           TEXT DEFAULT (datetime('now'))
    );
  `);

  // Guardar para persistir la estructura
  saveDB();

  // Insertar prompt por defecto si no existe
  const existing = queryOne('SELECT key FROM config WHERE key = ?', ['ai_prompt']);
  if (!existing) {
    run('INSERT INTO config (key, value) VALUES (?, ?)', ['ai_prompt', DEFAULT_PROMPT]);
  }

  // Defaults de configuración (solo si la clave no existe todavía)
  seedConfig('cal_capacity_per_day', '3');          // cupos de turno por día
  seedConfig('cal_slots', '08:00,08:30,09:00');     // horarios de entrega ofrecidos
  seedConfig('cal_workdays', '1,2,3,4,5,6');         // días laborables (0=Dom ... 6=Sáb)
  seedConfig('owner_number', '');                    // número de WhatsApp del dueño (modo asistente)
  seedConfig('google_review_url', '');               // link "Escribir una reseña" de Google
  seedConfig('reminder_enabled', 'true');            // recordatorio de turno 24h al cliente
  seedConfig('review_enabled', 'true');              // pedido de reseña post-servicio
  seedConfig('morning_summary_enabled', 'true');     // resumen matutino (8:00) al dueño
  seedConfig('checkin_enabled', 'true');             // check-in de servicio (10:00) con el dueño
  seedConfig('assistant_prompt', DEFAULT_ASSISTANT_PROMPT); // prompt del modo asistente del dueño
  seedConfig('admin_numbers', '');                   // números admin extra (coma) además de owner_number / ENV
  seedConfig('media_transcribe_enabled', 'true');    // transcribir audios / describir imágenes para el historial
  seedConfig('business_name', '');                   // nombre del negocio (para los mensajes al cliente)
  seedConfig('business_address', '');                // dirección del negocio (recordatorios / aviso de retiro)

  console.log('[DB] ✅ Base de datos inicializada correctamente');
}

function getDB() {
  if (!db) throw new Error('Base de datos no inicializada. Llamar initDB() primero.');
  return db;
}

// ─── Config ────────────────────────────────────────────────────────────────

function getConfig(key) {
  const row = queryOne('SELECT value FROM config WHERE key = ?', [key]);
  return row ? row.value : null;
}

/** Nombre del negocio para los mensajes al cliente. Configurable; default 'Turneo'. */
function getBusinessName() {
  return (getConfig('business_name') || '').trim() || 'Turneo';
}

function setConfig(key, value) {
  const existing = queryOne('SELECT key FROM config WHERE key = ?', [key]);
  if (existing) {
    run("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);
  } else {
    run('INSERT INTO config (key, value) VALUES (?, ?)', [key, value]);
  }
}

/** Inserta un valor de config SOLO si la clave no existe (no pisa lo que cargó el dueño). */
function seedConfig(key, value) {
  const existing = queryOne('SELECT key FROM config WHERE key = ?', [key]);
  if (!existing) run('INSERT INTO config (key, value) VALUES (?, ?)', [key, value]);
}

// ─── Mensajes ──────────────────────────────────────────────────────────────

function saveMessage(phone, direction, content) {
  run('INSERT INTO messages (phone, direction, content) VALUES (?, ?, ?)', [phone, direction, content]);
}

function getMessages(phone, limit = 50) {
  // sql.js no soporta parámetros nombrados fácilmente, usamos valores directos para LIMIT
  const rows = queryAll(
    `SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY rowid DESC LIMIT ${parseInt(limit)}) ORDER BY rowid ASC`,
    [phone]
  );
  return rows;
}

function getMessagesSince(isoCutoff) {
  return queryAll(
    'SELECT * FROM messages WHERE timestamp >= ? ORDER BY phone, rowid',
    [isoCutoff]
  );
}

/** Mensajes en un rango [fromUTC, toUTC) (formato SQLite 'YYYY-MM-DD HH:MM:SS'). */
function getMessagesBetween(fromUTC, toUTC) {
  return queryAll(
    'SELECT * FROM messages WHERE timestamp >= ? AND timestamp < ? ORDER BY phone, rowid',
    [fromUTC, toUTC]
  );
}

function getRecentChats() {
  return queryAll(`
    SELECT m.phone,
           m.content   AS last_message,
           m.direction AS last_direction,
           m.timestamp AS last_at,
           (SELECT COUNT(*) FROM messages WHERE phone = m.phone) AS total_msgs,
           CASE WHEN pc.phone IS NOT NULL THEN 1 ELSE 0 END AS is_paused
    FROM messages m
    LEFT JOIN paused_contacts pc ON pc.phone = m.phone
    WHERE m.id = (
      SELECT MAX(id) FROM messages WHERE phone = m.phone
    )
    ORDER BY m.timestamp DESC
    LIMIT 50
  `);
}

// ─── Pausa ─────────────────────────────────────────────────────────────────

function pauseContact(phone) {
  const exists = queryOne('SELECT phone FROM paused_contacts WHERE phone = ?', [phone]);
  if (exists) {
    run("UPDATE paused_contacts SET paused_at = datetime('now') WHERE phone = ?", [phone]);
  } else {
    run('INSERT INTO paused_contacts (phone) VALUES (?)', [phone]);
  }
}

function resumeContact(phone) {
  run('DELETE FROM paused_contacts WHERE phone = ?', [phone]);
}

function isPaused(phone) {
  const row = queryOne('SELECT phone FROM paused_contacts WHERE phone = ?', [phone]);
  return !!row;
}

// ─── Estado de conversación ────────────────────────────────────────────────

function getConversationState(phone) {
  const row = queryOne('SELECT * FROM conversation_state WHERE phone = ?', [phone]);
  if (!row) return { phone, history: [], step: 'initial', car_info: {}, is_new: true };
  return {
    ...row,
    history:  JSON.parse(row.history  || '[]'),
    car_info: JSON.parse(row.car_info || '{}'),
    is_new:   row.is_new === 1 || row.is_new === true,
  };
}

function saveConversationState(phone, history, step, car_info, is_new) {
  const historyJson  = JSON.stringify(history);
  const carInfoJson  = JSON.stringify(car_info);
  const isNewInt     = is_new ? 1 : 0;

  const existing = queryOne('SELECT phone FROM conversation_state WHERE phone = ?', [phone]);
  if (existing) {
    run(
      "UPDATE conversation_state SET history=?, step=?, car_info=?, is_new=?, updated_at=datetime('now') WHERE phone=?",
      [historyJson, step, carInfoJson, isNewInt, phone]
    );
  } else {
    run(
      'INSERT INTO conversation_state (phone, history, step, car_info, is_new) VALUES (?, ?, ?, ?, ?)',
      [phone, historyJson, step, carInfoJson, isNewInt]
    );
  }
}

// ─── Servicios ─────────────────────────────────────────────────────────────

function getServices() {
  return queryAll('SELECT * FROM services ORDER BY id ASC');
}

function addService({ name, description = '', price = '', notes = '' }) {
  run(
    'INSERT INTO services (name, description, price, notes) VALUES (?, ?, ?, ?)',
    [name, description, price, notes]
  );
}

function updateService(id, { name, description = '', price = '', notes = '' }) {
  run(
    'UPDATE services SET name = ?, description = ?, price = ?, notes = ? WHERE id = ?',
    [name, description, price, notes, id]
  );
}

function deleteService(id) {
  run('DELETE FROM services WHERE id = ?', [id]);
}

// ─── Turnos (calendario propio) ──────────────────────────────────────────────

// Estados que ocupan un cupo del día (los demás liberan el cupo)
const OCCUPYING_STATUSES = ['scheduled', 'attended', 'in_progress', 'finished', 'retrieved'];

/** Crea un turno y devuelve la fila insertada (con su id). */
function createAppointment({
  client_phone, client_name = '', car_info = '', service = '',
  date, time = '', source = 'local', google_event_id = '',
}) {
  // OJO: saveDB() (db.export()) resetea last_insert_rowid(), por eso insertamos
  // con db.run y leemos el id ANTES de persistir.
  db.run(
    `INSERT INTO appointments
       (client_phone, client_name, car_info, service, date, time, source, google_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalizePhone(client_phone), client_name, car_info, service, date, time, source, google_event_id]
  );
  const { id } = queryOne('SELECT last_insert_rowid() AS id');
  saveDB();
  return getAppointmentById(id);
}

function getAppointmentById(id) {
  return queryOne('SELECT * FROM appointments WHERE id = ?', [id]);
}

/** Turnos de una fecha (YYYY-MM-DD). Por defecto solo los que ocupan cupo. */
function getAppointmentsByDate(date, { includeInactive = false } = {}) {
  if (includeInactive) {
    return queryAll('SELECT * FROM appointments WHERE date = ? ORDER BY time ASC', [date]);
  }
  const placeholders = OCCUPYING_STATUSES.map(() => '?').join(',');
  return queryAll(
    `SELECT * FROM appointments WHERE date = ? AND status IN (${placeholders}) ORDER BY time ASC`,
    [date, ...OCCUPYING_STATUSES]
  );
}

/** Cuenta los turnos que ocupan cupo en una fecha (para validar capacidad). */
function countAppointmentsOnDate(date) {
  const placeholders = OCCUPYING_STATUSES.map(() => '?').join(',');
  const row = queryOne(
    `SELECT COUNT(*) AS n FROM appointments WHERE date = ? AND status IN (${placeholders})`,
    [date, ...OCCUPYING_STATUSES]
  );
  return row ? row.n : 0;
}

/** TODOS los turnos en un rango [from, to] inclusive, sin filtrar por estado. */
function getAllAppointmentsBetween(from, to) {
  return queryAll(
    `SELECT * FROM appointments WHERE date BETWEEN ? AND ? ORDER BY date ASC, time ASC`,
    [from, to]
  );
}

/** Turnos activos en un rango de fechas [from, to] inclusive (YYYY-MM-DD). */
function getAppointmentsBetween(from, to) {
  const placeholders = OCCUPYING_STATUSES.map(() => '?').join(',');
  return queryAll(
    `SELECT * FROM appointments
       WHERE date BETWEEN ? AND ? AND status IN (${placeholders})
       ORDER BY date ASC, time ASC`,
    [from, to, ...OCCUPYING_STATUSES]
  );
}

/** Turnos activos de un teléfono (los que todavía ocupan cupo). */
function getActiveAppointmentsByPhone(phone) {
  const placeholders = OCCUPYING_STATUSES.map(() => '?').join(',');
  return queryAll(
    `SELECT * FROM appointments
       WHERE client_phone = ? AND status IN (${placeholders})
       ORDER BY date ASC, time ASC`,
    [normalizePhone(phone), ...OCCUPYING_STATUSES]
  );
}

/**
 * Busca turnos por texto libre en nombre, teléfono, vehículo/patente o servicio.
 * Devuelve los más recientes primero. `limit` acota el resultado.
 */
function searchAppointments(query, limit = 20) {
  const q = `%${String(query || '').trim()}%`;
  const digits = normalizePhone(query);
  const phoneLike = digits ? `%${digits}%` : '% %'; // si no hay dígitos, no matchea por teléfono
  return queryAll(
    `SELECT * FROM appointments
       WHERE client_name LIKE ? OR car_info LIKE ? OR service LIKE ? OR client_phone LIKE ?
       ORDER BY date DESC, time DESC
       LIMIT ${parseInt(limit)}`,
    [q, q, q, phoneLike]
  );
}

/** Turno con reseña pendiente para un teléfono (ya pedida, no respondida aún). */
function getPendingReview(phone) {
  return queryOne(
    `SELECT * FROM appointments
       WHERE client_phone = ? AND review_requested = 1 AND review_done = 0
       ORDER BY id DESC LIMIT 1`,
    [normalizePhone(phone)]
  );
}

/** Turnos terminados cuyo "día siguiente al servicio" es hoy y aún sin pedir reseña. */
function getAppointmentsForReview(reviewDate) {
  // reviewDate = la fecha de listo (ready_date). El pedido sale al día siguiente.
  return queryAll(
    `SELECT * FROM appointments
       WHERE ready_date = ? AND status IN ('finished', 'retrieved')
         AND review_requested = 0`,
    [reviewDate]
  );
}

/** Turnos con reseña pedida hace rato, sin responder y sin fallback 1-10 enviado. */
function getReviewFallbackPending() {
  return queryAll(
    `SELECT * FROM appointments
       WHERE review_requested = 1 AND review_done = 0 AND review_fallback_sent = 0
         AND review_requested_at <> ''`
  );
}

/** Actualiza campos arbitrarios de un turno. Solo se permiten columnas conocidas. */
function updateAppointment(id, fields = {}) {
  const allowed = [
    'client_name', 'car_info', 'service', 'date', 'time', 'status', 'source',
    'google_event_id', 'estimated_finish', 'ready_date', 'finished_at',
    'reminder_sent', 'finish_check_sent', 'pickup_notified',
    'review_requested', 'review_requested_at', 'review_fallback_sent', 'review_rating', 'review_done',
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getAppointmentById(id);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  run(`UPDATE appointments SET ${setClause} WHERE id = ?`, [...values, id]);
  return getAppointmentById(id);
}

// ─── Bloqueos de agenda (días/horarios no disponibles) ──────────────────────

/** Bloquea un día completo (time='') o un horario puntual (HH:MM). */
function addBlockedSlot(date, time = '', note = '') {
  // Evitar duplicados exactos.
  const exists = queryOne('SELECT id FROM blocked_slots WHERE date = ? AND time = ?', [date, time || '']);
  if (exists) {
    run('UPDATE blocked_slots SET note = ? WHERE id = ?', [note, exists.id]);
    return exists.id;
  }
  db.run('INSERT INTO blocked_slots (date, time, note) VALUES (?, ?, ?)', [date, time || '', note]);
  const { id } = queryOne('SELECT last_insert_rowid() AS id');
  saveDB();
  return id;
}

function removeBlockedSlot(id) {
  run('DELETE FROM blocked_slots WHERE id = ?', [id]);
}

/** Quita todos los bloqueos de un día (día completo y horarios puntuales). */
function removeBlocksOnDate(date) {
  run('DELETE FROM blocked_slots WHERE date = ?', [date]);
}

/** Bloqueos en un rango de fechas [from, to] inclusive. */
function getBlockedSlots(from, to) {
  return queryAll(
    'SELECT * FROM blocked_slots WHERE date BETWEEN ? AND ? ORDER BY date ASC, time ASC',
    [from, to]
  );
}

/** ¿El día completo está bloqueado? (existe un bloqueo con time=''). */
function isDayBlocked(date) {
  const row = queryOne("SELECT id FROM blocked_slots WHERE date = ? AND time = ''", [date]);
  return !!row;
}

/** Horarios puntuales bloqueados en una fecha (array de 'HH:MM'). */
function getBlockedTimes(date) {
  return queryAll("SELECT time FROM blocked_slots WHERE date = ? AND time <> ''", [date])
    .map((r) => r.time);
}

// ─── Excepciones (contactos bloqueados) ────────────────────────────────────

function getBlockedContacts() {
  return queryAll('SELECT * FROM blocked_contacts ORDER BY created_at DESC');
}

function addBlockedContact(phone, note = '') {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const exists = queryOne('SELECT phone FROM blocked_contacts WHERE phone = ?', [normalized]);
  if (exists) {
    run('UPDATE blocked_contacts SET note = ? WHERE phone = ?', [note, normalized]);
  } else {
    run('INSERT INTO blocked_contacts (phone, note) VALUES (?, ?)', [normalized, note]);
  }
}

function removeBlockedContact(phone) {
  run('DELETE FROM blocked_contacts WHERE phone = ?', [normalizePhone(phone)]);
}

function isBlocked(phone) {
  const row = queryOne('SELECT phone FROM blocked_contacts WHERE phone = ?', [normalizePhone(phone)]);
  return !!row;
}

// ─── Util ──────────────────────────────────────────────────────────────────

/** Devuelve solo los dígitos de un JID o número (para comparar excepciones). */
function normalizePhone(jidOrNumber) {
  if (!jidOrNumber) return '';
  return String(jidOrNumber).replace(/^ig:/, '').replace(/\D/g, '');
}

module.exports = {
  DEFAULT_PROMPT,
  initDB, getDB, saveDB,
  getConfig, setConfig, getBusinessName,
  saveMessage, getMessages, getMessagesSince, getMessagesBetween, getRecentChats,
  pauseContact, resumeContact, isPaused,
  getConversationState, saveConversationState,
  getServices, addService, updateService, deleteService,
  getBlockedContacts, addBlockedContact, removeBlockedContact, isBlocked,
  addBlockedSlot, removeBlockedSlot, removeBlocksOnDate, getBlockedSlots, isDayBlocked, getBlockedTimes,
  createAppointment, getAppointmentById, getAppointmentsByDate,
  countAppointmentsOnDate, getAppointmentsBetween, getAllAppointmentsBetween, getActiveAppointmentsByPhone,
  getPendingReview, getAppointmentsForReview, getReviewFallbackPending, searchAppointments,
  updateAppointment,
  normalizePhone,
};
