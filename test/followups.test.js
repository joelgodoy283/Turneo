const test = require('node:test');
const assert = require('node:assert/strict');
const { clampToBusinessHours, followupText } = require('../jobs/followups');

test('un seguimiento del domingo pasa al lunes a las 09:00 ART', () => {
  const result = clampToBusinessHours(new Date('2026-06-28T15:00:00.000Z'));
  assert.equal(result.toISOString(), '2026-06-29T12:00:00.000Z');
});

test('fuera de horario un sábado pasa al lunes', () => {
  const result = clampToBusinessHours(new Date('2026-06-27T17:30:00.000Z'));
  assert.equal(result.toISOString(), '2026-06-29T12:00:00.000Z');
});

test('antes de abrir se ajusta a la apertura del mismo día', () => {
  const result = clampToBusinessHours(new Date('2026-06-25T09:00:00.000Z'));
  assert.equal(result.toISOString(), '2026-06-25T11:15:00.000Z');
});

test('el segundo texto declara que es el último contacto', () => {
  assert.match(followupText(2), /último mensaje/i);
});
