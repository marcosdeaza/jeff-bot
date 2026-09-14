const H = require('./horario');
const I = require('./intent');
const fmt = require('./formato');
const overrides = require('./overrides');
const eventos = require('./eventos');
const usuarios = require('./usuarios');
const ia = require('./ia');
const log = require('./log');
const cfg = require('./config');

// Qué se responde en local y qué se manda al modelo. Los datos (listados de
// clases) se resuelven SIEMPRE en local: son exactos e instantáneos, y así el
// modelo nunca puede inventarse un aula. Lo que cambia según el modo es quién
// redacta lo conversacional.
// Las que TOCAN ESTADO se quedan siempre en local: deben ser exactas y
// predecibles, y una redacción libre no aporta nada ahí.
const MUTACIONES = new Set(['miscambios', 'deshacer', 'reset', 'ayuda']);

function esMutacion(tipo) { return MUTACIONES.has(tipo); }

// Cambios propuestos a la espera de que el usuario diga el alcance.
const pendientes = new Map();
const VIDA_PENDIENTE = 10 * 60 * 1000;

const AYUDA = `Soy Jeff. Llevo tu horario de ${H.calendario.titulacion}.

*Consultar*
hoy, mañana, el viernes
ahora, siguiente
semana
exámenes, festivos

*Ajustar tu horario*
Dímelo en lenguaje normal, o mándame un audio:

Tengo una asignatura llamada Redes en el aula 205 los martes a las 16:30
Yo sí curso Álgebra
No curso Estadística
Solo voy martes y jueves
El aula de Álgebra es la 12, no la 5
Álgebra pasa a las 16:30
Se cancela Álgebra el lunes

Cuando detecte un cambio te preguntaré si es solo para ti o para toda la clase.
Si alguien cambia algo para todos y a ti no te aplica, responde: no me aplica.

*Gestionar*
mis cambios
deshacer
resetear`;

