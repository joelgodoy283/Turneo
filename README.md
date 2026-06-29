# Turneo — Bot de turnos por WhatsApp + Dashboard

**Turneo** es un asistente de WhatsApp con IA para que cualquier negocio que trabaje con **turnos** (talleres, peluquerías, consultorios, estudios, etc.) atienda a sus clientes y gestione la agenda desde WhatsApp. El sistema está
pensado **WhatsApp‑first**: el día a día del negocio se opera desde WhatsApp, y el
dashboard web queda como panel de **configuración avanzada, revisión y control**,
no como herramienta obligatoria.

El bot cumple **dos roles**:

1. **Asistente para clientes finales** — responde consultas, informa servicios,
   toma/confirma/reprograma/cancela turnos, pide reseñas y deriva a un humano.
2. **Asistente interno del dueño/encargado** — desde números autorizados, gestiona
   el negocio hablando en lenguaje natural por WhatsApp.

---

## Arranque rápido

```bash
npm install
cp .env.example .env   # completar claves
npm start              # o: npm run dev
```

Abrir `http://localhost:3000` (contraseña en `DASHBOARD_PASSWORD`) y escanear el QR

## Memoria privada y seguimientos (Supabase)

1. Ejecutar `supabase/migrations/20260628_customer_memory_and_followups.sql` en el SQL Editor.
2. Configurar `SUPABASE_URL` y `SUPABASE_SECRET_KEY` en el servidor/VPS.
3. Activar “Seguimiento si no responde” desde Turnos en el dashboard.

La información de servicios realizados, condición del vehículo y notas se guarda como
`internal_only`: solo el asistente del dueño puede consultarla. El bot de clientes recibe
una vista separada que no contiene esos antecedentes. Cada consulta puede generar como
máximo dos seguimientos; una respuesta, pausa, bloqueo o turno creado cancela la secuencia.
para vincular WhatsApp.

---

## Roles y seguridad (admin vs cliente)

La separación entre dueño y cliente es estricta: **un cliente nunca llega a la lógica
interna**. El ruteo se decide en [whatsapp/baileys.js](whatsapp/baileys.js):

- Si el número entrante es **admin** → lo atiende el **asistente interno**
  ([ai/assistant.js](ai/assistant.js)) con herramientas de gestión.
- Si no → lo atiende el **bot de clientes** ([ai/openrouter.js](ai/openrouter.js)).

### Configurar números admin

Los números autorizados se toman, unificados, de tres fuentes
([whatsapp/admins.js](whatsapp/admins.js)):

1. `ADMIN_WHATSAPP_NUMBERS` en `.env` (lista por comas).
2. Config `admin_numbers` (editable desde el dashboard).
3. Config `owner_number` (dueño/encargado principal; también recibe los avisos automáticos).

Se comparan **solo por dígitos**, así que da igual el formato (`+54 9 341 …`, espacios,
guiones o el JID completo).

---

## Comandos del dueño por WhatsApp (lenguaje natural)

No hay sintaxis rígida: el dueño escribe normalmente y el asistente usa la herramienta
correcta. Ejemplos y la herramienta que disparan:

| Lo que escribe el dueño | Herramienta |
|---|---|
| "ver turnos de hoy / mañana / esta semana" | `list_appointments` |
| "qué horarios libres tengo mañana" / "cuándo tengo lugar" | `check_free_slots` |
| "buscá el turno de Pedro / del Gol blanco / tal patente" | `search_appointments` |
| "agendá a Juan para alineación mañana a las 10" | `create_appointment_manual` |
| "cancelá el turno de Pedro" | `cancel_appointment` |
| "reprogramá el turno de María para el viernes a las 15" | `reschedule_appointment` |
| "bloqueá el lunes" / "bloqueá el lunes de 14 a 16" / "estoy de vacaciones del X al Y" | `block_schedule` |
| "desbloqueá el lunes" | `unblock_schedule` |
| "qué días tengo bloqueados" | `list_blocks` |
| "cuántos turnos tengo esta semana" / "qué servicios se piden más" | `business_metrics` |
| "pasame el resumen del día" | `day_summary` |
| "poné el bot en modo manual para este cliente" | `set_contact_bot_mode` (manual) |
| "reactivá el bot para tal cliente" | `set_contact_bot_mode` (bot) |
| "cambiá la capacidad a 4 turnos por día" / "ofrecé 8, 8:30 y 9" | `set_business_hours` |
| "marcá que vino Fulano" / "el auto está para las 16" / "terminé el auto de X" | `set_attendance` / `set_estimated_finish` / `mark_finished` |

> Las acciones que afectan a un cliente real o cambian la configuración se
> **confirman con el dueño** antes de ejecutarse.

### Bloqueos de agenda

Los bloqueos viven en la tabla `blocked_slots` y la disponibilidad los respeta
automáticamente ([calendar/local-calendar.js](calendar/local-calendar.js)):

- **Día completo** (`time` vacío): el bot lo trata como cerrado (feriados, vacaciones).
- **Horario puntual** (`HH:MM`): se saca de los cupos ofrecidos de ese día.

### Modo manual / modo bot por contacto

`set_contact_bot_mode` reutiliza la pausa por contacto: en **manual** el bot deja de
responderle a ese cliente (lo atiende el dueño); en **bot** vuelve a responder. El
cliente se identifica por teléfono o por nombre (si el nombre coincide con un único
turno; si hay varios, el asistente pide desambiguar).

