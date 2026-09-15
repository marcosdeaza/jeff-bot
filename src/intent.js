// Detección local de intención. Dos objetivos:
//  1) responder al instante lo frecuente (sin llamar al LLM) -> más rápido
//  2) detectar PROPUESTAS DE CAMBIO para preguntar el alcance (yo / todos)
const H = require('./horario');

// Los estudiantes escriben en argot. Expandirlo aquí evita mandar al modelo
// mensajes que en realidad son consultas triviales.
const ARGOT = [
  [/\bq\b/g, 'que'], [/\bk\b/g, 'que'], [/\bxq\b/g, 'porque'], [/\bpq\b/g, 'porque'],
  [/\bpa\b/g, 'para'], [/\btb\b/g, 'tambien'], [/\btmb\b/g, 'tambien'],
  [/\bdnd\b/g, 'donde'], [/\bpf\b/g, 'porfa'], [/\bxfa\b/g, 'porfa'],
  [/\bhy\b/g, 'hoy'], [/\bmñn\b/g, 'manana'], [/\bsig\b/g, 'siguiente'],
];

const n = s => {
  let x = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  for (const [re, rep] of ARGOT) x = x.replace(re, rep);
  return x.replace(/\s+/g, ' ');
};

// Muletillas al principio: "dime qué toca hoy" es exactamente "hoy".
const MULETILLAS = /^(?:(?:oye|eh|hey|porfa|porfavor|por favor|jeff|bot)\s+)*(?:(?:me\s+)?(?:dime|dile|dices|puedes decirme|puedes decir|sabes|saber|mira|ver|enseñame|ensename|muestrame|pon|dame)\s+)*(?:(?:que|cual|cuales|cuanto|cuando|como|donde)\s+(?:es|son|hay|toca|tocan|tengo|tienes)\s+)?/;
const sinMuletillas = t => t.replace(MULETILLAS, '').trim() || t;

// El audio transcrito escribe los números en letra: "VG treinta" -> "VG30"
const NUM = {
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6',
  siete: '7', ocho: '8', nueve: '9', diez: '10', once: '11', doce: '12',
  trece: '13', catorce: '14', quince: '15', dieciseis: '16', diecisiete: '17',
  dieciocho: '18', diecinueve: '19', veinte: '20', veinticinco: '25', treinta: '30',
};
function digitalizar(t) {
  let s = t;
  // "VG cero cinco" -> "VG05"
  s = s.replace(/\b(vg|vh)\s*((?:(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinticinco|treinta)\s*)+)/gi,
    (_, pre, pal) => pre + pal.trim().split(/\s+/).map(p => NUM[n(p)] ?? '').join('') + ' ');
  return s;
}

const DIA_NOMBRE = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };

function diasMencionados(t) {
  const out = [];
  for (const [nom, num] of Object.entries(DIA_NOMBRE)) if (new RegExp(`\\b${nom}`).test(t)) out.push(num);
  return [...new Set(out)];
}

function asignaturaMencionada(t) {
  const cands = [...new Set(H.BASE.map(c => c.asignatura))];
  // primero por nombre completo/parcial
  for (const a of cands) {
    const na = n(a);
    if (t.includes(na)) return a;
    const primera = na.split(' ')[0];
    if (primera.length > 4 && t.includes(primera)) return a;
  }
  // luego por alias (algebra, bd, tpa, circuitos...)
  const c = H.canon(t);
  for (const a of cands) if (H.mismaAsignatura(a, c) && c.length > 2) return a;
  return null;
}

