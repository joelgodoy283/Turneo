const express = require('express');
const router  = express.Router();
const { generateAuthUrl, handleOAuthCallback, disconnectInstagram, getInstagramStatus } = require('../instagram/instagram');

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

function requireApiAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// Estado (para el frontend)
router.get('/api/instagram/status', requireApiAuth, (req, res) => {
  res.json(getInstagramStatus());
});

// Inicia el flujo OAuth → redirige a Facebook
router.get('/auth/instagram', requireAuth, (req, res) => {
  try {
    res.redirect(generateAuthUrl());
  } catch (err) {
    res.redirect('/?ig_error=' + encodeURIComponent(err.message));
  }
});

// Facebook redirige aquí con el código (sin requireAuth: viene de dominio externo, sin session cookie)
router.get('/auth/instagram/callback', async (req, res) => {
  const { code, error } = req.query;
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

  if (error) return res.redirect(dashboardUrl + '/?ig_error=' + encodeURIComponent(error));
  if (!code)  return res.redirect(dashboardUrl + '/?ig_error=no_code');

  try {
    await handleOAuthCallback(code);
    res.redirect(dashboardUrl + '/?ig_success=1');
  } catch (err) {
    console.error('[IG AUTH] Error:', err.message);
    res.redirect(dashboardUrl + '/?ig_error=' + encodeURIComponent(err.message));
  }
});

// Desconectar
router.post('/api/instagram/disconnect', requireApiAuth, (req, res) => {
  disconnectInstagram();
  res.json({ success: true });
});

module.exports = router;
