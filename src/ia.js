const crypto = require('crypto');
const fs = require('fs');
const cfg = require('./config');
const store = require('./store');
const log = require('./log');
const H = require('./horario');
const eventos = require('./eventos');
const formato = require('./formato');

// Caché POR USUARIO. Antes era global por texto: si A preguntaba "¿qué tengo
// hoy?" y B lo mismo en 2 min, B recibía el horario de A. Con horarios
// personalizados eso sería directamente mentira.
const cache = new Map();
const TTL = 90 * 1000;

// Personalidad editable: data/personalidad.md se inyecta en el prompt. Permite
// cambiar el tono sin tocar código ni reconstruir la imagen.
const PERSONALIDAD_POR_DEFECTO = `Hablas claro y vas al grano, con naturalidad.
Puedes tener un punto seco y con humor, pero nunca a costa de la claridad.
Tuteas. No te disculpas ni das rodeos. Si algo no lo sabes, lo dices y ya.`;

let personalidad = PERSONALIDAD_POR_DEFECTO;

// CORTACIRCUITOS. Si el proveedor deja de responder, seguir llamándolo hace que
// cada mensaje espere el timeout entero y el usuario vea "escribiendo" sin
// respuesta. Tras varios fallos seguidos se deja de llamar un rato y se
// responde con lo que ya calculó el resolver, que es instantáneo.
const FALLOS_PARA_ABRIR = 2;

// Los modelos se apartan de uno en uno. Si el principal deja de responder se
// pasa al suplente en vez de renunciar al modelo entero: así una avería de un
// modelo concreto no degrada la conversación.
const MODELOS = [...new Set([cfg.MODELO, cfg.MODELO_RESERVA].filter(Boolean))];
const apartados = new Map();

function modeloEnUso() {
  const ahora = Date.now();
  for (const m of MODELOS) {
    const hasta = apartados.get(m) || 0;
    if (hasta <= ahora) {
      if (hasta) { apartados.delete(m); log.info(`vuelvo a probar ${m}`); }
      return m;
    }
  }
  return null;
}