// ---------- 1. INTENCIONES DE CONSULTA (respuesta local) ----------
function consulta(texto) {
  const t0 = n(texto);
  if (!t0) return null;
  const t = sinMuletillas(t0);

  if (/^(\/?ayuda|\/?help|\/?start|menu|que sabes hacer|que puedes hacer|comandos)\b/.test(t)) return { tipo: 'ayuda' };
  if (/(mis cambios|mis ajustes|que he cambiado|mi config|mis overrides|cambios que se han hecho|cambios hechos|ultimos cambios|que cambios hay|los cambios)/.test(t)) return { tipo: 'miscambios' };
  if (/^(deshacer|undo|revertir|quitar ultimo)\b/.test(t)) return { tipo: 'deshacer' };
  if (/^(resetear|reset|restaurar|volver al horario oficial)\b/.test(t)) return { tipo: 'reset' };

  // El curso entero: las asignaturas de los dos semestres.
  if (/\b(todas? (mis |las )?asignaturas|todo el curso|asignaturas del curso|cuantas asignaturas|asignaturas en total|todas las clases del curso)\b/.test(t)) {
    return { tipo: 'todas' };
  }

  // Un semestre concreto pedido por su nombre, en cualquiera de las dos formas.
  const sem = semestreMencionado(t);
  if (sem && /\b(asignatura|asignaturas|horario|clases|tengo|toca|cursa|curso|hay)\b/.test(t)) {
    return { tipo: 'semestre', n: sem };
  }

  // Una fecha concreta del curso, aunque sea de otro semestre.
  const iso = fechaExacta(texto);
  if (iso) return { tipo: 'fechaexacta', iso };

  // Más específico que las reglas de día: "lo que queda hoy" contiene "hoy",
  // así que debe resolverse antes o se lo come la regla de la fecha.
  if (/\b(lo que queda|las que queden|las que quedan|las que faltan|que me queda|que queda|me falta|restantes|quedan)\b/.test(t)) return { tipo: 'restantes' };

  if (/\b(ahora|en este momento|que toca ahora)\b/.test(t)) return { tipo: 'ahora' };
  if (/\b(siguiente|proxima clase|proxima|que toca luego|luego)\b/.test(t)) return { tipo: 'siguiente' };
  if (/\b(pasado manana)\b/.test(t)) return { tipo: 'fecha', offset: 2 };
  if (/\b(manana)\b/.test(t)) return { tipo: 'fecha', offset: 1 };
  if (/\b(ayer)\b/.test(t)) return { tipo: 'fecha', offset: -1 };
  if (/\b(hoy|que tengo|que clases tengo|clases de hoy)\b/.test(t) && !/manana|semana/.test(t)) return { tipo: 'fecha', offset: 0 };
  if (/\b(semana|esta semana|toda la semana)\b/.test(t)) return { tipo: 'semana' };
  if (/\b(horario completo|todo el horario|mi horario)\b/.test(t)) return { tipo: 'semana' };
  if (/\b(examenes|examen|eventos|deberes|entregas|avisos)\b/.test(t)) return { tipo: 'eventos' };
  if (/\b(que semana|en que semana)\b/.test(t)) return { tipo: 'semananum' };

  // Saludos y cortesías: responder en local evita una llamada al modelo por
  // cada "hola", que es de lo más frecuente que recibe un bot.
  if (/^(hola|buenas|hey|ey|holi|buenos dias|buenas tardes|buenas noches|que tal|jeff)\b/.test(t) && t.split(/\s+/).length <= 4) return { tipo: 'saludo' };
  if (/^(gracias|grac[ia]s|thx|ok|vale|genial|perfecto|guay)\b/.test(t) && t.split(/\s+/).length <= 3) return { tipo: 'gracias' };

  // Continuaciones: "y la de después", "y luego"
  if (/^(y (la )?(de )?(despues|luego|siguiente|la otra)|y luego|y despues|y ahora)\b/.test(t)) return { tipo: 'siguiente' };

  // "hora de clase", "clases", "horario" a secas -> el día de hoy
  if (/^(hora de clase|horas de clase|clases|clase|horario|mi horario de hoy)\b/.test(t) && t.split(/\s+/).length <= 4) return { tipo: 'fecha', offset: 0 };
  if (/\b(festivos|vacaciones|puente)\b/.test(t)) return { tipo: 'festivos' };

  return null;
}

