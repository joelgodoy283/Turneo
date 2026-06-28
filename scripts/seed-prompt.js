/**
 * Reemplaza el system prompt vivo (config `ai_prompt`) por el DEFAULT_PROMPT
 * actual de database/db.js. Útil cuando la fila ya existe en la DB y el seed
 * automático de initDB() no la pisa (p. ej. al actualizar el prompt en un
 * entorno ya desplegado).
 *
 * Uso: node scripts/seed-prompt.js
 */
const { initDB, setConfig, getConfig, DEFAULT_PROMPT } = require('../database/db');

(async () => {
  await initDB();
  const before = getConfig('ai_prompt') || '';
  setConfig('ai_prompt', DEFAULT_PROMPT);
  const after = getConfig('ai_prompt') || '';
  console.log(`[seed-prompt] Prompt anterior: ${before.length} chars`);
  console.log(`[seed-prompt] Prompt nuevo:    ${after.length} chars`);
  console.log('[seed-prompt] ✅ ai_prompt actualizado y persistido.');
  process.exit(0);
})().catch((err) => {
  console.error('[seed-prompt] ❌ Error:', err.message);
  process.exit(1);
});
