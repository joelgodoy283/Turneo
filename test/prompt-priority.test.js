const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `turneo-prompt-priority-${process.pid}.db`);

const { initDB, setConfig } = require('../database/db');
const { buildSystemPrompt } = require('../ai/openrouter');

test('Configurar IA es la autoridad principal del system prompt', async () => {
  await initDB();
  const official = 'PROMPT LC OFICIAL: no informar precios y atender de 8:15 a 17:15.';
  setConfig('ai_prompt', official);
  setConfig('share_prices', 'true'); // conflicto deliberado para verificar jerarquía

  const prompt = buildSystemPrompt();
  assert.match(prompt, /PROMPT OFICIAL DEL NEGOCIO/);
  assert.ok(prompt.includes(official));
  assert.match(prompt, /Si cualquier complemento contradice el PROMPT OFICIAL DEL NEGOCIO, obedecé el prompt oficial/);
  assert.ok(prompt.lastIndexOf('REGLA DE PRIORIDAD:') > prompt.indexOf('INFORMACIÓN COMPLEMENTARIA'));
});
