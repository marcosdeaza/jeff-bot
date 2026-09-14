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
  // Un tropiezo puntual de la API no debe dejar al usuario sin respuesta.
  for (let i = 0; i < 2; i++) {
    const r = await intentarPreguntar(jid, texto, opts);
    if (r) return r;
    if (i === 0) { log.warn('reintentando la consulta al LLM'); await new Promise(r => setTimeout(r, 700)); }
  }
  return null;
}

async function intentarPreguntar(jid, texto, { historial = [], esAudio = false, datos = null } = {}) {
  const iso = H.hoyISO();
  const hora = H.horaAhora();
  const { texto: hor, huella } = contextoHorario(jid, iso);

  const k = clave(jid, texto, huella + (datos ? '|d' : ''));
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
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const t0 = Date.now();
    const res = await fetch(cfg.DEEPSEEK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.DEEPSEEK_KEY}` },
      body: JSON.stringify({ model: cfg.MODELO, messages: mensajes, max_tokens: 400, temperature: 0.2 }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!res.ok) { log.error(`DeepSeek ${res.status}`); return null; }
    const data = await res.json();
    let r = data.choices?.[0]?.message?.content?.trim();
    log.info(`DeepSeek ${Date.now() - t0}ms`);
    apuntarGasto(data.usage);
    if (!r) return null;
    r = formato.limpiarLLM(r);
    cache.set(k, { r, t: Date.now() });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return r;
  } catch (e) {
    clearTimeout(to);
    log.error(`DeepSeek: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return null;
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

module.exports = { preguntar, transcribir, contextoHorario, cargarPersonalidad, TARIFA };