const pad = n => String(n).padStart(2, '0');
const corto = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ---------------- consultas locales (sin LLM, instantáneas) ----------------
function responderConsulta(jid, intencion) {
  const hoy = H.hoyISO();
  const hora = H.horaAhora();

  switch (intencion.tipo) {
    case 'ayuda': return AYUDA;

    case 'fecha': {
      const f = H.sumarDias(hoy, intencion.offset);
      const { estado, clases } = H.clasesDeDia(jid, f);
      const d = H.DIAS[H.diaSemana(f)];
      const cab = { '-1': `Ayer fue ${d}.`, 0: `Hoy es ${d}.`,
                    1: `Mañana es ${d}.`, 2: `Pasado mañana es ${d}.` }[String(intencion.offset)];
      const suf = intencion.offset === 0 ? 'Estas son las clases de hoy:' : 'Tienes:';
      return fmt.dia(f, estado, clases, cab, suf);
    }

    case 'diasemana': {
      let f = hoy;
      for (let i = 0; i < 8; i++) { const c = H.sumarDias(hoy, i); if (H.diaSemana(c) === intencion.dia) { f = c; break; } }
      const { estado, clases } = H.clasesDeDia(jid, f);
      return fmt.dia(f, estado, clases, `El ${H.DIAS[intencion.dia]}`, 'tienes:');
    }

    case 'ahora': {
      const c = H.claseAhora(jid, hoy, hora);
      if (c) return `Ahora (${hora}) tienes:\n\n${fmt.clase(c)}\n\nTermina a las ${c.fin}.`;
      const p = H.proximaClase(jid, hoy, hora);
      if (!p) return `Ahora no tienes clase y no te queda nada esta semana.`;
      return `Ahora no tienes clase. La siguiente es ${p.hoy ? 'hoy' : 'el ' + H.DIAS[H.diaSemana(p.fecha)]}:\n\n${fmt.clase(p.clase)}`;
    }

    case 'siguiente': {
      const p = H.proximaClase(jid, hoy, hora);
      if (!p) return 'No te queda ninguna clase próximamente.';
      return `La siguiente es ${p.hoy ? 'hoy' : 'el ' + H.DIAS[H.diaSemana(p.fecha)]}:\n\n${fmt.clase(p.clase)}`;
    }

    case 'semana': {
      const { sem, clases } = H.resolverSemestre(jid, hoy);
      if (!sem) return 'Estamos fuera del período lectivo.';
      const porDia = {};
      for (const c of clases) (porDia[c.dia] ||= []).push(c);
      return `Tu semana:\n\n${fmt.semana(porDia)}`;
    }

    case 'saludo':
      return 'Dime qué necesitas: hoy, mañana, semana, ahora, exámenes.\n\nEscribe ayuda para verlo todo.';

    case 'gracias':
      return 'A mandar.';

    case 'restantes': {
      const { estado, clases } = H.clasesDeDia(jid, hoy);
      if (estado.tipo !== 'lectivo') return fmt.dia(hoy, estado, [], `Hoy es ${H.DIAS[H.diaSemana(hoy)]}.`);
      const quedan = clases.filter(c => !c.cancelada && H.aMin(c.fin) > H.aMin(hora));
      if (!quedan.length) return 'Ya has terminado por hoy.';
      const enCurso = quedan[0] && H.aMin(quedan[0].inicio) <= H.aMin(hora);
      const cab = quedan.length === 1
        ? (enCurso ? 'Te queda la que estás dando:' : 'Te queda una clase:')
        : `Te quedan ${quedan.length} clases${enCurso ? ', contando la de ahora' : ''}:`;
      return `${cab}\n\n${fmt.lista(quedan)}`;
    }

    case 'semananum': {
      const sn = H.semanaDe(hoy);
      return sn ? `Semana *${sn.semana}* del semestre *${sn.semestre}*.` : 'Fuera del período lectivo.';
    }

    case 'eventos': {
      const evs = eventos.paraUsuario(jid);
      if (!evs.length) return 'No hay eventos ni exámenes registrados.\n\nApunta uno escribiendo: apunta examen de Álgebra el 15 de enero';
      const l = evs.map(e => `· ${e.texto}${e.fecha ? ` (${e.fecha})` : ''}${e.scope === 'personal' ? ' _solo tuyo_' : ''}`).join('\n');
      return `Eventos y exámenes:\n\n${l}`;
    }

    case 'festivos': {
      const prox = Object.entries(H.calendario.festivos).filter(([f]) => f >= hoy);
      const vac = H.calendario.vacaciones.filter(v => v.fin >= hoy);
      let s = 'Próximos días libres:\n';
      for (const [f, n] of prox.slice(0, 5)) s += `\n${corto(f)} — ${n}`;
      for (const v of vac.slice(0, 4)) s += `\n${corto(v.inicio)}–${corto(v.fin)} — ${v.nombre}`;
      return s;
    }

    case 'miscambios': {
      const mios = overrides.personalesDe(jid).filter(o => o.tipo !== 'ignorar-global');
      const excl = overrides.personalesDe(jid).filter(o => o.tipo === 'ignorar-global');
      const gl = overrides.globales();
      const evp = eventos.personalesDe(jid);
      const lineas = [];
      if (!mios.length && !excl.length) lineas.push('Ninguno, tienes el horario oficial.');
      mios.forEach(o => lineas.push(describir(o)));
      if (excl.length) lineas.push(excl.length === 1
        ? 'Te has excluido de un cambio de la clase.'
        : `Te has excluido de ${excl.length} cambios de la clase.`);
      let s = '*Tus ajustes*\n' + lineas.join('\n');
      if (evp.length) s += `\n\n*Tus eventos privados:* ${evp.length}`;
      s += `\n\n*Cambios de toda la clase:* ${gl.length}`;
      gl.slice(-5).forEach(o => { s += `\n${describir(o)} (por ${usuarios.nombreDe(o.creadoPor)})`; });
      s += '\n\ndeshacer revierte el último, resetear lo quita todo';
      return s;
    }

    case 'deshacer': {
      const o = overrides.deshacerUltimo(jid);
      if (o) return `Revertido: ${describir(o)}`;
      const e = eventos.deshacerUltimo(jid);
      if (e) return `Evento eliminado: ${e.texto}`;
      return 'No tienes nada que deshacer.';
    }

    case 'reset': {
      const mios = overrides.personalesDe(jid);
      mios.forEach(o => overrides.desactivar(o.id, jid));
      return mios.length
        ? `Quitados tus ${mios.length} ajustes. Vuelves al horario oficial.`
        : 'Ya tenías el horario oficial.';
    }
  }
  return null;
}