---

## Resúmenes y avisos automáticos al dueño

Programados con `node-cron` en hora de Argentina ([server.js](server.js)):

- **Resumen matutino (08:00)** — turnos de hoy + actividad de ayer
  ([jobs/morning-summary.js](jobs/morning-summary.js)).
- **Resumen de cierre (19:00)** ([jobs/daily-summary.js](jobs/daily-summary.js)).
- **Recordatorio de turno al cliente (11:00)** ([jobs/reminders.js](jobs/reminders.js)).
- **Ciclo de servicio (10:00 + poller)** — check‑in, aviso de retiro al cliente
  ([jobs/service-cycle.js](jobs/service-cycle.js)).
- **Pedido de reseña post‑servicio** ([jobs/reviews.js](jobs/reviews.js)).

Cada uno se puede prender/apagar con su config (`morning_summary_enabled`, etc.).
El dueño también puede pedir el resumen on‑demand ("pasame el resumen del día").

---

## Audios e imágenes por WhatsApp

Tanto clientes como el dueño pueden mandar **audios** e **imágenes**; el bot los
entiende y, además, guarda en el historial una **descripción/transcripción útil** en
lugar de `[Imagen]` o `[Nota de voz]`.

- **Recepción y descarga**: [whatsapp/baileys.js](whatsapp/baileys.js) (`extractContent`).
- **Descripción/transcripción para el historial**: `describeMedia` en
  [ai/openrouter.js](ai/openrouter.js) (audio → transcripción 🎤, imagen → descripción 🖼️).
  Se puede desactivar con la config `media_transcribe_enabled=false`.
- **Razonamiento multimodal**: el medio se manda a la IA en la llamada del momento
  (`withCurrentMedia`), no se persiste el binario.

### Formatos soportados

| Tipo | Soporte | Notas |
|---|---|---|
| **Texto** | ✅ | — |
| **Imagen** (jpg/png/webp) | ✅ visión | con o sin epígrafe |
| **Audio / nota de voz** (ogg/opus, mp3, m4a, wav, aac, flac) | ✅ transcripción + comprensión | — |
| **Video** | ❌ | si trae epígrafe se usa el texto; si no, se pide foto/audio/texto |
| **Documento / sticker / ubicación / contacto** | ❌ | se responde con una guía |

**Requisito de modelo:** se usa `OPENROUTER_MODEL` (por defecto
`google/gemini-2.5-flash`, que soporta **visión y audio**). Si se cambia a un modelo
**sin audio**, conviene poner `media_transcribe_enabled=false` y/o usar un modelo de
transcripción aparte; las notas de voz dejarían de entenderse pero el resto sigue igual.

**Límites y seguridad de archivos:**
- Tamaño máximo ~9 MB reales (`MAX_MEDIA_BYTES`); por encima se avisa "demasiado pesado".
- Se valida el tipo antes de descargar (solo `image/*` y `audio/*`).
- Errores claros y diferenciados: tipo no permitido, archivo vacío, descarga fallida, muy grande.

---

## Dashboard web (complemento)

El panel sirve para **configuración avanzada y control**: prompts del bot y del
asistente, servicios y precios, capacidad/horarios/días laborables, números admin,
estado de WhatsApp/Instagram, historial de chats y excepciones. **La operación diaria
no lo requiere** — se hace desde WhatsApp.

El texto de **Configurar IA** es el prompt oficial y tiene máxima prioridad. Los
bloques automáticos (fecha, servicios, precios, perfil seguro, reseñas e historial)
solo agregan contexto y no pueden contradecirlo. El prompt genérico del código se usa
únicamente al crear una base nueva que todavía no tenga `ai_prompt`.

---

## Estructura del proyecto

```
ai/           assistant.js (dueño) · openrouter.js (clientes) · tools.js (tools cliente)
calendar/     index.js (fachada) · local-calendar.js (cupos/bloqueos) · google-calendar.js
database/     db.js (SQLite vía sql.js)
jobs/         resúmenes, recordatorios, ciclo de servicio, reseñas (node-cron)
whatsapp/     baileys.js (conexión + ruteo) · admins.js (autorización) · notify.js (avisos)
routes/ views/ public/   dashboard web
server.js     arranque
```

---

## Roadmap (WhatsApp‑first)

**Hecho (prioridad 1–7):** ver turnos hoy/mañana/semana · crear turno manual ·
cancelar · reprogramar · ver horarios libres · resumen diario · modo manual/bot por
contacto · bloqueos de agenda · búsqueda de turnos · métricas básicas · cambio simple
de horarios · audios/imágenes con transcripción.

**Próximo:**
- Métricas avanzadas sobre conversaciones: "servicios más consultados" y "consultas no
  convertidas" analizando los mensajes (hoy `business_metrics` mide sobre turnos).
- Avisos proactivos de cancelaciones/reprogramaciones al dueño en el momento (hoy se
  ven en los resúmenes).
- Confirmación de turnos por el dueño en lote ("confirmá todos los de mañana").
- Búsqueda por patente como campo propio (hoy va dentro de `car_info`).
- Soporte opcional de video (si se decide) vía extracción de cuadros.
- Panel de auditoría de acciones hechas por WhatsApp.
