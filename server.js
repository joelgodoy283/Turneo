require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { initDB } = require('./database/db');
const { startWhatsApp, getConnectionState } = require('./whatsapp/baileys');
const apiRoutes = require('./routes/api');
const dashboardRoutes = require('./routes/dashboard');
const googleAuthRoutes = require('./routes/auth-google');
const instagramRoutes = require('./routes/auth-instagram');
const webhookInstagramRoutes = require('./routes/webhook-instagram');
const { getInstagramStatus } = require('./instagram/instagram');
const { startDailySummary } = require('./jobs/daily-summary');
const { startMorningSummary } = require('./jobs/morning-summary');
const { startReminders } = require('./jobs/reminders');
const { startServiceCycle } = require('./jobs/service-cycle');
const { startReviews } = require('./jobs/reviews');

// ─── Express + Socket.io ────────────────────────────────────────────────────
const app = express();

// Detrás de un reverse proxy (Traefik/Nginx en el VPS) → confiar en los headers
// X-Forwarded-* para que la sesión y las cookies funcionen sobre HTTPS.
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Permitir ambos transportes y reconexión robusta detrás del proxy.
  transports: ['websocket', 'polling'],
  pingTimeout: 25000,
  pingInterval: 20000,
});

// Hacer io accesible globalmente (usado en whatsapp/baileys.js y routes)
global.io = io;

// ─── Asegurar que exista el directorio de sesiones ─────────────────────────
const sessionsDir = process.env.SESSION_DIR || path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// ─── Middleware ─────────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'lc-performance-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 horas
    secure: false, // Poner en true si usás HTTPS
  },
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Compartir sesión de Express con Socket.io
io.engine.use(sessionMiddleware);

// ─── Template engine ────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Rutas ──────────────────────────────────────────────────────────────────
app.use('/', googleAuthRoutes);
app.use('/', instagramRoutes);
app.use('/', webhookInstagramRoutes);
app.use('/', dashboardRoutes);
app.use('/api', apiRoutes);

// 404 handler
app.use((req, res) => res.status(404).send('Página no encontrada'));

// Error handler
app.use((err, req, res, next) => {
  console.error('[SERVER] Error:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Verificar autenticación via sesión
  const session = socket.request.session;
  if (!session?.authenticated) {
    socket.disconnect(true);
    return;
  }

  console.log('[SOCKET] Dashboard conectado:', socket.id);

  // Enviar estado actual al nuevo cliente del dashboard
  socket.emit('whatsapp:status', getConnectionState());
  socket.emit('instagram:status', getInstagramStatus());

  socket.on('disconnect', () => {
    console.log('[SOCKET] Dashboard desconectado:', socket.id);
  });
});

// ─── Arranque ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function main() {
  console.log('┌─────────────────────────────────────────┐');
  console.log('│   LC Performance - WhatsApp Bot v1.0    │');
  console.log('└─────────────────────────────────────────┘');

  // 1. Inicializar base de datos
  await initDB();
  console.log('[INIT] ✅ Base de datos lista');

  // 2. Arrancar servidor HTTP
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[INIT] ✅ Servidor web en http://localhost:${PORT}`);
  console.log(`[INIT]    Contraseña dashboard: ${process.env.DASHBOARD_PASSWORD || 'lc2024'}`);

  // 3. Iniciar conexión WhatsApp (después del servidor para que Socket.io esté listo)
  console.log('[INIT] 🔄 Iniciando WhatsApp...');
  await startWhatsApp();

  // 3b. Programar los jobs diarios (hora Argentina)
  startDailySummary();   // resumen de cierre — 19:00
  startMorningSummary(); // resumen matutino (turnos de hoy + actividad de ayer) — 08:00
  startReminders();      // recordatorio de turno al cliente — 11:00
  startServiceCycle();   // check-in 10:00 + poller de finalización (avisa retiro al cliente)
  startReviews();        // pedido de reseña al día siguiente del servicio (10:00) + fallback 1-10

  // 4. Instagram usa tokens guardados en DB, no necesita restauración de sesión
  const igStatus = getInstagramStatus();
  if (igStatus.status === 'connected') {
    console.log(`[INIT] ✅ Instagram conectado como @${igStatus.username}`);
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