// Consulta DÉBIL: ambigua con una propuesta de cambio ("... el lunes"), así que
// el router la evalúa DESPUÉS de intentar interpretar el mensaje como cambio.
function consultaDebil(texto) {
  const t = sinMuletillas(n(texto));
  const dias = diasMencionados(t);
  if (dias.length === 1 && /\b(que hay|que tengo|clases|horario|el|los)\b/.test(t)) return { tipo: 'diasemana', dia: dias[0] };
  if (dias.length === 1 && t.split(/\s+/).length <= 3) return { tipo: 'diasemana', dia: dias[0] };
  return null;
}

// ---------- 2. PROPUESTAS DE CAMBIO ----------
// Devuelve { tipo, match, set, resumen } o null.
function cambio(texto) {
  const raw = digitalizar(texto);
  const t = n(raw);

  // "el aula de X es la 12" / "el aula de X pasa a ser B12"
  // Acepta cualquier nombre de aula, no solo el formato de una facultad concreta.
  const mAula = raw.match(/\baula\s+de\s+([^,.]+?)\s+(?:ya\s+)?(?:es|ser[áa]|pasa a ser|cambia a|ahora es)\s+(?:la\s+|el\s+)?([A-Za-z0-9.\-]{1,12})/i);
  if (mAula) {
    const asigA = asignaturaMencionada(n(mAula[1])) || mAula[1].trim();
    const nuevaAula = mAula[2].toUpperCase().replace(/[.,]$/, '');
    return {
      tipo: 'aula',
      match: { asignatura: asigA },
      set: { edificio: nuevaAula },
      resumen: `${asigA} pasa al aula *${nuevaAula}*`,
    };
  }
  const EDIF = /\b(v[gh]\s?\d{1,2})\b/gi;
  const edificios = (raw.match(EDIF) || []).map(e => e.replace(/\s+/g, '').toUpperCase());
  const asig = asignaturaMencionada(t);
  const dias = diasMencionados(t);

  // "la VG30 no es la VG05"  /  "no es VG05, es VG30"
  if (edificios.length === 2) {
    let correcto, incorrecto;
    if (/\bno es\b/.test(t)) {
      const i = t.indexOf('no es');
      const antes = n(raw.slice(0, i)), despues = n(raw.slice(i));
      const eA = (antes.match(/v[gh]\s?\d{1,2}/g) || []).map(x => x.replace(/\s/g, '').toUpperCase());
      const eD = (despues.match(/v[gh]\s?\d{1,2}/g) || []).map(x => x.replace(/\s/g, '').toUpperCase());
      if (eA.length && eD.length) { correcto = eA[0]; incorrecto = eD[0]; }
      else { correcto = edificios[0]; incorrecto = edificios[1]; }
    } else { incorrecto = edificios[0]; correcto = edificios[1]; }
    if (correcto && incorrecto && correcto !== incorrecto) {
      return {
        tipo: 'aula',
        match: { edificio: incorrecto, ...(asig ? { asignatura: asig } : {}), ...(dias.length === 1 ? { dia: dias[0] } : {}) },
        set: { edificio: correcto },
        resumen: `${asig ? asig + ': ' : ''}aula ${incorrecto} → *${correcto}*`,
      };
    }
  }

  // "álgebra es en VG30" / "álgebra pasa a VG30" / "álgebra en el VH09"
  if (asig && edificios.length === 1 && /\b(es en|esta en|pasa a|cambia a|se hace en|en el|es la|va a|ahora en)\b/.test(t)) {
    return {
      tipo: 'aula',
      match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) },
      set: { edificio: edificios[0] },
      resumen: `${asig}${dias.length === 1 ? ' (' + H.DIAS[dias[0]] + ')' : ''} → aula *${edificios[0]}*`,
    };
  }

  // "no curso álgebra" / "me quito álgebra" / "quítame bases de datos"
  if (asig && /\b(no curso|no tengo|no hago|no voy a|me quito|quitame|quitar|borrar|elimina|saca)\b/.test(t)) {
    return { tipo: 'quitar', match: { asignatura: asig }, set: {}, resumen: `quitar *${asig}*` };
  }

  // "solo voy martes y jueves" / "solo asisto los lunes"
  if (/\b(solo voy|solo asisto|unicamente voy|solo tengo clase)\b/.test(t) && dias.length) {
    const quitar = [1, 2, 3, 4, 5].filter(d => !dias.includes(d));
    return {
      tipo: 'solodias', dias, quitar, match: {}, set: {},
      resumen: `ir solo ${dias.map(d => H.DIAS[d]).join(', ')} (se quitan ${quitar.map(d => H.DIAS[d]).join(', ')})`,
    };
  }

  // "se cancela álgebra" / "no hay clase de bases de datos"
  if (asig && /\b(se cancela|se suspende|no hay clase|anulada|cancelada|se anula)\b/.test(t)) {
    return { tipo: 'cancelar', match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) }, set: {}, resumen: `marcar *${asig}* como anulada` };
  }

  // "álgebra a las 16:30"
  const mh = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (asig && mh && /\b(a las|empieza|pasa a las|cambia a las|es a las)\b/.test(t)) {
    const hora = `${mh[1].padStart(2, '0')}:${mh[2]}`;
    return { tipo: 'hora', match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) }, set: { inicio: hora }, resumen: `*${asig}* empieza a las *${hora}*` };
  }

  return null;
}


