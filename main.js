// Jeff — asistente de horarios por WhatsApp
// Arquitectura por capas:
//   L0 base canónica -> L1 cambios de clase -> L2 cambios personales -> L3 eventos
// Cada persona ve su horario resuelto sin afectar al de los demás.
const { downloadMediaMessage, normalizeMessageContent, getContentType, jidNormalizedUser } = require('@whiskeysockets/baileys');
const cfg = require('./src/config');
const log = require('./src/log');
const store = require('./src/store');
const H = require('./src/horario');
const overrides = require('./src/overrides');
const eventos = require('./src/eventos');
const usuarios = require('./src/usuarios');
const agenda = require('./src/agenda');
const agendaCmd = require('./src/agenda-cmd');
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

// En un grupo Jeff calla salvo que vaya con él: que lo mencionen con @, que
// respondan a un mensaje suyo o que lo llamen por su nombre. Se cuenta "jef"
// y "jeff" como palabra suelta, no cualquier "jefe" o "jefa" de la charla.
const NOMBRE = /(^|[^\p{L}\p{N}])jef{1,2}(?![\p{L}\p{N}])/iu;

// Quien acaba de recibir una pregunta de Jeff en un grupo ("¿solo para ti o
// para toda la clase?") puede contestar sin volver a nombrarlo, pero solo en
// ese grupo: autor -> grupo.
const esperandoEnGrupo = new Map();

const esLid = j => typeof j === 'string' && j.endsWith('@lid');

// Los usuarios de Jeff son JIDs @lid. En un grupo el autor puede llegar con su
// número y el lid en participantAlt (o al revés); se prefiere el lid para que
// sea la misma persona, con el mismo horario y agenda, que por privado.
function autorDe(key) {
  const opciones = [key.participant, key.participantAlt].filter(Boolean);
  return jidNormalizedUser(opciones.find(esLid) || opciones[0] || '');
}

function textoDe(m) {
  return m.conversation || m.extendedTextMessage?.text
      || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}

