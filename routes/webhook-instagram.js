const express = require('express');
const router  = express.Router();
const { handleWebhookMessage } = require('../instagram/instagram');

const VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'lc-ig-webhook-2024';

// Meta llama este endpoint para verificar el webhook
router.get('/webhook/instagram', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[IG Webhook] ✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[IG Webhook] ❌ Token de verificación incorrecto');
  res.status(403).send('Forbidden');
});

// Meta envía los mensajes aquí
router.post('/webhook/instagram', (req, res) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (body.object !== 'instagram') return;

  body.entry?.forEach(entry => {
    entry.messaging?.forEach(async (event) => {
      // Ignorar mensajes propios (echo) y mensajes sin texto
      if (!event.message || event.message.is_echo) return;
      if (!event.message.text) return;

      const senderId = event.sender.id;
      const text     = event.message.text;

      try {
        await handleWebhookMessage(senderId, text);
      } catch (err) {
        console.error('[IG Webhook] Error:', err.message);
      }
    });
  });
});

module.exports = router;