// ---------- 2.bis AÑADIR / RECUPERAR UNA ASIGNATURA ----------
// Acepta desde lo telegráfico ("ponme Redes") hasta lo natural
// ("yo tengo una asignatura llamada Redes en la clase 205 los martes a las 16:30").
// El aula puede llamarse como sea: VH09, 205, B12, "Lab 3".
const V_FUERTE = /\b(ponme|pon|ponedme|a[ñn]ade|a[ñn][aá]deme|a[ñn]adir|agrega|agr[ée]game|dame|m[ée]teme|mete)\b/i;
const V_DEBIL  = /\b(yo tengo|tengo|yo curso|curso|yo hago|hago|yo s[ií]|s[ií] tengo|s[ií] curso|la tengo yo|yo la tengo)\b/i;
const MARCA_NOMBRE = /\b(llamad[ao]|asignatura|optativa)\b/i;

// Corta el nombre de la asignatura donde empieza a hablarse de día, hora o aula.
function cortarNombre(txt) {
  const marcas = [
    /\s+en\s+(?:la\s+|el\s+)?(?:clase|aula|laboratorio|lab|sala|edificio)\b/i,
    /\s+en\s+/i,
    /\s+(?:todos\s+)?los\s+(?:lunes|martes|mi[ée]rcoles|jueves|viernes)/i,
    /\s+(?:lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i,
    /\s+a\s+las\s+/i,
    /\s+de\s+\d{1,2}[:.]\d{2}/,
    /\s+\d{1,2}[:.]\d{2}/,
  ];
  let fin = txt.length;
  for (const m of marcas) { const i = txt.search(m); if (i >= 0 && i < fin) fin = i; }
  return txt.slice(0, fin).replace(/^\s*(una|un|la|el)\s+/i, '').replace(/[.,;]+$/, '').trim();
}

function extraerAula(raw) {
  let m = raw.match(/\ben\s+(?:la\s+|el\s+)?(?:clase|aula|laboratorio|lab|sala|edificio)\s+([A-Za-z0-9.\-]{1,12})/i);
  if (m) return m[1].toUpperCase();
  m = raw.match(/\b(v[gh]\s?\d{1,3})\b/i);                       // formato UEV
  if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  m = raw.match(/\ben\s+(?:el\s+|la\s+)?([A-Za-z]{0,3}\s?\d{1,4})\b/i);
  if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  return null;
}

function anadir(texto) {
  const raw = digitalizar(texto);
  const t = n(raw);

  const fuerte = V_FUERTE.test(raw);
  const debil = V_DEBIL.test(raw);
  const horas = [...raw.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)].map(m => `${m[1].padStart(2, '0')}:${m[2]}`);
  const marca = MARCA_NOMBRE.test(raw);

  // Afirmación explícita ("yo sí la curso"): no hace falta hora ni más contexto.
  const afirma = /\b(yo s[ií]|s[ií] (?:la )?(?:curso|tengo|hago)|yo (?:la )?(?:curso|tengo|hago))\b/i.test(raw);
  // "tengo" a secas solo cuenta si hay hora o se nombra la asignatura: si no,
  // "¿qué tengo hoy?" se interpretaría como un alta.
  if (!fuerte && !afirma && !(debil && (horas.length || marca))) return null;

  const dias = diasMencionados(t);
  const aula = extraerAula(raw);
  const deBase = asignaturaMencionada(t);

  // Nombre: tras "llamada/asignatura", o tras el verbo
  let libre = null;
  let m = raw.match(/\b(?:llamad[ao]|asignatura|optativa)\s+(.+)/i);
  if (m) libre = cortarNombre(m[1]);
  if (!libre) {
    const mv = raw.match(new RegExp('(?:' + V_FUERTE.source + '|' + V_DEBIL.source + ')\\s+(.+)', 'i'));
    if (mv) libre = cortarNombre(mv[mv.length - 1]);
  }
  if (libre) {
    libre = libre.replace(/\b(llamad[ao]|una|un|nuev[ao]|otra|otro|asignatura|optativa|obligatoria|materia|clase)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (libre) libre = libre[0].toUpperCase() + libre.slice(1);
  }

  const asignatura = deBase || (libre && libre.length > 2 ? libre : null);
  if (!asignatura) return null;

  // Existe en el horario oficial y no se dan detalles -> recuperarla tal cual
  if (deBase && !horas.length && !dias.length) {
    return { tipo: 'recuperar', asignatura: deBase, resumen: `recuperar *${deBase}* con su horario oficial` };
  }

  if (!dias.length || !horas.length) {
    return {
      tipo: 'anadir-incompleto', asignatura,
      falta: !dias.length && !horas.length ? 'el día y la hora' : (!dias.length ? 'el día' : 'la hora'),
    };
  }

  const inicio = horas[0];
  const fin = horas[1] || sumarDosHoras(inicio);
  const nom = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return {
    tipo: 'anadir', asignatura, dias, inicio, fin, aula,
    resumen: `añadir *${asignatura}* los ${dias.map(d => nom[d]).join(' y ')} a las ${inicio}${aula ? ` en ${aula}` : ''}`,
  };
}

function sumarDosHoras(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


// ---------- FECHAS CONCRETAS Y SEMESTRES ----------
const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// "12 de abril", "3 de marzo de 2027", "12/04", "12-04-2027".
// El año se deduce del curso: los meses anteriores a su inicio caen en el
// siguiente año natural, que es como se habla de un curso académico.
function fechaExacta(texto) {
  const t = n(texto);
  let dia = null, mes = null, anio = null;

  let m = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de(?:l)?\s+(\d{4}))?/);
  if (m && MESES[m[2]]) { dia = +m[1]; mes = MESES[m[2]]; anio = m[3] ? +m[3] : null; }

  if (!mes) {
    m = t.match(/\b(\d{1,2})[\/](\d{1,2})(?:[\/](\d{2,4}))?\b/);
    if (m) { dia = +m[1]; mes = +m[2]; anio = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null; }
  }

  if (!mes || !dia || dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;

  if (!anio) {
    const [y0, m0] = H.calendario.semestres[0].inicio.split('-').map(Number);
    anio = mes >= m0 ? y0 : y0 + 1;
  }
  const iso = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const [yy, mm, dd] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(yy, mm - 1, dd));
  if (d.getUTCMonth() + 1 !== mm || d.getUTCDate() !== dd) return null;   // 31 de febrero
  return iso;
}