// Quita del principio "@Jeff", "jeff,", "oye jef:" y las menciones al propio
// bot que haya en medio, para que lo que queda se entienda igual que por privado.
function sinLlamada(texto, propios) {
  const numeros = [...propios].map(j => j.split('@')[0]);
  let t = texto.replace(/@(\d+)/g, (todo, n) => (numeros.includes(n) ? '' : todo));
  t = t.replace(/^[\s,.:;!?¿¡]*(?:(?:oye|hey|ey|eh|hola)[\s,]+)?jef{1,2}(?![\p{L}\p{N}])[\s,.:;!?¿¡]*/iu, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

async function onMensaje(msg, conn) {
  if (!msg.message || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  // Los mensajes temporales y de una sola vez vienen envueltos; se desenvuelven
  // para leer igual el texto que el audio.
  const m = normalizeMessageContent(msg.message);
  if (!m) return;

  const esGrupo = jid.endsWith('@g.us');
  // Quién habla (de quién es el horario y la agenda) y dónde se contesta.
  const autor = esGrupo ? autorDe(msg.key) : jid;
  if (!autor) return;
  const opcionesEnvio = esGrupo ? { quoted: msg } : {};
  const responder = texto => conn.enviar(jid, { text: texto }, opcionesEnvio);

  let citado = null;
  if (esGrupo) {
    const propios = conn.propios();
    const tipo = getContentType(m);
    const ctx = (tipo && m[tipo]?.contextInfo) || {};
    const mencionado = (ctx.mentionedJid || []).some(j => propios.has(jidNormalizedUser(j)));
    const leResponden = !!ctx.participant && propios.has(jidNormalizedUser(ctx.participant));
    const nombrado = NOMBRE.test(textoDe(m));
    const pendiente = esperandoEnGrupo.get(autor) === jid
      && (comandos.pendientes.has(autor) || agendaCmd.hayEspera(autor));
    if (!mencionado && !leResponden && !nombrado && !pendiente) return;
    // "@Jeff ¿esto es verdad?" citando el mensaje de otro: si no queda
    // pregunta propia, la pregunta es lo citado.
    if (ctx.quotedMessage && !leResponden) {
      citado = textoDe(normalizeMessageContent(ctx.quotedMessage) || {}) || null;
    }
    // Solo se apunta como usuario a quien le escribe por privado: alguien que
    // lo nombra de pasada en un grupo no tiene por qué recibir las difusiones.
    if (usuarios.get(autor)) usuarios.ver(autor, msg.pushName);
  } else {
    usuarios.ver(jid, msg.pushName);
  }
  const quien = usuarios.get(autor) ? usuarios.nombreDe(autor) : (msg.pushName || usuarios.nombreDe(autor));
  const donde = esGrupo ? ' en un grupo' : '';

  // ---- media no soportada ----
  if (m.imageMessage || m.videoMessage || m.documentMessage) {
    await responder('Solo entiendo texto y audios.');
    return;
  }

  // ---- audio ----
  let texto = null, esAudio = false;
  const audio = m.audioMessage || m.pttMessage;
  if (audio) {
    esAudio = true;
    log.info(`audio de ${quien}${donde} (${audio.seconds}s)`);
    await conn.escribiendo(jid);
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      texto = await ia.transcribir(buf, audio.mimetype);
    } catch (e) { log.error(`descarga de audio: ${e.message}`); }
    if (!texto) { await responder('No he entendido el audio. ¿Me lo escribes?'); return; }
    if (cfg.LOG_MENSAJES) log.info(`   transcrito: "${texto}"`);
  } else {
    texto = textoDe(m);
  }
  if (esGrupo) texto = sinLlamada(texto || '', conn.propios()) || citado || 'hola';
  if (!texto || !texto.trim()) return;

  // Lo que cada persona le dice a Jeff es suyo: no se escribe en el registro,
  // que puede leer cualquiera con acceso al servidor. LOG_MENSAJES=1 lo
  // activa solo para depurar.
  log.info(cfg.LOG_MENSAJES ? `${quien}${donde}: ${texto.slice(0, 80)}` : `mensaje de ${quien}${donde}${esAudio ? ' (audio)' : ''}`);
  await conn.escribiendo(jid);

  let r;
  try {
    r = await comandos.manejar(autor, texto, { esAudio, sesion: getSesion(autor) });
  } catch (e) {
    log.error(`manejar: ${e.stack}`);
    r = { texto: 'Algo ha fallado. Prueba otra vez.', noGuardar: true };
  }
  if (!r || !r.texto) return;

  await responder(r.texto);
  if (esGrupo) {
    if (comandos.pendientes.has(autor) || agendaCmd.hayEspera(autor)) esperandoEnGrupo.set(autor, jid);
    else esperandoEnGrupo.delete(autor);
  }
  // Un aviso de error NO entra en el historial: el modelo recibe las últimas
  // respuestas como suyas, y si ve un "algo ha fallado" lo repite creyendo que
  // es lo que toca decir. Un fallo puntual se convertía así en permanente.
  if (r.olvidarConversacion) {
    sesiones.delete(autor);
    guardarSesiones();
    ia.olvidar(autor);
  } else if (!r.noGuardar) anotar(autor, texto, r.texto);
  log.info(`respondido a ${quien}${donde}`);

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
  ia.cargarPersonalidad();         // data/personalidad.md define el tono
  const memoria = cargarSesiones();
  overrides.cargar();
  eventos.cargar();
  usuarios.cargar();
  agenda.cargar();
  difusion.cargar();
  usuarios.importarDesdeMemoria(memoria);   // no perder a quien ya hablaba con el bot

  const hoy = H.hoyISO();
  const sn = H.semanaDe(hoy);
  log.info(`horario: ${H.BASE.length} clases (${H.origenHorario})`);
  log.info(`modo de IA: ${cfg.MODO_IA} · repaso de tareas ${cfg.HORA_REPASO == null ? 'desactivado' : 'a las ' + cfg.HORA_REPASO + ':00'}`);
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

  // Recordatorios, temporizadores y repaso de la noche
  setInterval(() => {
    agendaCmd.tick(conn).catch(e => log.error(`avisos: ${e.message}`));
  }, 10000);
  setInterval(() => agenda.purgar(), 3600000);

  // Devuelve el modelo preferente en cuanto vuelva a estar sano
  setInterval(() => {
    ia.probarApartados().catch(e => log.warn(`sondeo de modelos: ${e.message}`));
  }, cfg.SONDEO_MODELO_MS);

  // Latido en disco que lee el healthcheck de Docker
  const fs = require('fs');
  setInterval(() => {
    if (conn.conectado) {
      try { fs.writeFileSync(`${cfg.DATA_DIR}/.alive`, String(Date.now())); } catch (_) {}
    }
  }, 30000);

  setInterval(() => {
    const e = conn.estado();
    const m = ia.estadoIA();
    log.info(`latido · ${e.conectado ? 'conectado' : 'CAÍDO'} · modelo ${m.proveedor || 'ninguno'} · usuarios ${usuarios.todos().length} · ajustes ${overrides.todos().filter(o => o.activo).length} · eventos ${eventos.todos().length} · con agenda ${agenda.todos().length}`);
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
