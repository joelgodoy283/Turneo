const express = require('express');
const router = express.Router();
const { generateAuthUrl, handleOAuthCallback, isCalendarConfigured, hasCredentials } = require('../calendar/google-calendar');

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

// Inicia el flujo OAuth2 → redirige a Google
router.get('/auth/google', requireAuth, (req, res) => {
  try {
    const url = generateAuthUrl();
    res.redirect(url);
  } catch (err) {
    res.redirect('/?google_error=' + encodeURIComponent(err.message));
  }
});

// Google redirige aquí con el ?code=... después de que el usuario acepta
router.get('/auth/google/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[GOOGLE AUTH] Error del callback:', error);
    return res.redirect('/?google_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?google_error=no_code');
  }

  try {
    await handleOAuthCallback(code);
    console.log('[GOOGLE AUTH] ✅ Token guardado correctamente');
    res.redirect('/?google_success=1');
  } catch (err) {
    console.error('[GOOGLE AUTH] Error al obtener tokens:', err.message);
    res.redirect('/?google_error=' + encodeURIComponent(err.message));
  }
});

// Estado de Google Calendar (para el frontend)
router.get('/api/google/status', requireAuth, (req, res) => {
  res.json({
    hasCredentials: hasCredentials(),
    isConnected:    isCalendarConfigured(),
  });
});

module.exports = router;