// El estudiante cursa 2o, así que su semestre 1 es también el "tercero" de la
// carrera y el 2 el "cuarto". Ambas formas deben valer.
function semestreMencionado(texto, isoHoy) {
  const t = n(texto);
  if (!/\b(semestre|cuatrimestre|cuatri)\b/.test(t)) return null;

  const actual = H.semestreDe(isoHoy || H.hoyISO());
  if (/\b(que viene|proximo|siguiente|el otro|despues)\b/.test(t)) {
    return actual && actual.n === 1 ? 2 : 1;
  }
  if (/\b(este|actual|en el que estoy|de ahora)\b/.test(t) && actual) return actual.n;
  if (/\b(primer|primero|1er|1o|tercer|tercero|3er|3o)\b/.test(t)) return 1;
  if (/\b(segundo|2o|2do|cuarto|4o|4to)\b/.test(t)) return 2;
  if (/\b(semestre|cuatrimestre)\s*(1|3)\b/.test(t)) return 1;
  if (/\b(semestre|cuatrimestre)\s*(2|4)\b/.test(t)) return 2;
  return null;
}


// ---------- TAREAS PERSONALES ----------
// Devuelve la acción y el texto al que se refiere. Quien decide si ese texto
// corresponde a una tarea real es el router, que es quien puede mirarlas: aquí
// solo se interpreta la frase.
const T_NUEVA = /^(?:ap[uú]nta(?:me)?|apuntar|an[oó]ta(?:me)?|recu[eé]rda(?:me)?|tengo que|tengo pendiente|debo|hay que|quiero hacer|me toca hacer|tarea|deberes)\s*:?\s*(.+)/i;
const T_LISTAR = /\b(mis tareas|mi lista|que tengo que hacer|que me queda por hacer|tareas pendientes|mis pendientes|lista de tareas|mis deberes|que tengo pendiente)\b/;
const T_HECHA = /^(?:ya\s+)?(?:lo\s+|la\s+|las\s+|los\s+)?(?:he\s+)?(?:hice|hecho|termin[eé]|terminado|acab[eé]|acabado|complet[eé]|completado|finalic[eé]|listo|est[aá] hecho|est[aá]n hechas)\s*(?:lo\s+de\s+|la\s+|el\s+|los\s+|las\s+)?(.*)$/i;
const T_QUITAR = /^(?:qu[ií]ta(?:me)?|quitar|borra(?:me)?|borrar|elimina|olvida(?:te de)?|descarta|no voy a hacer|paso de|cancela)\s+(?:la\s+|el\s+|lo\s+de\s+|los\s+|las\s+)?(.+)/i;

