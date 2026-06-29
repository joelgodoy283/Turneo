/* ═══════════════════════════════════════════════════
   Turneo Dashboard — Frontend Logic
════════════════════════════════════════════════════ */

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

// Al (re)conectar, refrescar la vista activa para no quedar con datos viejos
// o con el "Cargando..." colgado si el primer intento falló.
socket.on('connect', () => {
  const active = document.querySelector('.tab-content.active');
  if (active) refreshView(active.id);
});

socket.io.on('reconnect', () => {
  const active = document.querySelector('.tab-content.active');
  if (active) refreshView(active.id);
});

function refreshView(tabId) {
  if (tabId === 'tab-chats') {
    loadChatList();
    if (currentPhone) openChat(currentPhone);
  }
  if (tabId === 'tab-calendar')  { loadTurnos(); }
  if (tabId === 'tab-instagram') loadInstagramStatus();
  if (tabId === 'tab-home')      loadHome();
}

// ─── Estado local ───────────────────────────────────
let currentPhone    = null;
let pausedPhones    = new Set();
let pendingMessages = 0;

// ─── Manejar retorno del OAuth de Google ─────────────
(function checkOAuthReturn() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('ig_success')) {
    showToast('✅ Instagram conectado correctamente', 'success');
    window.history.replaceState({}, '', '/');
    activateTab('tab-instagram');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('[data-tab="tab-instagram"]')?.classList.add('active');
  }
  if (params.get('ig_error')) {
    const msg = decodeURIComponent(params.get('ig_error'));
    window.history.replaceState({}, '', '/');
    activateTab('tab-instagram');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('[data-tab="tab-instagram"]')?.classList.add('active');
    const errEl = document.getElementById('ig-connect-error');
    if (errEl) { errEl.textContent = '❌ ' + msg; errEl.style.display = ''; }
    showToast('❌ Error conectando Instagram: ' + msg, 'error');
  }
})();

// ─── TABS ────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const tab = item.dataset.tab;
    activateTab(tab);
    item.closest('.sidebar-nav').querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
  });
});

function activateTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');

  if (tabId === 'tab-chats')      loadChatList();
  if (tabId === 'tab-prompt')     { loadPrompt(); loadSummaryConfig(); loadAssistantPrompt(); }
  if (tabId === 'tab-calendar')   { loadTurnos(); }
  if (tabId === 'tab-instagram')  loadInstagramStatus();
  if (tabId === 'tab-services')   loadServices();
  if (tabId === 'tab-exceptions') loadExceptions();
  if (tabId === 'tab-home')       loadHome();
}

// Navegación desde enlaces dentro del contenido (no del sidebar): botones y
// tarjetas con [data-tab]. Sincroniza el resaltado del menú lateral.
document.querySelectorAll('[data-tab]:not(.nav-item)').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const tab = el.dataset.tab;
    activateTab(tab);
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(n =>
      n.classList.toggle('active', n.dataset.tab === tab));
  });
});

// ─── INICIO (panel diario) ───────────────────────────
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const HOME_INACTIVE = ['cancelled', 'no_show'];

