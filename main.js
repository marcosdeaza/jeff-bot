// Jeff — asistente de horarios por WhatsApp
// Arquitectura por capas:
//   L0 base canónica -> L1 cambios de clase -> L2 cambios personales -> L3 eventos
// Cada persona ve su horario resuelto sin afectar al de los demás.
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const cfg = require('./src/config');
const log = require('./src/log');
const store = require('./src/store');
const H = require('./src/horario');
const overrides = require('./src/overrides');
const eventos = require('./src/eventos');
const usuarios = require('./src/usuarios');
const difusion = require('./src/difusion');
const comandos = require('./src/comandos');
const ia = require('./src/ia');
const { Conexion } = require('./src/wa');

const sesiones = new Map();

function cargarSesiones() {
  const d = store.leer(cfg.F.memoria, {});
  for (const [jid, s] of Object.entries(d)) sesiones.set(jid, s);
  log.info(`sesiones cargadas: ${sesiones.size}`);
  return d;
}
const guardarSesiones = () => store.escribir(cfg.F.memoria, Object.fromEntries(sesiones));

function getSesion(jid) {
  if (!sesiones.has(jid)) sesiones.set(jid, { historial: [] });
  return sesiones.get(jid);
}

function anotar(jid, pregunta, respuesta) {
  const s = getSesion(jid);
  const t = Date.now();
  s.historial = (s.historial || []).filter(h => t - h.ts < 86400000);
  s.historial.push({ rol: 'user', texto: pregunta, ts: t });
  s.historial.push({ rol: 'assistant', texto: respuesta, ts: t });
  if (s.historial.length > cfg.MAX_HISTORIAL * 2) s.historial = s.historial.slice(-cfg.MAX_HISTORIAL * 2);
  guardarSesiones();
}

async function onMensaje(msg, conn) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  usuarios.ver(jid, msg.pushName);
  const quien = usuarios.nombreDe(jid);

  // ---- media no soportada ----
  if (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage) {
    await conn.enviar(jid, { text: 'Solo entiendo texto y audios.' });
    return;
  }

  // ---- audio ----
  let texto = null, esAudio = false;
  const audio = msg.message.audioMessage || msg.message.pttMessage;
  if (audio) {
    esAudio = true;
    log.info(`audio de ${quien} (${audio.seconds}s)`);
    await conn.escribiendo(jid);
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      texto = await ia.transcribir(buf, audio.mimetype);
    } catch (e) { log.error(`descarga de audio: ${e.message}`); }
    if (!texto) { await conn.enviar(jid, { text: 'No he entendido el audio. ¿Me lo escribes?' }); return; }
    log.info(`   transcrito: "${texto}"`);
  } else {
    texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  }
  if (!texto || !texto.trim()) return;

  log.info(`${quien}: ${texto.slice(0, 80)}`);
  await conn.escribiendo(jid);

  let r;
  try {
    r = await comandos.manejar(jid, texto, { esAudio, sesion: getSesion(jid) });
  } catch (e) {
    log.error(`manejar: ${e.stack}`);
    r = { texto: 'Algo ha fallado. Prueba otra vez.' };
  }
  if (!r || !r.texto) return;

  await conn.enviar(jid, { text: r.texto });
  anotar(jid, texto, r.texto);
  log.info(`respondido a ${quien}`);

  // Un cambio global avisa al resto de la clase
  if (r.difusion) {
    const destinos = usuarios.activos().map(u => u.jid).filter(j => !r.difusion.excepto.includes(j));
    if (destinos.length) {
      difusion.encolar({ texto: r.difusion.texto, destinatarios: destinos, etiqueta: 'cambio-global' });
    }
  }
}

async function main() {
  console.log('');
  log.info('Jeff arrancando…');
  store.asegurarDir(cfg.DATA_DIR);

  H.cargarPersonalizado(log);      // data/horario.json manda sobre el incorporado
  const memoria = cargarSesiones();
  overrides.cargar();
  eventos.cargar();
  usuarios.cargar();
  difusion.cargar();
  usuarios.importarDesdeMemoria(memoria);   // no perder a quien ya hablaba con el bot

  const hoy = H.hoyISO();
  const sn = H.semanaDe(hoy);
  log.info(`horario: ${H.BASE.length} clases (${H.origenHorario})`);
  log.info(`hoy ${hoy}, ${sn ? `semana ${sn.semana} del S${sn.semestre}` : 'fuera de período lectivo'}`);

  const conn = new Conexion({ onMensaje });
  await conn.arrancar();

  // Vacía la cola de difusión cuando hay conexión
  setInterval(() => {
    difusion.sincronizar();                      // recoge anuncios encolados desde fuera
    overrides.sincronizar();                     // y cambios aplicados desde administración
    if (conn.conectado && difusion.pendientes().length) {
      difusion.procesar(conn).catch(e => log.error(`difusión: ${e.message}`));
    }
  }, 15000);

  // Latido en disco que lee el healthcheck de Docker
  const fs = require('fs');
  setInterval(() => {
    if (conn.conectado) {
      try { fs.writeFileSync(`${cfg.DATA_DIR}/.alive`, String(Date.now())); } catch (_) {}
    }
  }, 30000);

  setInterval(() => {
    const e = conn.estado();
    log.info(`latido · ${e.conectado ? 'conectado' : 'CAÍDO'} · usuarios ${usuarios.todos().length} · ajustes ${overrides.todos().filter(o => o.activo).length} · eventos ${eventos.todos().length}`);
  }, 3600000);

  const salir = async sig => {
    log.warn(`recibido ${sig}: guardando y cerrando`);
    try { await guardarSesiones(); await overrides.guardar(); await eventos.guardar(); await usuarios.guardar(); await difusion.guardar(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', () => salir('SIGTERM'));
  process.on('SIGINT', () => salir('SIGINT'));
  process.on('unhandledRejection', e => log.error(`promesa sin capturar: ${e?.message || e}`));
  process.on('uncaughtException', e => { log.error(`excepción no capturada: ${e.stack}`); process.exit(1); });
}

main().catch(e => { log.error(`fatal: ${e.stack}`); process.exit(1); });