// "ya está todo", "todo hecho", "todas hechas": completar la lista entera.
const T_TODO = /^(?:ya\s+)?(?:est[aá]n?\s+)?(?:todo|todas|todos)(?:\s+(?:hecho|hechas|hechos|listo|listas|listos))?\s*$/i;

function tarea(texto) {
  const t = n(texto);
  if (T_LISTAR.test(t)) return { accion: 'listar' };
  if (T_TODO.test(texto.trim())) return { accion: 'hecha', ref: 'todo' };

  let m = texto.match(T_HECHA);
  if (m) return { accion: 'hecha', ref: (m[1] || '').trim() };

  m = texto.match(T_NUEVA);
  if (m && m[1].trim().length > 2) return { accion: 'nueva', texto: m[1].trim() };

  // "quita X" es ambiguo: X puede ser una tarea o una asignatura. Se marca como
  // dudoso para que el router lo compruebe contra las tareas reales antes de
  // decidir; si no es ninguna, sigue su camino como cambio de horario.
  m = texto.match(T_QUITAR);
  if (m && m[1].trim().length > 1) {
    return { accion: 'quitar', ref: m[1].trim(), dudoso: !!asignaturaMencionada(n(m[1])) };
  }
  return null;
}

// ---------- 3. RESPUESTA AL ALCANCE ----------
function alcance(texto) {
  const t = n(texto);
  if (/^(1|1⃣|solo yo|solo para mi|para mi|mio|yo|personal|solo a mi)\b/.test(t)) return 'personal';
  if (/^(2|2⃣|todos|para todos|toda la clase|global|a todos)\b/.test(t)) return 'global';
  if (/^(0|no|cancelar|nada|dejalo|olvidalo)\b/.test(t)) return 'cancelar';
  return null;
}

module.exports = { consulta, consultaDebil, cambio, anadir, tarea, alcance, fechaExacta, semestreMencionado, asignaturaMencionada, diasMencionados, digitalizar, n };