function describir(o) {
  // El motivo guarda el resumen en lenguaje natural de cuando se creó:
  // es siempre más claro que reconstruirlo desde el match.
  if (o.motivo && o.motivo.length > 3) return o.motivo.replace(/\*/g, '');
  const a = o.match.asignatura ? `*${o.match.asignatura}*` : o.match.dia != null ? `los ${H.DIAS[o.match.dia]}` : 'clases';
  switch (o.tipo) {
    case 'quitar':   return `quitado ${a}`;
    case 'cancelar': return `${a} anulada`;
    case 'aula':     return `${a} → aula ${o.set.edificio || o.set.aula}`;
    case 'hora':     return `${a} → ${o.set.inicio}`;
    case 'mover':    return `${a} movida`;
    case 'anadir':   return `añadida ${o.set.asignatura}`;
    default:         return o.tipo;
  }
}

// ---------------- propuesta de cambio + pregunta de alcance ----------------
function proponer(jid, prop) {
  pendientes.set(jid, { prop, ts: Date.now() });
  return `He entendido: ${prop.resumen}\n\n¿Para quién?\n*1* solo para mí\n*2* para toda la clase\n*0* cancelar`;
}

function aplicar(jid, prop, scope) {
  const comun = { scope, owner: jid, creadoPor: jid, motivo: prop.resumen };
  let creados = [];

  if (prop.tipo === 'solodias') {
    // "solo voy martes y jueves" -> un override por cada día que se quita
    creados = prop.quitar.map(d => overrides.crear({ ...comun, tipo: 'quitar', match: { dia: d }, set: {} }));
  } else if (prop.tipo === 'anadir' && Array.isArray(prop.dias)) {
    // "los lunes y miércoles a las 12:00" -> una clase por cada día
    creados = prop.dias.map(d => overrides.crear({ ...comun, tipo: 'anadir', match: {}, set: { ...prop.set, dia: d } }));
  } else {
    creados = [overrides.crear({ ...comun, tipo: prop.tipo, match: prop.match, set: prop.set })];
  }

  const donde = scope === 'personal' ? 'solo en tu horario' : '*para toda la clase*';
  let texto = `Aplicado ${donde}: ${prop.resumen}\n\nEscribe deshacer si te has equivocado.`;

  let difusion = null;
  if (scope === 'global') {
    difusion = {
      texto: `Cambio en el horario de la clase: ${prop.resumen}\n\nLo ha puesto ${usuarios.nombreDe(jid)}.\nSi a ti no te aplica, responde: no me aplica.`,
      excepto: [jid],
      overrideId: creados[0].id,
    };
  }
  return { texto, difusion };
}


