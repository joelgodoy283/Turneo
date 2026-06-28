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

// ─── Raíz: landing del producto (logueado → panel) ─────────────────────────
// Sin sesión → landing pública de Turneo (lleva al panel). Con sesión → panel.
// Mantener "/" para ambos evita romper los redirects/OAuth que vuelven a "/".
router.get('/', (req, res) => {
  if (req.session?.authenticated) return res.render('dashboard');
  res.render('landing');
});

module.exports = router;