async function loadHome() {
  // Fecha legible
  const dateEl = document.getElementById('home-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('es-AR',
      { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const res = await apiFetch('/api/appointments');
  const listEl = document.getElementById('home-today-list');
  if (!res) { if (listEl) listEl.innerHTML = '<p class="empty-state">Error al cargar</p>'; return; }

  const { appointments = [], today } = await res.json();
  const tomorrow = addDaysStr(today, 1);
  const weekEnd  = addDaysStr(today, 6);
  const active = appointments.filter(a => !HOME_INACTIVE.includes(a.status));

  const todays = active.filter(a => a.date === today).sort((x, y) => (x.time || '').localeCompare(y.time || ''));
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-today',    todays.length);
  set('stat-tomorrow', active.filter(a => a.date === tomorrow).length);
  set('stat-week',     active.filter(a => a.date >= today && a.date <= weekEnd).length);
  set('stat-pending',  active.filter(a => a.status === 'finished').length);

  if (!listEl) return;
  if (!todays.length) {
    listEl.innerHTML = '<p class="empty-state">No hay turnos para hoy.</p>';
    return;
  }
  listEl.innerHTML = todays.map(a => `
    <div class="home-appt">
      <div class="home-appt-time">${a.time || '—'}</div>
      <div class="home-appt-main">
        <strong>${escapeHtml(a.client_name || formatPhone(a.client_phone))}</strong>
        <span>${escapeHtml(a.detail || '')}${a.service ? ' · ' + escapeHtml(a.service) : ''}</span>
      </div>
      <span class="badge ${homeStatusClass(a.status)}">${homeStatusLabel(a.status)}</span>
    </div>`).join('');
}

function homeStatusLabel(s) {
  return ({ scheduled:'Agendado', attended:'Vino', in_progress:'En proceso',
    finished:'Listo', retrieved:'Retirado' })[s] || s;
}
function homeStatusClass(s) {
  if (s === 'finished' || s === 'retrieved') return 'badge-active';
  if (s === 'in_progress') return 'badge-paused';
  return '';
}

// Refleja el estado de WhatsApp en el panel de inicio.
function updateHomeStatus(status) {
  const dot = document.getElementById('home-dot');
  const title = document.getElementById('home-status-title');
  const sub = document.getElementById('home-status-sub');
  const link = document.getElementById('home-connect-link');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  const connected = status === 'connected';
  if (title) title.textContent = connected ? 'WhatsApp conectado' : 'WhatsApp desconectado';
  if (sub) sub.textContent = connected
    ? 'El bot está atendiendo y tomando turnos automáticamente.'
    : 'Conectá tu WhatsApp para empezar a tomar turnos.';
  if (link) link.style.display = connected ? 'none' : '';
}

// ─── WHATSAPP STATUS ─────────────────────────────────
socket.on('whatsapp:status', (state) => updateWAStatus(state));
socket.on('whatsapp:qr',     (qrDataUrl) => renderQR(qrDataUrl));

// ─── INSTAGRAM STATUS ────────────────────────────────
socket.on('instagram:status', (state) => updateIGStatus(state));

function updateWAStatus({ status, qr }) {
  const dot  = document.querySelector('#wa-status-sidebar .status-dot');
  const text = document.getElementById('wa-status-text');

  const labels = { connected: 'Conectado', disconnected: 'Desconectado', qr: 'Esperando QR', connecting: 'Conectando...' };
  if (dot)  { dot.className = `status-dot ${status}`; }
  if (text) { text.textContent = labels[status] || status; }

  updateHomeStatus(status);

  const connectedDiv  = document.getElementById('wa-connected-state');
  const qrDiv         = document.getElementById('wa-qr-state');
  const connectingDiv = document.getElementById('wa-connecting-state');

  if (connectedDiv)  connectedDiv.style.display  = status === 'connected'                ? '' : 'none';
  if (qrDiv)         qrDiv.style.display          = status === 'qr' || status === 'disconnected' ? '' : 'none';
  if (connectingDiv) connectingDiv.style.display  = status === 'connecting'              ? '' : 'none';

  if (status === 'qr' && qr) renderQR(qr);
}

function renderQR(qrDataUrl) {
  const wrapper = document.getElementById('qr-wrapper');
  if (!wrapper) return;
  wrapper.innerHTML = `
    <div class="qr-wrapper-inner">
      <img src="${qrDataUrl}" alt="QR Code WhatsApp">
    </div>
    <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">
      El QR expira en ~20 segundos. Escanealo rápido.
    </p>`;
}

// ─── INSTAGRAM ───────────────────────────────────────
async function loadInstagramStatus() {
  const res = await apiFetch('/api/instagram/status');
  if (!res) return;
  const state = await res.json();
  updateIGStatus(state);
}

function updateIGStatus(state) {
  const dot = document.getElementById('ig-nav-dot');
  if (dot) dot.style.background = state.status === 'connected' ? 'var(--success)' : 'var(--text-muted)';

  const disconnected = document.getElementById('ig-disconnected');
  const challenge    = document.getElementById('ig-challenge');
  const connected    = document.getElementById('ig-connected');
  if (!disconnected) return;

  disconnected.style.display = 'none';
  challenge.style.display    = 'none';
  connected.style.display    = 'none';

  if (state.status === 'connected') {
    connected.style.display = '';
    const userEl = document.getElementById('ig-connected-username');
    if (userEl) userEl.textContent = `@${state.username || ''}`;
  } else if (state.status === 'challenge') {
    challenge.style.display = '';
  } else {
    disconnected.style.display = '';
  }

  if (state.status === 'error') {
    showToast(`❌ Error Instagram: ${state.error || 'Error desconocido'}`, 'error');
  }
}

// El botón de Instagram usa href="/auth/instagram" directamente (OAuth redirect)

document.getElementById('btn-ig-disconnect')?.addEventListener('click', async () => {
  if (!confirm('¿Desconectar Instagram? El bot dejará de responder DMs.')) return;
  await apiFetch('/api/instagram/disconnect', { method: 'POST' });
  updateIGStatus({ status: 'disconnected' });
  showToast('Instagram desconectado', 'message');
});

// ─── CHAT: LISTA ─────────────────────────────────────
async function loadChatList() {
  const list = document.getElementById('chat-list');
  const res  = await apiFetch('/api/chats');
  if (!res) { list.innerHTML = '<p class="empty-state">Error al cargar chats</p>'; return; }

  const chats = await res.json();
  pausedPhones = new Set(chats.filter(c => c.is_paused).map(c => c.phone));

  if (!chats.length) {
    list.innerHTML = '<p class="empty-state">No hay conversaciones aún</p>';
    return;
  }

  list.innerHTML = chats.map(chat => `
    <div class="chat-list-item ${chat.is_paused ? 'paused' : ''} ${chat.phone === currentPhone ? 'active' : ''}"
         data-phone="${chat.phone}" onclick="openChat('${chat.phone}')">
      <div class="chat-avatar">${chat.phone.startsWith('ig:') ? '📸' : '👤'}</div>
      <div class="chat-list-info">
        <div class="chat-list-phone">${formatPhone(chat.phone)}</div>
        <div class="chat-list-preview">${escapeHtml(chat.last_message?.substring(0, 40) || '')}${chat.last_message?.length > 40 ? '…' : ''}</div>
      </div>
      <div class="chat-list-meta">
        <span class="chat-time">${timeAgo(chat.last_at)}</span>
        ${chat.is_paused ? '<span class="badge badge-paused">Pausado</span>' : ''}
      </div>
    </div>`).join('');
}

// ─── CHAT: VENTANA ───────────────────────────────────
async function openChat(phone) {
  currentPhone = phone;

  // Marcar activo en lista
  document.querySelectorAll('.chat-list-item').forEach(i => {
    i.classList.toggle('active', i.dataset.phone === phone);
  });

  document.getElementById('chat-empty-state').style.display = 'none';
  const chatWindow = document.getElementById('chat-window');
  chatWindow.style.display = 'flex';

  document.getElementById('chat-phone-display').textContent = formatPhone(phone);

  const res = await apiFetch(`/api/chats/${encodeURIComponent(phone)}/messages`);
  if (!res) return;

  const { messages, paused } = await res.json();
  if (paused) pausedPhones.add(phone); else pausedPhones.delete(phone);

  renderMessages(messages);
  updatePauseButton(phone);
}

function renderMessages(messages) {
  const container = document.getElementById('chat-messages');
  if (!messages.length) {
    container.innerHTML = '<p class="empty-state">Sin mensajes</p>';
    return;
  }
  container.innerHTML = messages.map(msg => `
    <div>
      <div class="message-bubble ${msg.direction}">
        ${escapeHtml(msg.content)}
      </div>
      <div class="message-time">${formatDate(msg.timestamp)}</div>
    </div>`).join('');
  container.scrollTop = container.scrollHeight;
}

function addMessageToWindow(phone, direction, content, timestamp) {
  if (phone !== currentPhone) return;
  const container = document.getElementById('chat-messages');
  const placeholder = container.querySelector('.empty-state');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.innerHTML = `
    <div class="message-bubble ${direction}">${escapeHtml(content)}</div>
    <div class="message-time">${formatDate(timestamp)}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ─── CHAT: ACCIONES ──────────────────────────────────
function updatePauseButton(phone) {
  const btn = document.getElementById('btn-toggle-pause');
  const badge = document.getElementById('chat-status-badge');
  if (!btn) return;

  if (pausedPhones.has(phone)) {
    btn.textContent = '▶️ Reanudar bot';
    btn.className = 'btn btn-sm btn-success';
    if (badge) { badge.textContent = 'Bot pausado'; badge.className = 'badge badge-paused'; }
  } else {
    btn.textContent = '⏸ Pausar bot';
    btn.className = 'btn btn-sm btn-warning';
    if (badge) { badge.textContent = 'Bot activo'; badge.className = 'badge badge-active'; }
  }
}

document.getElementById('btn-toggle-pause')?.addEventListener('click', async () => {
  if (!currentPhone) return;
  const paused = pausedPhones.has(currentPhone);
  const endpoint = paused ? 'resume' : 'pause';

  const res = await apiFetch(`/api/chats/${encodeURIComponent(currentPhone)}/${endpoint}`, { method: 'POST' });
  if (!res) return;

  if (paused) pausedPhones.delete(currentPhone); else pausedPhones.add(currentPhone);
  updatePauseButton(currentPhone);
  showToast(paused ? '✅ Bot reactivado' : '⏸ Bot pausado para este cliente', 'success');
  loadChatList();
});

document.getElementById('btn-send-manual')?.addEventListener('click', () => {
  const area = document.getElementById('manual-reply-area');
  area.style.display = area.style.display === 'none' ? '' : 'none';
  if (area.style.display !== 'none') {
    document.getElementById('manual-message').focus();
  }
});

document.getElementById('btn-cancel-reply')?.addEventListener('click', () => {
  document.getElementById('manual-reply-area').style.display = 'none';
  document.getElementById('manual-message').value = '';
});

document.getElementById('btn-send-message')?.addEventListener('click', sendManualMessage);

document.getElementById('manual-message')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendManualMessage();
});

async function sendManualMessage() {
  const text = document.getElementById('manual-message').value.trim();
  if (!text || !currentPhone) return;

  const res = await apiFetch(`/api/chats/${encodeURIComponent(currentPhone)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (res?.ok) {
    document.getElementById('manual-message').value = '';
    document.getElementById('manual-reply-area').style.display = 'none';
    showToast('✅ Mensaje enviado', 'success');
  } else {
    showToast('❌ Error al enviar mensaje', 'error');
  }
}

// ─── SOCKET: TIEMPO REAL ─────────────────────────────
socket.on('chat:new_message', ({ phone, direction, content, timestamp }) => {
  addMessageToWindow(phone, direction, content, timestamp);

  // Actualizar la lista de chats si es visible
  if (document.getElementById('tab-chats').classList.contains('active')) {
    loadChatList();
  }

  // Notificar si el mensaje es de un cliente y no está en la ventana actual
  if (direction === 'incoming' && phone !== currentPhone) {
    pendingMessages++;
    updatePendingBadge();
    showToast(`💬 Nuevo mensaje de ${formatPhone(phone)}`, 'message');
  }
});

socket.on('chat:paused', ({ phone }) => {
  pausedPhones.add(phone);
  if (phone === currentPhone) updatePauseButton(phone);
  loadChatList();
});

socket.on('chat:resumed', ({ phone }) => {
  pausedPhones.delete(phone);
  if (phone === currentPhone) updatePauseButton(phone);
  loadChatList();
});

socket.on('notification', ({ type, phone, message }) => {
  if (type === 'handoff') {
    showToast(`🤝 ${formatPhone(phone)} pidió hablar con una persona`, 'handoff');
    pendingMessages++;
    updatePendingBadge();
  }
});

function updatePendingBadge() {
  const badge = document.getElementById('badge-pending');
  if (!badge) return;
  if (pendingMessages > 0) {
    badge.textContent = pendingMessages > 9 ? '9+' : pendingMessages;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Reset badge al abrir la tab de chats
document.querySelector('[data-tab="tab-chats"]')?.addEventListener('click', () => {
  pendingMessages = 0;
  updatePendingBadge();
});

// ─── PROMPT / IA ─────────────────────────────────────
async function loadPrompt() {
  const res = await apiFetch('/api/config/prompt');
  if (res) {
    const { prompt } = await res.json();
    const ta = document.getElementById('ai-prompt');
    if (ta) ta.value = prompt;
  }

  const spRes = await apiFetch('/api/config/share-prices');
  if (spRes) {
    const { sharePrices } = await spRes.json();
    const cb = document.getElementById('share-prices');
    if (cb) cb.checked = !!sharePrices;
  }
}

document.getElementById('btn-save-prompt')?.addEventListener('click', async () => {
  const prompt = document.getElementById('ai-prompt')?.value.trim();
  if (!prompt) return;

  const res = await apiFetch('/api/config/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  // Guardar también la preferencia de precios
  const sharePrices = document.getElementById('share-prices')?.checked;
  await apiFetch('/api/config/share-prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharePrices }),
  });

  const status = document.getElementById('prompt-save-status');
  if (res?.ok) {
    if (status) { status.textContent = '✅ Guardado'; status.classList.add('visible'); }
    setTimeout(() => status?.classList.remove('visible'), 3000);
  } else {
    showToast('❌ Error al guardar el prompt', 'error');
  }
});


// ─── BUSCAR EN LISTA DE CHATS ─────────────────────────
document.getElementById('chat-search')?.addEventListener('input', function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll('.chat-list-item').forEach(item => {
    item.style.display = item.dataset.phone.includes(q) ? '' : 'none';
  });
});

// ─── SERVICIOS ───────────────────────────────────────
async function loadServices() {
  const tbody = document.getElementById('services-tbody');
  const res = await apiFetch('/api/services');
  if (!res) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error al cargar</td></tr>'; return; }

  const services = await res.json();
  if (!services.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No hay servicios cargados aún</td></tr>';
    return;
  }

  tbody.innerHTML = services.map(s => `
    <tr data-id="${s.id}">
      <td><div contenteditable="true" data-field="name">${escapeHtml(s.name)}</div></td>
      <td><div contenteditable="true" data-field="description">${escapeHtml(s.description || '')}</div></td>
      <td><div contenteditable="true" data-field="price">${escapeHtml(s.price || '')}</div></td>
      <td><div contenteditable="true" data-field="notes">${escapeHtml(s.notes || '')}</div></td>
      <td class="col-actions">
        <button class="btn btn-sm btn-primary" onclick="saveServiceRow(${s.id})">💾</button>
        <button class="btn btn-sm btn-secondary" onclick="deleteServiceRow(${s.id})">🗑</button>
      </td>
    </tr>`).join('');
}

async function saveServiceRow(id) {
  const row = document.querySelector(`#services-tbody tr[data-id="${id}"]`);
  if (!row) return;
  const get = f => row.querySelector(`[data-field="${f}"]`)?.innerText.trim() || '';
  const body = { name: get('name'), description: get('description'), price: get('price'), notes: get('notes') };
  if (!body.name) { showToast('❌ El nombre no puede estar vacío', 'error'); return; }

  const res = await apiFetch(`/api/services/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  showToast(res?.ok ? '✅ Servicio actualizado' : '❌ Error al guardar', res?.ok ? 'success' : 'error');
}

async function deleteServiceRow(id) {
  if (!confirm('¿Eliminar este servicio?')) return;
  const res = await apiFetch(`/api/services/${id}`, { method: 'DELETE' });
  if (res?.ok) { showToast('🗑 Servicio eliminado', 'message'); loadServices(); }
}

document.getElementById('btn-add-service')?.addEventListener('click', async () => {
  const name  = document.getElementById('svc-name').value.trim();
  if (!name) { showToast('❌ Ingresá un nombre', 'error'); return; }
  const body = {
    name,
    description: document.getElementById('svc-desc').value.trim(),
    price:       document.getElementById('svc-price').value.trim(),
    notes:       document.getElementById('svc-notes').value.trim(),
  };
  const res = await apiFetch('/api/services', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res?.ok) {
    ['svc-name','svc-desc','svc-price','svc-notes'].forEach(id => document.getElementById(id).value = '');
    showToast('✅ Servicio agregado', 'success');
    loadServices();
  } else {
    showToast('❌ Error al agregar', 'error');
  }
});

// ─── EXCEPCIONES ─────────────────────────────────────
async function loadExceptions() {
  const tbody = document.getElementById('exceptions-tbody');
  const res = await apiFetch('/api/exceptions');
  if (!res) { tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Error al cargar</td></tr>'; return; }

  const list = await res.json();
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No hay números bloqueados</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(e => `
    <tr>
      <td>${escapeHtml(e.phone)}</td>
      <td>${escapeHtml(e.note || '')}</td>
      <td class="col-actions">
        <button class="btn btn-sm btn-secondary" onclick="deleteException('${e.phone}')">🗑 Quitar</button>
      </td>
    </tr>`).join('');
}

document.getElementById('btn-add-exception')?.addEventListener('click', async () => {
  const phone = document.getElementById('exc-phone').value.trim();
  if (!phone) { showToast('❌ Ingresá un número', 'error'); return; }
  const note = document.getElementById('exc-note').value.trim();
  const res = await apiFetch('/api/exceptions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, note }),
  });
  if (res?.ok) {
    document.getElementById('exc-phone').value = '';
    document.getElementById('exc-note').value = '';
    showToast('🚫 Número bloqueado', 'success');
    loadExceptions();
  } else {
    showToast('❌ Error al bloquear', 'error');
  }
});

async function deleteException(phone) {
  const res = await apiFetch(`/api/exceptions/${encodeURIComponent(phone)}`, { method: 'DELETE' });
  if (res?.ok) { showToast('Número desbloqueado', 'message'); loadExceptions(); }
}

// ─── RESUMEN DIARIO ──────────────────────────────────
async function loadSummaryConfig() {
  const res = await apiFetch('/api/summary/config');
  if (!res) return;
  const { number, enabled } = await res.json();
  const numEl = document.getElementById('summary-number');
  const enEl  = document.getElementById('summary-enabled');
  if (numEl) numEl.value = number || '';
  if (enEl)  enEl.checked = !!enabled;
}

document.getElementById('btn-save-summary')?.addEventListener('click', async () => {
  const number  = document.getElementById('summary-number').value.trim();
  const enabled = document.getElementById('summary-enabled').checked;
  const res = await apiFetch('/api/summary/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number, enabled }),
  });
  const status = document.getElementById('summary-save-status');
  if (res?.ok) {
    if (status) { status.textContent = '✅ Guardado'; status.classList.add('visible'); }
    setTimeout(() => status?.classList.remove('visible'), 3000);
  } else {
    showToast('❌ Error al guardar', 'error');
  }
});

document.getElementById('btn-test-summary')?.addEventListener('click', async () => {
  showToast('⏳ Generando resumen de prueba...', 'message');
  const res = await apiFetch('/api/summary/test', { method: 'POST' });
  if (!res) return;
  const result = await res.json();
  if (result.sent) {
    showToast('✅ Resumen enviado por WhatsApp', 'success');
  } else {
    showToast('❌ ' + (result.reason || 'No se pudo enviar'), 'error');
  }
});

// ─── TURNOS: CONFIG ──────────────────────────────────
function loadTurnos() {
  loadTurnosConfig();
  loadAppointments();
}

async function loadTurnosConfig() {
  const res = await apiFetch('/api/config/turnos');
  if (!res) return;
  const c = await res.json();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v === 'true'; };

  set('cfg-business-name', c.business_name);
  set('cfg-business-address', c.business_address);
  set('cfg-owner-number', c.owner_number);
  set('cfg-capacity', c.cal_capacity_per_day);
  set('cfg-slots', c.cal_slots);
  set('cfg-review-url', c.google_review_url);
  chk('cfg-morning', c.morning_summary_enabled);
  chk('cfg-checkin', c.checkin_enabled);
  chk('cfg-reminder', c.reminder_enabled);
  chk('cfg-review', c.review_enabled);

  const days = (c.cal_workdays || '').split(',').map(s => s.trim());
  for (let d = 0; d <= 6; d++) {
    const el = document.getElementById('wd-' + d);
    if (el) el.checked = days.includes(String(d));
  }
}

document.getElementById('btn-save-turnos')?.addEventListener('click', async () => {
  const workdays = [];
  for (let d = 0; d <= 6; d++) {
    if (document.getElementById('wd-' + d)?.checked) workdays.push(d);
  }
  const body = {
    business_name: document.getElementById('cfg-business-name').value.trim(),
    business_address: document.getElementById('cfg-business-address').value.trim(),
    owner_number: document.getElementById('cfg-owner-number').value.trim(),
    cal_capacity_per_day: document.getElementById('cfg-capacity').value.trim() || '3',
    cal_slots: document.getElementById('cfg-slots').value.trim(),
    cal_workdays: workdays.join(','),
    google_review_url: document.getElementById('cfg-review-url').value.trim(),
    morning_summary_enabled: document.getElementById('cfg-morning').checked,
    checkin_enabled: document.getElementById('cfg-checkin').checked,
    reminder_enabled: document.getElementById('cfg-reminder').checked,
    review_enabled: document.getElementById('cfg-review').checked,
  };
  const res = await apiFetch('/api/config/turnos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = document.getElementById('turnos-save-status');
  if (res?.ok) {
    if (status) { status.textContent = '✅ Guardado'; status.classList.add('visible'); }
    setTimeout(() => status?.classList.remove('visible'), 3000);
  } else {
    showToast('❌ Error al guardar la configuración', 'error');
  }
});

document.getElementById('btn-test-morning')?.addEventListener('click', async () => {
  showToast('⏳ Enviando resumen matutino de prueba...', 'message');
  const res = await apiFetch('/api/turnos/test-morning', { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  showToast(r.sent ? '✅ Resumen matutino enviado' : '❌ ' + (r.reason || 'No se pudo enviar'), r.sent ? 'success' : 'error');
});

document.getElementById('btn-test-reminders')?.addEventListener('click', async () => {
  showToast('⏳ Enviando recordatorios de prueba...', 'message');
  const res = await apiFetch('/api/turnos/test-reminders', { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  showToast(r.ok ? `✅ ${r.sent || 0} recordatorio(s) enviado(s)` : '❌ ' + (r.reason || 'No se pudo'), r.ok ? 'success' : 'error');
});

// ─── TURNOS: TABLA ───────────────────────────────────
const STATUS_LABELS = {
  scheduled:  { t: 'Agendado',   c: 'badge-active' },
  attended:   { t: 'Asistió',    c: 'badge-active' },
  in_progress:{ t: 'En proceso', c: 'badge-warning' },
  finished:   { t: 'Terminado',  c: 'badge-active' },
  retrieved:  { t: 'Retirado',   c: 'badge-paused' },
  cancelled:  { t: 'Cancelado',  c: 'badge-paused' },
  no_show:    { t: 'No asistió',  c: 'badge-warning' },
};

async function loadAppointments() {
  const tbody = document.getElementById('appointments-tbody');
  if (!tbody) return;
  const res = await apiFetch('/api/appointments');
  if (!res) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error al cargar</td></tr>'; return; }
  const { appointments } = await res.json();

  if (!appointments.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay turnos en la ventana actual</td></tr>';
    return;
  }

  tbody.innerHTML = appointments.map(a => {
    const st = STATUS_LABELS[a.status] || { t: a.status, c: 'badge' };
    const activo = !['cancelled', 'no_show', 'retrieved'].includes(a.status);
    const nota = a.review_rating ? `⭐ ${a.review_rating}/10` : (a.review_requested ? '⏳' : '');
    return `
      <tr data-id="${a.id}">
        <td>${escapeHtml(a.date)}</td>
        <td>${escapeHtml(a.time || '—')}</td>
        <td>${escapeHtml(a.client_name || formatPhone(a.client_phone))}</td>
        <td>${escapeHtml(a.detail || '')}</td>
        <td>${escapeHtml(a.service || '')}</td>
        <td><span class="badge ${st.c}">${st.t}</span></td>
        <td>${nota}</td>
        <td class="col-actions">
          ${activo ? `<button class="btn btn-sm btn-secondary" onclick="cancelAppointment(${a.id})">✖ Cancelar</button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

async function cancelAppointment(id) {
  if (!confirm('¿Cancelar este turno? Se le avisará al cliente y se le ofrecerá reagendar.')) return;
  const res = await apiFetch(`/api/appointments/${id}/cancel`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  if (r.success) { showToast('Turno cancelado', 'message'); loadAppointments(); }
  else showToast('❌ ' + (r.message || r.error || 'No se pudo cancelar'), 'error');
}

document.getElementById('btn-refresh-appointments')?.addEventListener('click', loadAppointments);

// ─── ASISTENTE DEL DUEÑO (prompt) ─────────────────────
async function loadAssistantPrompt() {
  const res = await apiFetch('/api/config/assistant-prompt');
  if (!res) return;
  const { prompt } = await res.json();
  const ta = document.getElementById('assistant-prompt');
  if (ta) ta.value = prompt || '';
}

document.getElementById('btn-save-assistant-prompt')?.addEventListener('click', async () => {
  const prompt = document.getElementById('assistant-prompt')?.value.trim();
  if (!prompt) { showToast('❌ El prompt no puede estar vacío', 'error'); return; }
  const res = await apiFetch('/api/config/assistant-prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
  });
  const status = document.getElementById('assistant-save-status');
  if (res?.ok) {
    if (status) { status.textContent = '✅ Guardado'; status.classList.add('visible'); }
    setTimeout(() => status?.classList.remove('visible'), 3000);
  } else {
    showToast('❌ Error al guardar', 'error');
  }
});

// ─── TOAST ───────────────────────────────────────────
function showToast(message, type = 'message') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; }, 4000);
  setTimeout(() => toast.remove(), 4500);
}

// ─── API HELPER ───────────────────────────────────────
async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (res.status === 401) { window.location.href = '/login'; return null; }
    return res;
  } catch (err) {
    console.error('API error:', err);
    showToast('❌ Error de conexión', 'error');
    return null;
  }
}

// ─── UTILS ───────────────────────────────────────────
function formatPhone(jid) {
  if (!jid) return '';
  if (jid.startsWith('ig:')) return `📸 IG·${jid.slice(3, -4)}…${jid.slice(-4)}`;
  const num = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  if (num.startsWith('549') && num.length >= 12) {
    return `+54 9 ${num.slice(3,6)} ${num.slice(6,9)}-${num.slice(9)}`;
  }
  return `+${num}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'ahora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─── INIT ────────────────────────────────────────────
// La pestaña Inicio es la activa por defecto: cargar su contenido al entrar.
if (document.getElementById('tab-home')?.classList.contains('active')) loadHome();