// ---------------- añadir / recuperar una asignatura ----------------
function manejarAnadir(jid, a) {
  const hoy = H.hoyISO();
  const sem = H.semestreDe(hoy);

  if (a.tipo === 'anadir-incompleto') {
    // Se guarda a la espera de que complete: si no, al responder "los jueves a
    // las 9" ya no habría forma de saber de qué asignatura hablaba.
    pendientes.set(jid, { parcial: { asignatura: a.asignatura }, ts: Date.now() });
    return { texto: `Vale, ${a.asignatura}. Me falta ${a.falta}.\n\nDímelo tal cual, por ejemplo:\nlos martes a las 16:30 en el aula 205` };
  }

  if (a.tipo === 'recuperar') {
    // ¿Se la quitaron a toda la clase? Entonces basta con excluirse de ese cambio.
    const global = [...overrides.globales()].reverse().find(o =>
      o.tipo === 'quitar' && o.match.asignatura && H.mismaAsignatura(o.match.asignatura, a.asignatura));

    if (global) {
      if (overrides.ignoradosPor(jid).has(global.id)) {
        return { texto: `Ya la tienes, ${a.asignatura} está en tu horario.` };
      }
      overrides.excluirseDeGlobal(jid, global.id);
      const slots = H.BASE.filter(c => H.mismaAsignatura(c.asignatura, a.asignatura) && (!sem || c.semestre === sem.n));
      const det = slots.map(c => `${H.DIAS[c.dia]} ${c.inicio} ${c.edificio}`).join('\n');
      return { texto: `${a.asignatura} añadida a tu horario:\n\n${det}\n\nAl resto de la clase le sigue sin aparecer.` };
    }

    // ¿La tiene ya de serie?
    const { clases } = H.resolverSemestre(jid, hoy);
    if (clases.some(c => H.mismaAsignatura(c.asignatura, a.asignatura))) {
      return { texto: `Ya la tienes, ${a.asignatura} está en tu horario.` };
    }

    // ¿Se la quitó ella misma antes?
    const propio = overrides.personalesDe(jid).find(o =>
      o.tipo === 'quitar' && o.match.asignatura && H.mismaAsignatura(o.match.asignatura, a.asignatura));
    if (propio) {
      overrides.desactivar(propio.id, jid);
      return { texto: `${a.asignatura} vuelve a tu horario.` };
    }

    return { texto: `No encuentro ${a.asignatura} en el horario oficial.\n\nDime cuándo es y te la añado:\nponme ${a.asignatura} los martes de 16:30 a 18:30 en VH09` };
  }

  // ¿Choca con algo que ya tiene? Al repetidor le pasa a menudo.
  const { clases: suyas } = H.resolverSemestre(jid, hoy);
  const ini = H.aMin(a.inicio), fin = H.aMin(a.fin);
  const choque = suyas.filter(c => a.dias.includes(c.dia) && !c.cancelada &&
    H.aMin(c.inicio) < fin && ini < H.aMin(c.fin));
  const aviso = choque.length
    ? `Ojo, te choca con: ${[...new Set(choque.map(c => `${c.asignatura} ${c.inicio}`))].join(', ')}\n\n`
    : '';

  // Alta manual con día y hora -> se pregunta el alcance, como cualquier cambio
  const prop = {
    tipo: 'anadir',
    dias: a.dias,
    match: {},
    set: {
      semestre: sem ? sem.n : 1,
      inicio: a.inicio, fin: a.fin,
      asignatura: a.asignatura, edificio: a.aula || '—', aula: '—',
    },
    resumen: a.resumen,
  };
  return { texto: proponer(jid, prop).replace('¿Para quién?', aviso + '¿Para quién?') };
}