// Sondeo baratísimo: un token. Sirve para saber si un modelo apartado ya
// responde, sin esperar a que lo descubra un usuario esperando en pantalla.
async function sondear(m) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const ok = await Promise.race([
      (async () => {
        const res = await fetch(cfg.DEEPSEEK_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.DEEPSEEK_KEY}` },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
          signal: ctrl.signal,
        });
        await res.arrayBuffer();        // vacía el cuerpo para liberar la conexión
        return res.ok;
      })(),
      new Promise((_, rech) => setTimeout(() => rech(new Error('timeout')), 8500)),
    ]);
    clearTimeout(to);
    return ok === true;
  } catch (e) {
    clearTimeout(to);
    try { ctrl.abort(); } catch (_) {}
    return false;
  }
}

// Recupera el modelo preferente en cuanto vuelva, sin esperar a que expire la
// pausa ni hacer que un usuario pague el plazo para descubrirlo.
async function probarApartados() {
  const enUso = modeloEnUso();
  for (const m of MODELOS) {
    if (m === enUso) return;            // ya se usa el mejor disponible
    if (!apartados.has(m)) continue;
    if (await sondear(m)) {
      apartados.delete(m);
      log.info(`${m} vuelve a responder; lo recupero`);
      return;
    }
  }
}

function apartarModelo(m, motivo) {
  apartados.set(m, Date.now() + cfg.PAUSA_MODELO_MS);
  const siguiente = modeloEnUso();
  log.warn(`${m} apartado ${cfg.PAUSA_MODELO_MS / 60000} min (${motivo})` +
    (siguiente ? `; paso a ${siguiente}` : '; no queda ningún modelo, respondo en local'));
}
const PAUSA_MS = 3 * 60 * 1000;
let fallosSeguidos = 0;
let pausadoHasta = 0;

function disponible() {
  if (Date.now() < pausadoHasta) return false;
  if (pausadoHasta) { log.info('reintentando el modelo tras la pausa'); pausadoHasta = 0; }
  return true;
}

function apuntarFallo(motivo) {
  fallosSeguidos++;
  if (fallosSeguidos >= FALLOS_PARA_ABRIR && !pausadoHasta) {
    pausadoHasta = Date.now() + PAUSA_MS;
    log.warn(`modelo pausado ${PAUSA_MS / 60000} min tras ${fallosSeguidos} fallos (${motivo}); se responde en local`);
  }
}

function apuntarExito() {
  if (fallosSeguidos) log.info('modelo recuperado');
  fallosSeguidos = 0;
  pausadoHasta = 0;
}

function estadoIA() {
  return {
    disponible: Date.now() >= pausadoHasta,
    modelo: modeloEnUso(),
    apartados: [...apartados.entries()]
      .filter(([, h]) => h > Date.now())
      .map(([m, h]) => `${m}:${Math.round((h - Date.now()) / 1000)}s`),
    fallosSeguidos,
    pausadoSegundos: pausadoHasta ? Math.max(0, Math.round((pausadoHasta - Date.now()) / 1000)) : 0,
  };
}

function cargarPersonalidad() {
  try {
    if (fs.existsSync(cfg.F.personalidad)) {
      const t = fs.readFileSync(cfg.F.personalidad, 'utf8').trim();
      if (t) { personalidad = t; log.info(`personalidad cargada de data/personalidad.md (${t.length} caracteres)`); return true; }
    } else {
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(cfg.F.personalidad, PERSONALIDAD_POR_DEFECTO + '\n');
      log.info('creado data/personalidad.md: edítalo para cambiar el tono');
    }
  } catch (e) { log.warn(`personalidad: ${e.message}`); }
  return false;
}

// Tarifas deepseek-flash por millón de tokens (peak; fuera de pico es la mitad).
const TARIFA = { hit: 0.006, miss: 0.30, salida: 1.20 };

function apuntarGasto(u) {
  if (!u) return;
  const hit = u.prompt_cache_hit_tokens || 0;
  const miss = u.prompt_cache_miss_tokens || (u.prompt_tokens || 0) - hit;
  const out = u.completion_tokens || 0;
  const coste = (hit * TARIFA.hit + miss * TARIFA.miss + out * TARIFA.salida) / 1e6;
  try {
    const f = `${cfg.DATA_DIR}/coste.json`;
    const d0 = { llamadas: 0, hit: 0, miss: 0, salida: 0, usd: 0, desde: Date.now() };
    const a = Object.assign({}, d0, store.leer(f, d0));   // tolera un fichero incompleto
    a.llamadas++; a.hit += hit; a.miss += miss; a.salida += out; a.usd += coste;
    store.escribir(f, a);
    log.info(`tokens: ${hit} cache-hit + ${miss} nuevos + ${out} salida = $${coste.toFixed(6)} (acumulado $${a.usd.toFixed(4)} en ${a.llamadas} llamadas)`);
  } catch (e) { log.warn(`no pude apuntar el gasto: ${e.message}`); }
  return coste;
}

function clave(jid, texto, huella) {
  return crypto.createHash('sha1').update(`${jid}|${huella}|${texto.toLowerCase().trim()}`).digest('hex');
}

// Serializa el horario YA RESUELTO del usuario: el LLM solo ve lo que le toca.
function contextoHorario(jid, iso) {
  const { sem, clases } = H.resolverSemestre(jid, iso);
  if (!sem) return { texto: 'Fuera de período lectivo.', huella: 'na' };
  const porDia = {};
  for (const c of clases) (porDia[c.dia] ||= []).push(c);
  let out = `SEMESTRE ${sem.n} (${sem.inicio} a ${sem.fin}) — HORARIO EFECTIVO DE ESTE ESTUDIANTE:\n`;
  for (let d = 1; d <= 5; d++) {
    const cs = porDia[d] || [];
    out += `\n${H.DIAS[d].toUpperCase()}: ${cs.length ? '' : 'sin clases'}\n`;
    for (const c of cs) {
      out += `  ${c.inicio}-${c.fin} | ${c.asignatura} | ${c.edificio} (${c.aula})`;
      if (c.cancelada) out += ' | ANULADA';
      if (c._cambiado) out += ` | modificado(${c._scope})`;
      out += '\n';
    }
  }
  return { texto: out, huella: crypto.createHash('md5').update(out).digest('hex').slice(0, 8) };
}

function contextoCalendario(iso) {
  const sn = H.semanaDe(iso);
  const est = H.estadoDelDia(iso);
  const prox = Object.entries(H.calendario.festivos).filter(([f]) => f >= iso).slice(0, 3)
    .map(([f, n]) => `${f}: ${n}`).join(' · ');
  return `Hoy es ${iso} (${est.nombre}${est.tipo !== 'lectivo' ? ', ' + est.tipo : ''}).`
    + (sn ? ` Semana ${sn.semana} del semestre ${sn.semestre}.` : '')
    + (prox ? `\nPróximos festivos: ${prox}` : '');
}

async function preguntar(jid, texto, opts = {}) {
  // Con el cortacircuitos abierto ni se intenta: responder al instante con lo
  // que ya calculó el resolver es mejor que hacer esperar para acabar igual.
  if (!disponible()) return null;

  // Se prueba el modelo que esté en pie. Si falla queda apartado y se intenta
  // el suplente una sola vez: un usuario paga el plazo, los demás ya entran
  // directos al que funciona.
  const primero = modeloEnUso();
  if (!primero) { apuntarFallo('sin modelos disponibles'); return null; }

  const r = await intentarPreguntar(jid, texto, { ...opts, modelo: primero });
  if (typeof r === 'string' && r) return r;

  const segundo = modeloEnUso();
  if (segundo && segundo !== primero) {
    const r2 = await intentarPreguntar(jid, texto, { ...opts, modelo: segundo });
    if (typeof r2 === 'string' && r2) return r2;
  }
  apuntarFallo('ningún modelo respondió');
  return null;
}

async function intentarPreguntar(jid, texto, { historial = [], esAudio = false, datos = null, modelo = null } = {}) {
  const iso = H.hoyISO();
  const hora = H.horaAhora();
  const { texto: hor, huella } = contextoHorario(jid, iso);

  const usado = modelo || cfg.MODELO;
  // Los modelos de razonamiento gastan la salida en pensar antes de contestar:
  // medidos 350-850 tokens y 4-10 s para leer un horario. Necesitan más techo y
  // más plazo, o se quedan sin presupuesto a mitad y responden cualquier cosa.
  const razona = /pro|reason|think/i.test(usado);
  const tope = razona ? 1400 : 400;
  const plazo = razona ? cfg.IA_TIMEOUT_MS * 2 : cfg.IA_TIMEOUT_MS;
  const k = clave(jid, texto, huella + (datos ? '|d' : '') + '|' + usado);
  if (!esAudio && cache.has(k)) {
    const c = cache.get(k);
    if (Date.now() - c.t < TTL) { log.debug('respuesta desde caché'); return c.r; }
    cache.delete(k);
  }

  const evs = eventos.paraUsuario(jid);
  const listaEv = evs.length
    ? evs.map(e => `- ${e.texto}${e.fecha ? ` (${e.fecha})` : ''} [${e.scope === 'global' ? 'toda la clase' : 'solo tuyo'}]`).join('\n')
    : 'No hay ninguno registrado.';

  // ORDEN IMPORTANTE PARA EL COSTE: DeepSeek cachea por prefijo común, y el
  // descuento por acierto de caché es ~50x. Por eso todo lo estable (reglas,
  // horario, eventos) va primero y lo volátil (fecha y hora, que cambia cada
  // minuto) va al FINAL: así el prefijo largo se reutiliza entre llamadas y
  // entre usuarios con el mismo horario.
  const system = `Eres Jeff, el asistente de horarios de un estudiante de ${H.calendario.titulacion} (${H.calendario.universidad}).

FORMATO OBLIGATORIO (WhatsApp). Cópialo EXACTAMENTE:

10:30 *Álgebra*
VG25

14:30 *Análisis de circuitos*
VG04

CÓMO ERES
${personalidad}

Reglas estrictas de formato (mandan sobre lo anterior):
- Negrita con UN solo asterisco: *así*. Nunca dos.
- PROHIBIDO usar emojis, flechas (←, →), viñetas (·, -, •) y títulos en mayúsculas.
- Solo la hora de INICIO. Nunca el rango. Nunca el aula (M11, M21): solo el edificio.
- Usa los nombres CORTOS de la tabla de abajo, nunca los largos.
- Línea en blanco entre clase y clase.
- Sin saludos, sin introducciones, sin resúmenes ni recuentos al final.
- Si la respuesta no es una lista de clases, responde en 2 frases como mucho.

NOMBRES CORTOS (usa siempre el de la derecha):
Programación con estructuras lineales -> Prog. estructuras lineales
Introducción a la ingeniería del software -> Intro ingeniería software
Programación concurrente y distribuida -> Prog. concurrente
Proyecto de informática I -> Proyecto informática I
Proyecto de informática II -> Proyecto informática II
Técnicas de programación avanzadas -> Técnicas prog. avanzadas
Impacto e influencia relacional -> Impacto e influencia

${hor}
IMPORTANTE: ese horario ya está personalizado para esta persona concreta. Si
preguntan por una asignatura que no aparece, es que no la cursan. No inventes
clases ni aulas que no estén ahí.

EVENTOS Y EXÁMENES
${listaEv}

CAPACIDADES
Cada persona puede personalizar su horario (quitarse asignaturas, cambiar aulas
solo para sí, ir solo ciertos días) y puede aplicar cambios a toda la clase. Si
preguntan cómo, diles que escriban el cambio en lenguaje natural (p. ej. "no
curso Álgebra" o "la VG30 no es la VG05") y Jeff preguntará si es solo para
ellos o para todos.

${datos ? `=== BORRADOR YA RESUELTO POR EL SISTEMA ===
Las horas, aulas y asignaturas de aquí abajo son la verdad: no cambies ninguna,
no añadas clases y no quites ninguna.

Tu trabajo es entregarlo como lo diría una persona:
- CONSERVA la frase corta de contexto del principio ("Hoy es lunes...", "El
  viernes tienes:"), o escribe una equivalente. Aquí sí va esa frase.
- Si el mensaje pregunta algo que se deduce de estos datos (si da tiempo entre
  clases, cuándo se acaba, cuántas horas son), RESPÓNDELO en una frase antes de
  la lista, o en vez de la lista si la lista no aporta.
- Si la pregunta se contesta con una sola clase, no las listes todas.

${datos}
` : ''}
=== MOMENTO ACTUAL (lo único que cambia entre consultas) ===
${contextoCalendario(iso)} Son las ${hora} (hora de España).${esAudio ? '\nNOTA: mensaje transcrito de un audio; puede tener erratas, interpreta por contexto.' : ''}`;

  const mensajes = [{ role: 'system', content: system }];
  for (const h of historial.slice(-6)) {
    mensajes.push({ role: h.rol === 'user' ? 'user' : 'assistant', content: h.texto });
  }
  mensajes.push({ role: 'user', content: texto });

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), plazo);
  try {
    const t0 = Date.now();

    // El plazo cubre la petición ENTERA, cabeceras y cuerpo. Limitar solo el
    // fetch deja fuera la lectura del cuerpo: si el servidor responde las
    // cabeceras y luego se calla, res.json() espera indefinidamente y el
    // usuario se queda con el "escribiendo" puesto para siempre.
    const peticion = (async () => {
      const res = await fetch(cfg.DEEPSEEK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.DEEPSEEK_KEY}` },
        body: JSON.stringify({ model: usado, messages: mensajes, max_tokens: tope, temperature: 0.2 }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { _http: res.status };
      return { _datos: await res.json() };
    })();

    // Promise.race además del AbortController: hay casos en que abortar no
    // interrumpe una conexión colgada, y entonces la promesa no se resuelve.
    const salida = await Promise.race([
      peticion,
      new Promise((_, rechazar) =>
        setTimeout(() => rechazar(Object.assign(new Error('timeout'), { esTimeout: true })), plazo + 500)),
    ]);
    clearTimeout(to);

    if (salida._http) {
      log.error(`${usado}: HTTP ${salida._http}`);
      apartarModelo(usado, `HTTP ${salida._http}`);
      return { _fallo: true, esTimeout: false };
    }
    const data = salida._datos;
    // Lo que piensa un modelo de razonamiento va aparte; aquí solo vale content.
    let r = data.choices?.[0]?.message?.content?.trim();
    log.info(`${usado} ${Date.now() - t0}ms`);
    apuntarGasto(data.usage);
    if (!r) { log.warn(`${usado}: respuesta vacía`); return { _fallo: true, esTimeout: false }; }
    r = formato.limpiarLLM(r);
    cache.set(k, { r, t: Date.now() });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    apuntarExito();
    return r;
  } catch (e) {
    clearTimeout(to);
    try { ctrl.abort(); } catch (_) {}   // suelta la conexión que quedó colgada
    // Un timeout de conexión llega como ConnectTimeoutError, no como
    // AbortError; tratarlos por igual evita esperas dobles.
    const LENTOS = ['AbortError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'TimeoutError'];
    const esTimeout = e.esTimeout || LENTOS.includes(e.name) ||
      ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.cause?.code || e.code);
    log.error(`${usado}: ${esTimeout ? `sin respuesta en ${plazo / 1000}s` : e.message}`);
    apartarModelo(usado, esTimeout ? 'timeout' : e.message);
    return { _fallo: true, esTimeout };
  }
}

async function transcribir(buffer, mimetype) {
  if (!cfg.GROQ_KEY) { log.warn('GROQ_API_KEY no configurada: no puedo transcribir audios'); return null; }
  try {
    const ext = (mimetype || '').includes('ogg') ? 'ogg' : 'm4a';
    const fd = new FormData();
    fd.append('file', new Blob([buffer]), `audio.${ext}`);
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'es');
    fd.append('response_format', 'json');
    const t0 = Date.now();
    const res = await fetch(cfg.GROQ_API, { method: 'POST', headers: { Authorization: `Bearer ${cfg.GROQ_KEY}` }, body: fd });
    if (!res.ok) { log.error(`Groq ${res.status}`); return null; }
    const d = await res.json();
    log.info(`audio transcrito en ${Date.now() - t0}ms`);
    return d.text;
  } catch (e) { log.error(`transcripción: ${e.message}`); return null; }
}

module.exports = { preguntar, transcribir, contextoHorario, cargarPersonalidad, estadoIA, probarApartados, TARIFA };
