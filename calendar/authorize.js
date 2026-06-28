/**
 * Script de autorización de Google OAuth2
 * Ejecutar UNA sola vez: node calendar/authorize.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, '..', 'credentials.json');
const TOKEN_PATH        = process.env.GOOGLE_TOKEN_PATH       || path.join(__dirname, '..', 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`\n❌ No se encontró ${CREDENTIALS_PATH}`);
    console.error('   Descargá las credenciales OAuth2 desde Google Cloud Console y guardálas como credentials.json\n');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    console.log('✅ Ya existe token.json. Google Calendar ya está autenticado.');
    console.log('   Si querés reautenticar, eliminá token.json y volvé a correr este script.');
    return;
  }

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

  console.log('\n📋 PASOS PARA AUTORIZAR GOOGLE CALENDAR:');
  console.log('─'.repeat(60));
  console.log('1. Abrí esta URL en tu navegador:');
  console.log('\n   ' + authUrl + '\n');
  console.log('2. Iniciá sesión con tu cuenta de Google');
  console.log('3. Aceptá los permisos solicitados');
  console.log('4. Copiá el código que aparece en pantalla');
  console.log('─'.repeat(60));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nPegá el código de autorización aquí: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('\n✅ ¡Autenticación exitosa! Se guardó token.json');
      console.log('   Google Calendar está listo para usar.\n');
    } catch (err) {
      console.error('\n❌ Error al obtener el token:', err.message);
    }
  });
}

main();