// ---------------- entrada principal ----------------
async function manejar(jid, texto, { esAudio = false, sesion = null } = {}) {
  const t = texto.trim();
  if (!t) return null;

  // 1) ¿Está respondiendo a una pregunta de alcance?
  const pend = pendientes.get(jid);
  if (pend && pend.parcial) {
    if (Date.now() - pend.ts > VIDA_PENDIENTE) {
      pendientes.delete(jid);
    } else if (/^(no|nada|dejalo|olvidalo|cancelar)\b/i.test(I.n(t))) {
      pendientes.delete(jid);
      return { texto: 'Vale, lo dejo.' };
    } else {
      // Se reconstruye la frase entera con el nombre que ya se conocía.
      const completo = I.anadir(`ponme ${pend.parcial.asignatura} ${t}`);
      if (completo && completo.tipo === 'anadir') {
        pendientes.delete(jid);
        return manejarAnadir(jid, completo);
      }
      if (completo && completo.tipo === 'anadir-incompleto') {
        pendientes.set(jid, { parcial: pend.parcial, ts: Date.now() });
        return { texto: `Sigo sin ${completo.falta} de ${pend.parcial.asignatura}.\n\nPor ejemplo: los martes a las 16:30 en el aula 205` };
      }
    }
  }

  if (pend && !pend.parcial) {
    if (Date.now() - pend.ts > VIDA_PENDIENTE) pendientes.delete(jid);
    else {
      const alc = I.alcance(t);
      if (alc === 'cancelar') { pendientes.delete(jid); return { texto: 'Cancelado. No he cambiado nada.' }; }
      if (alc) {
        pendientes.delete(jid);
        return pend.prop.esEvento ? aplicarEvento(jid, pend.prop, alc) : aplicar(jid, pend.prop, alc);
      }
    }
  }

  // 2) "no me aplica [asignatura]" -> excluirse de un cambio global.
  // Si se nombra una asignatura se busca ESE cambio; si no, el más reciente.
  if (/^(no me aplica|a mi no|yo no|eso no me aplica)/i.test(I.n(t))) {
    const gl = overrides.globales();
    if (!gl.length) return { texto: 'No hay ningún cambio de clase del que excluirte.' };

    const asig = I.asignaturaMencionada(I.n(t));
    let objetivo = null;
    if (asig) {
      objetivo = [...gl].reverse().find(o =>
        o.match.asignatura && H.mismaAsignatura(o.match.asignatura, asig));
      if (!objetivo) {
        return { texto: `No encuentro ningún cambio de clase sobre ${asig}.\n\nEscribe mis cambios para ver los que hay.` };
      }
    } else {
      objetivo = gl[gl.length - 1];
    }

    const ya = overrides.ignoradosPor(jid);
    if (ya.has(objetivo.id)) return { texto: `Ese cambio ya no se te aplicaba: ${describir(objetivo)}.` };

    overrides.excluirseDeGlobal(jid, objetivo.id);
    return { texto: `Hecho. ${describir(objetivo)} ya no se aplica en tu horario. Para los demás sigue.` };
  }

  // 3) consultas reconocidas. El resolver local calcula SIEMPRE los datos
  // exactos; según el modo, los devuelve tal cual o se los pasa al modelo para
  // que los redacte. Si el modelo falla o tarda, vale la respuesta local: nunca
  // se queda peor que sin él.
  const c1 = I.consulta(t);
  if (c1) {
    const local = responderConsulta(jid, c1);
    if (local) {
      if (cfg.MODO_IA === 'ahorro' || esMutacion(c1.tipo)) return { texto: local };
      const r = await ia.preguntar(jid, texto, {
        historial: sesion?.historial || [], esAudio, datos: local,
      });
      return { texto: r || local };
    }
  }

  // 4) ¿quiere añadir o recuperar una asignatura?
  const ad = I.anadir(t);
  if (ad) return manejarAnadir(jid, ad);

  // 5) ¿es una propuesta de cambio?
  const ch = I.cambio(t);
  if (ch) return { texto: proponer(jid, ch) };

  // 5) ¿apuntar un evento?
  const ev = detectarEvento(t);
  if (ev) { pendientes.set(jid, { prop: { ...ev, esEvento: true }, ts: Date.now() });
    return { texto: `Apunto: ${ev.texto}\n\n¿Para quién?\n*1* solo para mí\n*2* para toda la clase\n*0* cancelar` }; }

  // 6) consultas ambiguas ("el lunes" puede ser una consulta o el principio de
  // una pregunta). Se resuelven los datos igual, pero es el modelo quien decide
  // qué responde de verdad el mensaje.
  const c2 = I.consultaDebil(t);
  if (c2) {
    const local = responderConsulta(jid, c2);
    if (local) {
      if (cfg.MODO_IA === 'ahorro') return { texto: local };
      const r = await ia.preguntar(jid, texto, {
        historial: sesion?.historial || [], esAudio, datos: local,
      });
      return { texto: r || local };
    }
  }

  // 7) libre -> LLM con SU horario resuelto
  const r = await ia.preguntar(jid, t, { historial: sesion?.historial || [], esAudio });
  if (r) return { texto: r };
  return { texto: 'No he podido procesar eso. Prueba con hoy, mañana o ayuda.', noGuardar: true };
}

function detectarEvento(t) {
  const n = I.n(t);
  const m = n.match(/^(apunta|apuntar|anota|evento|aviso|recuerda)\s*:?\s*(.+)/);
  if (m && m[2].length > 3) return { texto: t.replace(/^\s*\w+\s*:?\s*/, '').trim() };
  if (/\b(examen|entrega|practica|trabajo)\b/.test(n) && /\b(el |dia |proximo |para el )/.test(n) && n.length > 15) {
    return { texto: t.trim() };
  }
  return null;
}

// Aplica un pendiente que resultó ser un evento
function aplicarEvento(jid, prop, scope) {
  const e = eventos.crear({ texto: prop.texto, scope, owner: jid, autor: jid });
  return {
    texto: `Apuntado ${scope === 'personal' ? 'solo para ti' : 'para toda la clase'}: ${e.texto}`,
    difusion: scope === 'global' ? { texto: `Nuevo aviso para la clase: ${e.texto}\n\nPor ${usuarios.nombreDe(jid)}.`, excepto: [jid] } : null,
  };
}

module.exports = { manejar, AYUDA, pendientes, aplicar, aplicarEvento, describir, responderConsulta };
