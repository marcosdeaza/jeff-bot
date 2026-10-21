// Interpretación LOCAL de lo que se dice sobre la agenda personal: tareas,
// notas, recordatorios y temporizadores. Solo interpreta la frase; si lo que
// nombra existe de verdad lo decide quien ejecuta, que puede mirar la agenda.
//
// Todo se busca sobre el texto "plano" (minúsculas, sin tildes) que conserva
// la longitud del original, así lo que se recorta vale para los dos.
const T = require('./tiempo');

const MULETILLA = /^(?:oye|eh|ey|hey|porfa|por favor|jeff|bot|vale|venga|bueno|a ver|mira|y)\b[\s,.:;!]*/;

// Quita muletillas del principio y signos de los extremos, devolviendo el
// texto original y el plano ya alineados.
function preparar(texto) {
  let o = String(texto || '').trim();
  for (;;) {
    const m = T.plano(o).match(MULETILLA);
    if (!m || !m[0]) break;
    o = o.slice(m[0].length);
  }
  const p0 = T.plano(o);
  const ini = p0.match(/^[\s¿¡"'«]*/)[0].length;
  const fin = p0.length - p0.match(/[\s?!.¡"'»]*$/)[0].length;
  o = o.slice(ini, Math.max(ini, fin));
  return { o, p: T.plano(o), pregunta: /\?\s*$/.test(texto) || /^\s*¿/.test(texto) };
}

const quitarTramos = (o, spans) => {
  let r = o;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) r = r.slice(0, a) + ' ' + r.slice(b);
  return r;
};

// Lo que queda de "recuérdame en 10 min que saque la ropa" es "que saque la
// ropa": fuera conectores al principio y cortesías al final.
function limpiarResto(s) {
  let r = String(s || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const antes = r;
    r = r.replace(/^[,:;.\-–]+\s*/, '')
      .replace(/^(?:que|de|para|a|lo de|lo del|sobre|acerca de|tambien|y)\s+/i, '')
      .replace(/\s*[,.;]?\s*(?:porfa|por favor|gracias|vale|ok|plis|please|eh)\s*$/i, '')
      .replace(/\s+(?:a|en)\s+(?:la|mi)\s+lista$/i, '')
      .replace(/\s+(?:a|en)\s+(?:mis\s+)?tareas$/i, '')
      .trim();
    if (r === antes) break;
  }
  return r.replace(/[,;:]+$/, '').trim();
}

// "1, 2 y 4", "la 3", "las dos primeras" no; un texto suelto es una referencia por contenido.
function refs(txt) {
  const t = T.plano(String(txt || '')).trim();
  if (!t) return { vacio: true };
  const sinRelleno = t.replace(/\b(?:la|el|las|los|tarea|tareas|nota|notas|recordatorio|recordatorios|numero|n|y|e)\b|[,.\-#º]/g, ' ').trim();
  if (/^\d{1,3}(?:\s+\d{1,3})*$/.test(sinRelleno)) {
    return { nums: [...sinRelleno.matchAll(/\d{1,3}/g)].map(x => +x[0]) };
  }
  if (/^(?:todo|todas|todos|ya esta todo|toda la lista|todas las tareas)$/.test(t)) return { todo: true };
  return { texto: txt.trim() };
}

const COLECCION = w => {
  if (!w) return null;
  if (/^(?:tarea|lista|pendiente)/.test(w)) return 'tareas';
  if (/^nota/.test(w)) return 'notas';
  if (/^(?:recordatorio|aviso|alarma|temporizador)/.test(w)) return 'recordatorios';
  return null;
};

const V_REC = /\b(?:recuerdamelo|recuerdame(?:lo)?|recuerdanos|recordarme|me recuerdas|me lo recuerdas|avisame|avisanos|me avisas|despiertame|(?:pon|crea|programa|ponme|creame|programame)\s+(?:un|una)\s+(?:recordatorio|alarma|aviso)(?:\s+(?:para|de))?|recordatorio(?:\s+(?:para|de))?\s*:?|alarma(?:\s+(?:para|de))?)\b/;
const V_TIMER = /\b(?:(?:pon|ponme|crea|creame|programa)\s+(?:un|una)\s+)?(?:temporizador|timer|cuenta atras|cronometro)\b(?:\s+(?:de|para))?/;
const NOTA_PRE = /^(?:(?:pon|crea|guarda|haz|apunta|anota|escribe)(?:me|lo)?\s+(?:una\s+|esta\s+)?nota(?:\s+(?:que dice|que|de|con|sobre))?|notas?(?:\s+nueva)?(?=\s*[:\-,]|\s+\S)|(?:apunta|anota|guarda|escribe|mete)(?:me|lo)?\s+(?:esto\s+)?(?:en\s+(?:mis\s+|las\s+)?notas|como\s+nota)|(?:apunta|anota|guarda)(?:me|lo)?\s+que|recuerda\s+que|que no se me olvide que|para que no se me olvide(?:\s+que)?)\s*[:,\-]?\s*/;
const TAREA_PRE = /^(?:tengo que|tengo pendiente|debo|hay que|me toca hacer|nueva tarea|tarea\s*:|tareas\s*:|pendiente\s*:|to ?do\s*:?|lista\s*:|apunta(?:me|lo)?|anota(?:me|lo)?|(?:anade|agrega|mete|pon)(?:me|lo)?\s+(?:a|en)\s+(?:la|mi)\s+lista|(?:anade|agrega|mete|pon)(?:me|lo)?\s+(?:a|en)\s+(?:mis\s+)?tareas|(?:anade|agrega|crea)(?:me)?\s+(?:una\s+)?tarea)\s*[:,\-]?\s*/;
const BORRAR = '(?:borra|olvida|elimina|quita|vacia|limpia|cancela|resetea)(?:r|me|te de|las|los|la)?';

function interpretar(texto, ahora = Date.now()) {
  const { o, p, pregunta } = preparar(texto);
  if (!p) return null;
  const q = p.replace(/[¿?¡!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  let m;

  // ---- ayuda de la agenda ----
  if (/^(?:\/?ayuda|help)\s+(?:agenda|tareas?|notas?|recordatorios?|lista|alarmas?)$/.test(q) ||
      /^(?:como|que) (?:funciona|funcionan|hago con|puedo hacer con) (?:la agenda|las tareas|los recordatorios|las notas)/.test(q)) {
    return { tipo: 'ayuda' };
  }

  // ---- olvidar la conversación ----
  if (/\b(?:borra|olvida|elimina|limpia|resetea)(?:r|te de|me)?\s+(?:toda\s+)?(?:la|nuestra|esta|el|mi|este)?\s*(?:conversacion|historial|chat)\b/.test(q) ||
      /\bolvida lo que (?:hemos hablado|te he dicho|hablamos)\b/.test(q)) {
    return { tipo: 'olvidar_conversacion' };
  }

  // ---- borrar TODO lo de esta persona ----
  if (/^(?:borra|olvida|elimina)(?:r|me|te de)?\s+(?:todo|todos mis datos|mis datos|todo lo mio|todo lo que sabes de mi|todo sobre mi|toda mi informacion|mi cuenta)$/.test(q) ||
      /^olvidate de (?:todo|mi)$/.test(q)) {
    return { tipo: 'borrar_todo' };
  }

  // ---- repaso de la noche ----
  if (/\b(?:no me (?:recuerdes|mandes|envies|hagas) (?:las tareas|el repaso|nada por la noche|el resumen)|(?:desactiva|quita|apaga|para)(?:r)? el (?:repaso|resumen)|sin repaso)\b/.test(q)) {
    return { tipo: 'repaso', activo: false };
  }
  if (/\b(?:(?:activa|pon|enciende)(?:r|me)? el (?:repaso|resumen)|quiero el (?:repaso|resumen)|recuerdame las tareas (?:cada|por la) noche)\b/.test(q)) {
    return { tipo: 'repaso', activo: true };
  }

  // ---- listados ----
  const VER = '(?:(?:ver|ensena(?:me)?|muestra(?:me)?|dame|lee(?:me)?|dime|pasame|saca(?:me)?|que hay en)\\s+)?';
  if (new RegExp(`^${VER}(?:mis |las |todas mis |todas las )?notas$`).test(q) || /\bque notas tengo\b/.test(q)) {
    return { tipo: 'listar', que: 'notas' };
  }
  if (new RegExp(`^${VER}(?:mis |los |las )?(?:recordatorios|alarmas|temporizadores|avisos programados)$`).test(q) ||
      /\bque (?:recordatorios|alarmas) tengo\b|\bde que me vas a avisar\b|\bque me vas a recordar\b/.test(q)) {
    return { tipo: 'listar', que: 'recordatorios' };
  }
  if (new RegExp(`^${VER}(?:mis |las |la |mi )?(?:tareas|lista|lista de tareas|pendientes|to ?do|deberes|tareas pendientes)$`).test(q) ||
      /\b(?:mis tareas|mi lista|que tengo que hacer|que me queda por hacer|tareas pendientes|mis pendientes|lista de tareas|que tengo pendiente)\b/.test(q)) {
    return { tipo: 'listar', que: 'tareas' };
  }
  if (/^(?:mi agenda|agenda|mis cosas|resumen|mis apuntes|todo lo que tengo apuntado|que tengo apuntado|lo que tengo apuntado|ver todo|ensename todo)$/.test(q)) {
    return { tipo: 'listar', que: 'todo' };
  }

  // ---- limpiar las hechas ----
  if (new RegExp(`^${BORRAR}\\b.*\\b(?:hechas|hechos|completadas|terminadas|tachadas|acabadas)$`).test(q) ||
      /^limpia(?:r)?(?: la lista| mis tareas| las tareas)?$/.test(q)) {
    return { tipo: 'limpiar_hechas' };
  }

  // ---- vaciar una colección entera ----
  if ((m = q.match(new RegExp(`^${BORRAR}\\s+(?:todas?\\s+|todos\\s+)?(?:mis|las|los|la|tus)?\\s*(?:todas?\\s+|todos\\s+)?(tareas|lista|notas|recordatorios|alarmas|avisos|temporizadores)(?:\\s+(?:estas|esas|de una vez|todas|todos|que tengo|pendientes|que te he dicho))?$`)))) {
    return { tipo: 'borrar_coleccion', coleccion: COLECCION(m[1]) };
  }

  // ---- posponer el último aviso ----
  if (/^(?:pospon(?:lo|la|me)?|aplaza(?:lo|la)?|recuerdamelo|recuerdamelo otra vez|avisame otra vez|avisame de nuevo|repitelo|otra vez|de nuevo|luego|mas tarde)\b/.test(q) ||
      (/\b(?:otra vez|de nuevo)$/.test(q) && T.extraer(o, ahora))) {
    const t = T.extraer(o, ahora);
    const resto = t ? limpiarResto(quitarTramos(o, t.spans)).replace(/^(?:posp[oó]n(?:lo|la|me)?|aplaza(?:lo|la)?|recu[eé]rdamelo|av[ií]same|rep[ií]telo|otra vez|de nuevo|luego|m[aá]s tarde)\b/i, '') : '';
    if (!t || limpiarResto(resto).replace(/\b(otra vez|de nuevo)\b/gi, '').trim().length <= 2) {
      // "pospón 10 minutos" también vale sin el "en".
      const d = !(t && t.ts) ? T.buscarDuracion(p, { suelta: true }) : null;
      return { tipo: 'posponer', ts: t && t.ts ? t.ts : d ? ahora + d.ms : null };
    }
  }

  // "cancela el temporizador" o "borra el recordatorio 2" son borrados, no altas.
  const empiezaBorrando = new RegExp(`^${BORRAR}\\b`).test(q);

  // ---- temporizador ----
  if (!empiezaBorrando && (m = p.match(V_TIMER))) {
    const d = T.buscarDuracion(p, { suelta: true });
    const tramos = [[m.index, m.index + m[0].length]];
    if (d) tramos.push([d.ini, d.fin]);
    const resto = limpiarResto(quitarTramos(o, tramos).replace(/^\s*(?:pon(?:me)?|crea(?:me)?)\s+(?:un|una)\s*/i, ''));
    return { tipo: 'temporizador', ms: d ? d.ms : null, texto: resto };
  }

  // ---- nota ----
  if ((m = p.match(NOTA_PRE)) && !/^notas$/.test(q)) {
    const contenido = o.slice(m[0].length).trim();
    // "recuerda que mañana a las 10 tengo dentista" tiene hora: es un aviso.
    if (/^recuerda\s+que/.test(m[0])) {
      const t = T.extraer(contenido, ahora);
      if (t && t.ts) return recordatorioDesde(contenido, t, ahora);
    }
    return { tipo: 'nota_nueva', texto: limpiarResto(contenido) };
  }

  // ---- recordatorio ----
  if (!empiezaBorrando && (m = p.match(V_REC))) {
    const sinVerbo = o.slice(0, m.index) + ' ' + o.slice(m.index + m[0].length);
    // Una alarma o un "despiértame" a las 7 son las 7 de la mañana, no de la tarde.
    const despertar = /despiertame|alarma/.test(m[0]);
    const t = T.extraer(sinVerbo, ahora, { manana: despertar });
    if (t) return recordatorioDesde(sinVerbo, t, ahora, { despertar: /despiertame/.test(m[0]) ? 'Despierta' : despertar ? 'Alarma' : null });
    const texto = limpiarResto(sinVerbo);
    if (!texto) return { tipo: 'recordatorio_sin_nada' };
    return { tipo: 'tarea_nueva', textos: [texto], para: null, preguntarCuando: true };
  }

  // ---- marcar hecha ----
  if (/^(?:ya\s+)?(?:esta|estan|lo he hecho)?\s*(?:todo|todas|todos)(?:\s+(?:hecho|hechas|hechos|listo|listas|listos|terminado))?$/.test(q) && /\b(?:todo|todas|todos)\b/.test(q) && q.split(' ').length <= 4 ||
      /^(?:ya\s+)?(?:he hecho|hice|termine|acabe) (?:todo|todas|todas las tareas)$/.test(q)) {
    return { tipo: 'hecha', ref: { todo: true } };
  }
  // Con la bandera d el patrón da también dónde empieza cada grupo, y así se
  // recorta del original (con sus tildes) lo mismo que se reconoció en el plano.
  const tramo = (m, g) => (m.indices[g] ? o.slice(m.indices[g][0], m.indices[g][1]) : '');
  if ((m = p.match(/^(?:ya\s+)?(?:lo\s+|la\s+|las\s+|los\s+)?(?:he\s+)?(?:hecho|hice|terminado|termine|acabado|acabe|completado|complete|finalizado|tachado|tacha|marca(?:r)?(?:\s+como\s+hech[ao]s?)?|check|hecha|hechas)(?:\s+(?:la\s+tarea\s+|las\s+tareas\s+|la\s+|el\s+|las\s+|los\s+|lo\s+de\s+)?(.+))?$/d))) {
    return { tipo: 'hecha', ref: m[1] ? refs(tramo(m, 1)) : { vacio: true } };
  }
  if ((m = p.match(/^(?:(?:la|el|las|los|lo de)\s+)?(.+?)\s+(?:ya\s+)?(?:esta\s+|estan\s+)?(?:hecha|hechas|hecho|hechos|completada|completadas|terminada|terminadas)$/d))) {
    return { tipo: 'hecha', ref: refs(tramo(m, 1)) };
  }

  // ---- desmarcar ----
  if ((m = p.match(/^(?:desmarca(?:r)?|destacha(?:r)?|reabre|reabrir|vuelve a abrir|no he hecho|aun no he hecho|todavia no he hecho|no esta hecha)\s+(?:la\s+tarea\s+|la\s+|el\s+|lo\s+de\s+)?(.+)$/d))) {
    return { tipo: 'reabrir', ref: refs(tramo(m, 1)) };
  }
  if ((m = q.match(/^(?:la\s+)?(\d{1,3})\s+no (?:esta|la he|lo he) (?:hecha|hecho|terminado|terminada)$/))) {
    return { tipo: 'reabrir', ref: { nums: [+m[1]] } };
  }

  // ---- borrar una ----
  if ((m = p.match(new RegExp(`^${BORRAR}\\s+(?:el\\s+|la\\s+|lo\\s+de\\s+|los\\s+|las\\s+|mi\\s+|mis\\s+)?(?:(tarea|nota|recordatorio|aviso|alarma|temporizador)s?\\b\\s*)?(?:de\\s+(?:la\\s+|el\\s+|lo\\s+de\\s+)?|del\\s+|numero\\s+|n\\.?\\s*)?(.*)$`, 'd')))) {
    const col = COLECCION(m[1]);
    const refTxt = tramo(m, 2);
    if (!col && !refTxt.trim()) return null;
    return { tipo: 'borrar_uno', coleccion: col, ref: refs(refTxt) };
  }

  // ---- tarea nueva ----
  if ((m = p.match(TAREA_PRE))) {
    const pre = m[0];
    // "¿tengo que ir mañana?" es una pregunta, no algo que apuntar.
    if (pregunta && /^(?:tengo que|debo|hay que|me toca)/.test(pre)) return null;
    let contenido = o.slice(pre.length);
    // "apunta examen de álgebra el 15" es un evento de clase, va por su camino.
    if (/^(?:apunta|anota)/.test(pre) && /\b(?:examen|parcial|final|entrega|exposicion|recuperacion)\b/.test(T.plano(contenido)) && T.extraer(contenido, ahora)) return null;
    const lineas = contenido.split(/\n+/).map(l => l.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '')).filter(l => l.trim());
    if (!lineas.length) return { tipo: 'tarea_vacia' };
    if (lineas.length === 1) {
      // Una fecha sin hora es el día para el que es: "entregar la práctica el viernes".
      const t = T.extraer(lineas[0], ahora);
      if (t && t.dia && !t.relativo && !t.repetir) {
        const texto = t.hayHora ? limpiarResto(lineas[0]) : limpiarResto(quitarTramos(lineas[0], t.spans));
        if (texto) return { tipo: 'tarea_nueva', textos: [texto], para: t.dia };
      }
    }
    const textos = lineas.map(limpiarResto).filter(Boolean);
    return textos.length ? { tipo: 'tarea_nueva', textos, para: null } : { tipo: 'tarea_vacia' };
  }

  return null;
}

function recordatorioDesde(texto, t, ahora, { despertar = false } = {}) {
  let resto = limpiarResto(quitarTramos(texto, t.spans));
  if (!resto && despertar) resto = despertar;
  if (t.ts) return { tipo: 'recordatorio_nuevo', texto: resto, ts: t.ts, repetir: t.repetir || null, horaPorDefecto: !!t.horaPorDefecto };
  // Se dijo un día pero no queda hora útil: "hoy" a las once de la noche, o
  // una hora de hoy que ya pasó.
  if (t.hayHora) return { tipo: 'hora_pasada', texto: resto };
  if (t.dia && resto) return { tipo: 'tarea_nueva', textos: [resto], para: t.dia, preguntarCuando: true };
  return { tipo: 'hora_pasada', texto: resto };
}

// Mensajes que suenan a agenda pero que el intérprete local no ha sabido
// leer: se le pasan al modelo para que los traduzca a acciones.
const PISTA_FUERTE = /\b(?:recuerd\w*|recordatorio\w*|avis\w*me|alarma\w*|temporizador\w*|timer|apunt\w*|anot\w*|nota|notas|tarea\w*|lista|pendientes?|agenda|despiert\w*)\b/;
const PISTA_DEBIL = /\b(?:hech[ao]s?|hice|termine|acabe|tacha\w*|marca\w*|borra\w*|olvida\w*|quita\w*|elimina\w*|cancela\w*|pospon\w*)\b/;
function pista(texto) {
  const q = T.plano(String(texto || ''));
  if (PISTA_FUERTE.test(q)) return 'fuerte';
  if (PISTA_DEBIL.test(q)) return 'debil';
  return null;
}

module.exports = { interpretar, pista, refs, limpiarResto, preparar };
