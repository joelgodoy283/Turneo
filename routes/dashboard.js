const express = require('express');
const router = express.Router();

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'lc2024';

// ─── Middleware de autenticación ───────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

// ─── Login ─────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Contraseña incorrecta' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── Dashboard principal ────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.render('dashboard');
});

module.exports = router;
