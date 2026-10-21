// AGENDA: ejecuta lo que se interpreta en agenda-intent, responde con formato
// limpio y manda los avisos a su hora.
//
// Todo es de cada persona. Nada de aquí consulta la agenda de otro, y las
// respuestas se construyen en local: el modelo solo interviene para entender
// frases raras, nunca para decidir qué se borra o se marca.
const agenda = require('./agenda');
const AI = require('./agenda-intent');
const T = require('./tiempo');
const I = require('./intent');
const usuarios = require('./usuarios');
const log = require('./log');
const cfg = require('./config');

// Preguntas que Jeff deja abiertas: confirmar un borrado, de cuánto es un
// temporizador, cuándo avisar de algo... Una por persona y caducan solas.
const esperas = new Map();
const VIDA_ESPERA = 10 * 60 * 1000;
const esperar = (jid, e) => esperas.set(jid, { ...e, ts: Date.now() });
const cancelarEspera = jid => esperas.delete(jid);
const hayEspera = jid => {
  const e = esperas.get(jid);
  return !!e && Date.now() - e.ts < VIDA_ESPERA;
};

const norm = s => T.plano(String(s || '')).replace(/\s+/g, ' ').trim();
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

const AYUDA = `*Tareas*
tengo que entregar la práctica el viernes
apunta comprar pan
mis tareas
hecha 2
desmarca 2
borra la 3
limpia las hechas

*Recordatorios*
recuérdame en 20 minutos sacar la ropa
avísame mañana a las 9 de llamar al médico
recuérdame todos los lunes a las 8 sacar la basura
pon una alarma a las 7
temporizador de 25 minutos
mis recordatorios
pospón 10 minutos

*Notas*
nota: el wifi de la biblio es eduroam
mis notas
borra la nota 2

*Borrar*
olvida las tareas
borra mis notas
borra todo
olvida la conversación

Lo que borras desaparece de verdad, no se puede recuperar.
Lo tuyo solo lo ves tú.`;

// ---------------- formato ----------------
function etiquetaPara(iso) {
  const hoy = T.isoDe(Date.now());
  if (iso < hoy) return 'atrasada';
  return T.etiquetaDia(iso);
}

function textoTareas(jid, cab = '*Tareas*') {
  const l = agenda.tareas(jid);
  if (!l.length) return 'No tienes tareas apuntadas.';
  const lineas = l.map((t, i) => t.hecha
    ? `${i + 1} ~${t.texto}~`
    : `${i + 1} ${t.texto}${t.para ? ` _${etiquetaPara(t.para)}_` : ''}`);
  return `${cab}\n${lineas.join('\n')}`;
}

function textoNotas(jid) {
  const l = agenda.notas(jid);
  if (!l.length) return 'No tienes notas.';
  return `*Notas*\n${l.map((n, i) => `${i + 1} ${n.texto}`).join('\n')}`;
}

function lineaRecordatorio(r, ahora = Date.now()) {
  if (r.tipo === 'temporizador') {
    return `*${T.horaDe(r.ts)}* temporizador de ${T.duracionTexto(r.duracionMs)}${r.texto ? `, ${r.texto.charAt(0).toLowerCase() + r.texto.slice(1)}` : ''}`;
  }
  const cuando = r.repetir ? T.repeticionTexto(r.repetir) : T.corto(r.ts, ahora);
  return `*${cuando}* ${r.texto}`;
}

function textoRecordatorios(jid) {
  const l = agenda.recordatorios(jid);
  if (!l.length) return 'No tienes recordatorios.';
  return `*Recordatorios*\n${l.map((r, i) => `${i + 1} ${lineaRecordatorio(r)}`).join('\n')}`;
}

function textoTodo(jid) {
  const partes = [];
  if (agenda.tareas(jid).length) partes.push(textoTareas(jid));
  if (agenda.recordatorios(jid).length) partes.push(textoRecordatorios(jid));
  if (agenda.notas(jid).length) partes.push(textoNotas(jid));
  if (!partes.length) return 'No tienes nada apuntado.\n\nEscribe *ayuda agenda* para ver lo que puedo apuntarte.';
  return partes.join('\n\n');
}

const confirmacionAviso = (r, ahora = Date.now()) => {
  if (r.repetir) {
    const prox = T.cuando(r.ts, ahora);
    return `Te aviso ${T.repeticionTexto(r.repetir)}: *${r.texto}*\n\nLa próxima, ${prox}.`;
  }
  return `Te aviso ${T.cuando(r.ts, ahora)}: *${r.texto}*`;
};

// ---------------- referencias ----------------
// Busca en una lista numerada (la misma numeración que ve la persona).
function resolver(lista, ref) {
  if (!ref || ref.vacio) return { items: [] };
  if (ref.nums) {
    const items = ref.nums.map(n => lista[n - 1]);
    const malos = ref.nums.filter((n, i) => !items[i]);
    return { items: items.filter(Boolean), malos };
  }
  const q = norm(ref.texto);
  if (!q) return { items: [] };
  const exactas = lista.filter(x => norm(x.texto) === q);
  if (exactas.length) return { items: exactas };
  if (q.length < 3) return { items: [] };
  const parciales = lista.filter(x => norm(x.texto).includes(q) || (q.includes(norm(x.texto)) && norm(x.texto).length >= 3));
  return { items: parciales, varias: parciales.length > 1 };
}

const numeroDe = (lista, x) => lista.indexOf(x) + 1;

// ---------------- ejecución ----------------
function ejecutar(jid, a, ahora = Date.now()) {
  switch (a.tipo) {
    case 'ayuda': return { texto: AYUDA };

    case 'olvidar_conversacion':
      return { texto: 'Hecho, he olvidado nuestra conversación. Tus tareas, notas y recordatorios siguen igual.', olvidarConversacion: true };

    case 'borrar_todo': {
      const n = { t: agenda.tareas(jid).length, n: agenda.notas(jid).length, r: agenda.recordatorios(jid).length };
      const que = [];
      if (n.t) que.push(plural(n.t, 'tarea', 'tareas'));
      if (n.n) que.push(plural(n.n, 'nota', 'notas'));
      if (n.r) que.push(plural(n.r, 'recordatorio', 'recordatorios'));
      que.push('nuestra conversación');
      const lista = que.length > 1 ? `${que.slice(0, -1).join(', ')} y ${que.at(-1)}` : que[0];
      esperar(jid, { tipo: 'confirmar', que: 'todo' });
      return { texto: `Voy a borrar ${lista}. Tu horario no se toca.\n\nNo se puede deshacer. Responde *sí* para borrarlo.`, espera: true };
    }

    case 'repaso':
      agenda.ajustar(jid, 'repaso', a.activo);
      return { texto: a.activo
        ? `Hecho. Cada noche a las ${cfg.HORA_REPASO ?? 21}:00 te recuerdo las tareas que te queden.`
        : 'Hecho, ya no te mando el repaso de la noche. Si lo quieres de vuelta: activa el repaso.' };

    case 'listar':
      if (a.que === 'notas') return { texto: textoNotas(jid) };
      if (a.que === 'recordatorios') return { texto: textoRecordatorios(jid) };
      if (a.que === 'todo') return { texto: textoTodo(jid) };
      return { texto: textoTareas(jid) };

    case 'limpiar_hechas': {
      const n = agenda.limpiarHechas(jid);
      if (!n) return { texto: 'No tenías tareas hechas.' };
      const quedan = agenda.tareas(jid).length;
      return { texto: `${n === 1 ? 'Quitada' : 'Quitadas'} ${plural(n, 'tarea hecha', 'tareas hechas')}.${quedan ? `\n\n${textoTareas(jid)}` : ''}` };
    }

    case 'borrar_coleccion': {
      const col = a.coleccion;
      const lista = col === 'tareas' ? agenda.tareas(jid) : col === 'notas' ? agenda.notas(jid) : agenda.recordatorios(jid);
      const nombre = { tareas: 'tareas', notas: 'notas', recordatorios: 'recordatorios' }[col];
      if (!lista.length) return { texto: `No tienes ${nombre}.` };
      if (col === 'tareas') {
        const hechas = lista.filter(t => t.hecha).length;
        if (hechas && hechas < lista.length) {
          esperar(jid, { tipo: 'confirmar', que: 'tareas', opciones: true });
          return { texto: `Tienes ${plural(lista.length, 'tarea', 'tareas')}, ${hechas} ya ${hechas === 1 ? 'hecha' : 'hechas'}.\n\n*1* borrarlas todas\n*2* solo las hechas\n*0* nada\n\nLo que se borra no se puede recuperar.`, espera: true };
        }
      }
      esperar(jid, { tipo: 'confirmar', que: col });
      const unico = { tareas: 'tu única tarea', notas: 'tu única nota', recordatorios: 'tu único recordatorio' }[col];
      return { texto: `Voy a borrar ${lista.length === 1 ? unico : `tus ${lista.length} ${nombre}`}.\n\nNo se puede deshacer. Responde *sí* para borrarlo.`, espera: true };
    }

    case 'posponer': {
      const ua = agenda.ultimoAviso(jid);
      if (!ua || ahora - ua.ts > 12 * 3600000) return null;
      const ts = a.ts || ahora + 10 * 60000;
      const texto = ua.texto || (ua.tipo === 'temporizador' ? `Temporizador de ${T.duracionTexto(ua.duracionMs)}` : 'Recordatorio');
      const r = agenda.crearRecordatorio(jid, { texto, ts });
      return { texto: `Vale, te lo vuelvo a recordar ${T.cuando(r.ts, ahora)}.` };
    }

    case 'temporizador': {
      if (!a.ms) {
        esperar(jid, { tipo: 'duracion', texto: a.texto || '' });
        return { texto: '¿De cuánto? Por ejemplo: 10 minutos.', espera: true };
      }
      if (a.ms < 10000) return { texto: 'Eso es demasiado corto para un temporizador.' };
      const r = agenda.crearRecordatorio(jid, { texto: a.texto || '', ts: ahora + a.ms, tipo: 'temporizador', duracionMs: a.ms });
      return { texto: `Temporizador de ${T.duracionTexto(a.ms)}${r.texto ? ` para ${r.texto.charAt(0).toLowerCase() + r.texto.slice(1)}` : ''}. Suena a las ${T.horaDe(r.ts)}.` };
    }

    case 'nota_nueva': {
      if (!a.texto) { esperar(jid, { tipo: 'nota' }); return { texto: '¿Qué apunto?', espera: true }; }
      const n = agenda.crearNota(jid, a.texto);
      const total = agenda.notas(jid).length;
      return { texto: `Guardado en notas: ${n.texto}${total > 1 ? `\n\nTienes ${total} notas.` : ''}` };
    }

    case 'recordatorio_nuevo': {
      if (!a.texto) {
        esperar(jid, { tipo: 'que', ts: a.ts, repetir: a.repetir });
        return { texto: `¿De qué te aviso ${a.repetir ? T.repeticionTexto(a.repetir) : T.cuando(a.ts, ahora)}?`, espera: true };
      }
      const r = agenda.crearRecordatorio(jid, { texto: a.texto, ts: a.ts, repetir: a.repetir });
      esperar(jid, { tipo: 'ajustar', id: r.id });
      let t = confirmacionAviso(r, ahora);
      if (a.horaPorDefecto) t += '\n\nSi lo quieres a otra hora, dímela.';
      return { texto: t };
    }

    case 'recordatorio_sin_nada':
      return { texto: '¿De qué te aviso y cuándo? Por ejemplo: recuérdame mañana a las 9 llamar al médico.' };

    case 'hora_pasada':
      if (a.texto) esperar(jid, { tipo: 'cuando', texto: a.texto });
      return { texto: 'Esa hora ya ha pasado. Dime otra, por ejemplo: en una hora, mañana a las 9.', espera: !!a.texto };

    case 'tarea_vacia':
      esperar(jid, { tipo: 'tarea' });
      return { texto: '¿Qué apunto?', espera: true };

    case 'tarea_nueva': {
      const creadas = a.textos.map(t => agenda.crearTarea(jid, t, a.para || null));
      const pend = agenda.pendientes(jid).length;
      if (a.preguntarCuando && creadas.length === 1) {
        esperar(jid, { tipo: 'cuando', texto: creadas[0].texto, tareaId: creadas[0].id });
        return { texto: `Apuntado en tareas: ${creadas[0].texto}${a.para ? ` _${etiquetaPara(a.para)}_` : ''}\n\nSi quieres que te avise, dime cuándo: en una hora, mañana a las 9...`, espera: true };
      }
      if (creadas.length > 1) return { texto: `Apuntadas ${creadas.length} tareas.\n\n${textoTareas(jid)}` };
      const x = creadas[0];
      return { texto: `Apuntado: ${x.texto}${x.para ? ` _${etiquetaPara(x.para)}_` : ''}\n\nTienes ${plural(pend, 'tarea pendiente', 'tareas pendientes')}.` };
    }

    case 'hecha': return marcar(jid, a.ref, ahora);
    case 'reabrir': return desmarcar(jid, a.ref);
    case 'borrar_uno': return borrarUno(jid, a);
  }
  return null;
}

// Devuelve null cuando la frase no apunta a ninguna tarea real, para que el
// router siga su camino: "he terminado la clase" no es una tarea.
function marcar(jid, ref, ahora) {
  const todas = agenda.tareas(jid);
  const pend = todas.filter(t => !t.hecha);
  if (!todas.length) return null;

  if (ref.todo) {
    if (!pend.length) return { texto: 'No tenías nada pendiente.' };
    pend.forEach(t => agenda.completar(jid, t.id));
    return { texto: `Hecho, ${plural(pend.length, 'tarea completada', 'tareas completadas')}.\n\n${textoTareas(jid)}` };
  }
  if (ref.vacio) {
    if (pend.length === 1) {
      agenda.completar(jid, pend[0].id);
      return { texto: `Hecho: ${pend[0].texto}\n\n${textoTareas(jid)}` };
    }
    if (!pend.length) return null;
    esperar(jid, { tipo: 'elegir', accion: 'hecha' });
    return { texto: `¿Cuál?\n\n${textoTareas(jid)}`, espera: true };
  }

  // Por número vale cualquiera de la lista; por texto, primero las pendientes.
  let { items, malos, varias } = ref.nums ? resolver(todas, ref) : resolver(pend, ref);
  if (ref.nums && malos && malos.length) return { texto: `No tengo la ${malos.join(', ')}.\n\n${textoTareas(jid)}` };
  if (!items.length) return null;
  if (varias) {
    esperar(jid, { tipo: 'elegir', accion: 'hecha' });
    return { texto: `Encajan varias, dime el número:\n\n${items.map(x => `${numeroDe(todas, x)} ${x.texto}`).join('\n')}`, espera: true };
  }
  const hechas = items.filter(x => agenda.completar(jid, x.id));
  if (!hechas.length) return { texto: `Ya estaba hecha.\n\n${textoTareas(jid)}` };
  return { texto: `Hecho: ${hechas.map(x => x.texto).join(', ')}\n\n${textoTareas(jid)}` };
}

function desmarcar(jid, ref) {
  const todas = agenda.tareas(jid);
  const hechas = todas.filter(t => t.hecha);
  if (!hechas.length) return ref.nums ? { texto: 'No tienes tareas hechas.' } : null;
  const { items, malos } = ref.nums ? resolver(todas, ref) : resolver(hechas, ref);
  if (ref.nums && malos && malos.length) return { texto: `No tengo la ${malos.join(', ')}.` };
  if (!items.length) return null;
  const abiertas = items.filter(x => agenda.reabrir(jid, x.id));
  if (!abiertas.length) return { texto: `Esa no estaba hecha.\n\n${textoTareas(jid)}` };
  return { texto: `Vuelve a pendientes: ${abiertas.map(x => x.texto).join(', ')}\n\n${textoTareas(jid)}` };
}

function borrarUno(jid, a) {
  const listas = {
    tareas: agenda.tareas(jid),
    notas: agenda.notas(jid),
    recordatorios: agenda.recordatorios(jid),
  };
  const quitar = { tareas: agenda.borrarTarea, notas: agenda.borrarNota, recordatorios: agenda.borrarRecordatorio };
  const despues = { tareas: textoTareas, notas: textoNotas, recordatorios: textoRecordatorios };
  const ref = a.ref || { vacio: true };

  // "cancela el temporizador" sin decir cuál: vale si solo hay uno.
  if (ref.vacio) {
    if (a.coleccion !== 'recordatorios') return null;
    const l = listas.recordatorios;
    if (!l.length) return { texto: 'No tienes recordatorios.' };
    if (l.length === 1) { quitar.recordatorios(jid, l[0].id); return { texto: `Cancelado: ${l[0].texto || 'temporizador'}` }; }
    esperar(jid, { tipo: 'elegir', accion: 'borrar', coleccion: 'recordatorios' });
    return { texto: `¿Cuál?\n\n${textoRecordatorios(jid)}`, espera: true };
  }

  // "quita álgebra" habla del horario salvo que haya una tarea que se llame así.
  const dudoso = !a.coleccion && ref.texto && !!I.asignaturaMencionada(I.n(ref.texto));

  let col = a.coleccion;
  let res = null;
  if (col) res = resolver(listas[col], ref);
  else if (ref.nums) { col = 'tareas'; res = resolver(listas.tareas, ref); }
  else {
    // Sin decir dónde: se busca en las tres y vale si encaja en una sola.
    const hits = Object.entries(listas).map(([c, l]) => [c, resolver(l, ref)]).filter(([, r]) => r.items.length);
    if (hits.length === 1) [col, res] = hits[0];
    else if (hits.length > 1) {
      return { texto: `Eso aparece en varios sitios. Dime cuál: borra la tarea ..., borra la nota ... o borra el recordatorio ...` };
    }
  }
  if (!res || !res.items.length) {
    if (ref.nums && col && res && res.malos && res.malos.length && listas[col].length) {
      return { texto: `No tengo ${col === 'notas' ? 'la nota' : col === 'tareas' ? 'la tarea' : 'el recordatorio'} ${res.malos.join(', ')}.\n\n${despues[col](jid)}` };
    }
    return a.coleccion && !dudoso ? { texto: `No encuentro eso en tus ${a.coleccion}.\n\n${despues[a.coleccion](jid)}` } : null;
  }
  if (dudoso && !res.items.every(x => norm(x.texto) === norm(ref.texto))) return null;
  if (res.varias) {
    esperar(jid, { tipo: 'elegir', accion: 'borrar', coleccion: col });
    return { texto: `Encajan varias, dime el número:\n\n${res.items.map(x => `${numeroDe(listas[col], x)} ${x.texto || 'temporizador'}`).join('\n')}`, espera: true };
  }
  const borrados = res.items.map(x => quitar[col](jid, x.id)).filter(Boolean);
  const queda = despues[col](jid);
  const vacia = /^No tienes/.test(queda);
  return { texto: `Borrado: ${borrados.map(x => x.texto || 'temporizador').join(', ')}${vacia ? '' : `\n\n${queda}`}` };
}

// ---------------- respuestas a una pregunta abierta ----------------
const SI = /^(?:si|sí|s|vale|ok|okay|confirmo|confirmado|dale|borra|borralo|borralas|adelante|hazlo|venga|claro|de acuerdo)\b/;
const NO = /^(?:no|nop|cancela|cancelar|nada|deja|dejalo|olvidalo|mejor no|0)\b/;

function responderEspera(jid, texto, e, ahora) {
  const q = norm(texto).replace(/[¿?¡!.]/g, '').trim();

  if (e.tipo === 'confirmar') {
    if (e.opciones && /^2\b|solo las hechas|las hechas/.test(q)) {
      cancelarEspera(jid);
      return ejecutar(jid, { tipo: 'limpiar_hechas' }, ahora);
    }
    if (SI.test(q) || /^1\b/.test(q) && e.opciones || /^(?:todas|todo)$/.test(q)) {
      cancelarEspera(jid);
      if (e.que === 'todo') {
        const r = agenda.borrarTodo(jid);
        log.info(`agenda: ${usuarios.nombreDe(jid)} lo ha borrado todo`);
        return { texto: 'Borrado. No queda nada tuyo: ni tareas, ni notas, ni recordatorios, ni nuestra conversación.', olvidarConversacion: true, borrado: r };
      }
      const n = agenda.vaciar(jid, e.que);
      return { texto: `Borrado. ${n === 1 ? 'Se ha ido' : 'Se han ido'} ${plural(n, e.que.replace(/s$/, ''), e.que)}.` };
    }
    if (NO.test(q)) { cancelarEspera(jid); return { texto: 'Vale, no borro nada.' }; }
    cancelarEspera(jid);
    return null;
  }

  if (e.tipo === 'elegir') {
    const r = AI.refs(texto);
    if (!r.nums) { cancelarEspera(jid); return null; }
    cancelarEspera(jid);
    if (e.accion === 'hecha') return marcar(jid, r, ahora);
    return borrarUno(jid, { coleccion: e.coleccion || 'tareas', ref: r });
  }

  // Si lo que llega es otra orden de agenda, manda la orden nueva.
  const otra = AI.interpretar(texto, ahora);

  if (e.tipo === 'duracion') {
    const d = T.buscarDuracion(T.plano(texto), { suelta: true });
    cancelarEspera(jid);
    if (!d) return null;
    return ejecutar(jid, { tipo: 'temporizador', ms: d.ms, texto: e.texto }, ahora);
  }

  if (e.tipo === 'cuando' || e.tipo === 'ajustar') {
    const t = T.extraer(texto, ahora);
    const resto = t ? AI.limpiarResto(quitarTramos(texto, t.spans)).replace(/^(?:mejor|pues|entonces|vale|no|ponlo|ponmelo|cambialo|que sea)\b/i, '').trim() : texto;
    // Solo cuenta si el mensaje es SOLO un momento ("mejor a las 10"). Para
    // cambiar uno ya creado hace falta una hora: "mañana" a secas es más
    // probable que sea una consulta del horario.
    const valido = t && resto.split(/\s+/).filter(Boolean).length <= 2 && (e.tipo === 'cuando' || t.hayHora || t.relativo);
    if (!valido) { cancelarEspera(jid); return null; }
    if (!t.ts) return { texto: 'Esa hora ya ha pasado. Dime otra.' };
    cancelarEspera(jid);
    if (e.tipo === 'ajustar') {
      const r = agenda.recordatorios(jid).find(x => x.id === e.id);
      if (!r) return null;
      const cambio = r.repetir && r.repetir.tipo !== 'intervalo'
        ? { repetir: { ...r.repetir, hora: T.horaDe(t.ts).padStart(5, '0') } }
        : { ts: t.ts };
      if (cambio.repetir) cambio.ts = T.siguienteRepeticion(cambio.repetir, ahora);
      const nuevo = agenda.actualizarRecordatorio(jid, r.id, cambio);
      return { texto: `Cambiado. ${confirmacionAviso(nuevo, ahora)}` };
    }
    // Una tarea que ahora tiene hora pasa a ser un aviso.
    if (e.tareaId) agenda.borrarTarea(jid, e.tareaId);
    const r = agenda.crearRecordatorio(jid, { texto: e.texto, ts: t.ts, repetir: t.repetir || null });
    return { texto: confirmacionAviso(r, ahora) };
  }

  if (otra) { cancelarEspera(jid); return null; }

  if (e.tipo === 'que') {
    cancelarEspera(jid);
    const r = agenda.crearRecordatorio(jid, { texto: AI.limpiarResto(texto), ts: e.ts, repetir: e.repetir });
    return { texto: confirmacionAviso(r, ahora) };
  }
  if (e.tipo === 'nota') {
    cancelarEspera(jid);
    return ejecutar(jid, { tipo: 'nota_nueva', texto: AI.limpiarResto(texto) }, ahora);
  }
  if (e.tipo === 'tarea') {
    cancelarEspera(jid);
    return ejecutar(jid, { tipo: 'tarea_nueva', textos: [AI.limpiarResto(texto)] }, ahora);
  }
  cancelarEspera(jid);
  return null;
}

function quitarTramos(o, spans) {
  let r = o;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) r = r.slice(0, a) + ' ' + r.slice(b);
  return r;
}

// ---------------- entrada ----------------
function manejar(jid, texto, ahora = Date.now()) {
  const e = esperas.get(jid);
  if (e) {
    if (ahora - e.ts > VIDA_ESPERA) cancelarEspera(jid);
    else {
      const r = responderEspera(jid, texto, e, ahora);
      if (r) return r;
    }
  }
  const a = AI.interpretar(texto, ahora);
  if (!a) return null;
  return ejecutar(jid, a, ahora);
}

// ---------------- lo que entiende el modelo ----------------
// Para frases que suenan a agenda pero el intérprete local no supo leer. El
// modelo devuelve acciones; quien las ejecuta y redacta sigue siendo esto.
function contextoParaModelo(jid) {
  const l = agenda.tareas(jid);
  const t = l.length ? l.map((x, i) => `${i + 1}. ${x.hecha ? '[hecha] ' : ''}${x.texto}${x.para ? ` (para ${x.para})` : ''}`).join('\n') : '(ninguna)';
  const n = agenda.notas(jid);
  const nt = n.length ? n.map((x, i) => `${i + 1}. ${x.texto}`).join('\n') : '(ninguna)';
  const r = agenda.recordatorios(jid);
  const rt = r.length ? r.map((x, i) => `${i + 1}. ${x.texto || x.tipo} (${T.isoDe(x.ts)} ${T.horaDe(x.ts)}${x.repetir ? ', ' + T.repeticionTexto(x.repetir) : ''})`).join('\n') : '(ninguno)';
  return `TAREAS\n${t}\n\nNOTAS\n${nt}\n\nRECORDATORIOS\n${rt}`;
}

function desdeModelo(jid, acciones, ahora = Date.now()) {
  const salidas = [];
  let tocoTareas = false;
  const hechas = [], abiertas = [], borradas = [];
  const tareasAntes = agenda.tareas(jid);
  const notasAntes = agenda.notas(jid);
  const recAntes = agenda.recordatorios(jid);

  for (const ac of acciones) {
    const num = Number.isInteger(ac.num) ? ac.num : parseInt(ac.num, 10);
    switch (ac.tipo) {
      case 'tarea_nueva':
        if (ac.texto) {
          const para = /^\d{4}-\d{2}-\d{2}$/.test(ac.para || '') ? ac.para : null;
          const x = agenda.crearTarea(jid, ac.texto, para);
          salidas.push(`Apuntado: ${x.texto}${para ? ` _${etiquetaPara(para)}_` : ''}`);
        }
        break;
      case 'tarea_hecha': {
        const x = tareasAntes[num - 1];
        if (x && agenda.completar(jid, x.id)) { hechas.push(x.texto); tocoTareas = true; }
        break;
      }
      case 'tarea_reabrir': {
        const x = tareasAntes[num - 1];
        if (x && agenda.reabrir(jid, x.id)) { abiertas.push(x.texto); tocoTareas = true; }
        break;
      }
      case 'tarea_borrar': {
        const x = tareasAntes[num - 1];
        if (x && agenda.borrarTarea(jid, x.id)) { borradas.push(x.texto); tocoTareas = true; }
        break;
      }
      case 'nota_nueva':
        if (ac.texto) salidas.push(`Guardado en notas: ${agenda.crearNota(jid, ac.texto).texto}`);
        break;
      case 'nota_borrar': {
        const x = notasAntes[num - 1];
        if (x && agenda.borrarNota(jid, x.id)) salidas.push(`Borrada la nota: ${x.texto}`);
        break;
      }
      case 'recordatorio_nuevo': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ac.fecha || '') || !/^\d{1,2}:\d{2}$/.test(ac.hora || '')) break;
        const [h, m] = ac.hora.split(':').map(Number);
        let repetir = null;
        if (['diario', 'laborables'].includes(ac.repetir)) repetir = { tipo: ac.repetir, hora: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
        if (ac.repetir === 'semanal' && Array.isArray(ac.dias) && ac.dias.length) {
          repetir = { tipo: 'semanal', dias: ac.dias.map(Number).filter(d => d >= 0 && d <= 6), hora: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
        }
        let ts = T.instante(ac.fecha, h, m);
        if (repetir) ts = T.siguienteRepeticion(repetir, ahora - 1);
        if (ts <= ahora) { salidas.push('Esa hora ya ha pasado. Dime otra.'); break; }
        const r = agenda.crearRecordatorio(jid, { texto: ac.texto || 'Recordatorio', ts, repetir });
        salidas.push(confirmacionAviso(r, ahora));
        break;
      }
      case 'temporizador': {
        const ms = Math.round(Number(ac.minutos) * 60000);
        if (ms >= 10000) salidas.push(ejecutar(jid, { tipo: 'temporizador', ms, texto: ac.texto || '' }, ahora).texto);
        break;
      }
      case 'recordatorio_borrar': {
        const x = recAntes[num - 1];
        if (x && agenda.borrarRecordatorio(jid, x.id)) salidas.push(`Cancelado: ${x.texto || 'temporizador'}`);
        break;
      }
      case 'listar':
        salidas.push(ejecutar(jid, { tipo: 'listar', que: ac.que || 'todo' }, ahora).texto);
        break;
      case 'limpiar_hechas':
        salidas.push(ejecutar(jid, { tipo: 'limpiar_hechas' }, ahora).texto);
        break;
    }
  }
  if (hechas.length) salidas.push(`Hecho: ${hechas.join(', ')}`);
  if (abiertas.length) salidas.push(`Vuelve a pendientes: ${abiertas.join(', ')}`);
  if (borradas.length) salidas.push(`Borrado: ${borradas.join(', ')}`);
  if (!salidas.length) return null;
  if (tocoTareas && agenda.tareas(jid).length) salidas.push(textoTareas(jid));
  return { texto: salidas.join('\n\n') };
}

// Resumen para el modelo conversacional: así puede responder "¿cuál era el
// wifi de la biblio?" o "¿qué tenía que hacer mañana?". Solo lo de esta persona.
function resumenParaConversacion(jid) {
  if (!agenda.existe(jid)) return '';
  const partes = [];
  const pend = agenda.pendientes(jid);
  if (pend.length) partes.push('Tareas pendientes:\n' + pend.slice(0, 15).map(t => `- ${t.texto}${t.para ? ` (para ${t.para})` : ''}`).join('\n'));
  const rec = agenda.recordatorios(jid);
  if (rec.length) partes.push('Recordatorios programados:\n' + rec.slice(0, 10).map(r => `- ${lineaRecordatorio(r).replace(/\*/g, '')}`).join('\n'));
  const notas = agenda.notas(jid);
  if (notas.length) {
    let txt = notas.map(n => `- ${n.texto}`).join('\n');
    if (txt.length > 1500) txt = txt.slice(0, 1500) + '\n(...)';
    partes.push('Notas:\n' + txt);
  }
  return partes.join('\n\n');
}

// ---------------- avisos y repaso ----------------
const fallosEnvio = new Map();
let enCurso = false;

function textoAviso(r, ahora) {
  if (r.tipo === 'temporizador') {
    return `Se acabó el temporizador de ${T.duracionTexto(r.duracionMs)}${r.texto ? `\n\n*${r.texto}*` : '.'}`;
  }
  let t = `Recordatorio: *${r.texto || 'lo que me pediste'}*`;
  const tarde = ahora - r.ts;
  if (tarde > 3 * 60000) {
    const dia = T.isoDe(r.ts) === T.isoDe(ahora) ? '' : ` del ${T.etiquetaDia(T.isoDe(r.ts), ahora)}`;
    t += `\n\nLlega tarde: era para las ${T.horaDe(r.ts)}${dia} y estuve desconectado.`;
  }
  return t;
}

function textoRepaso(jid) {
  const pend = agenda.pendientes(jid);
  if (!pend.length) return null;
  const lista = agenda.tareas(jid);
  return `Te ${pend.length === 1 ? 'queda' : 'quedan'} ${plural(pend.length, 'tarea', 'tareas')}:\n\n`
    + pend.map(t => `${numeroDe(lista, t)} ${t.texto}${t.para ? ` _${etiquetaPara(t.para)}_` : ''}`).join('\n')
    + '\n\nDime cuáles has hecho, por ejemplo: hecha 1';
}

async function tick(conn, ahora = Date.now()) {
  if (enCurso || !conn.conectado) return;
  enCurso = true;
  try {
    for (const { jid, r } of agenda.vencidos(ahora)) {
      try {
        await conn.enviar(jid, { text: textoAviso(r, ahora) });
        agenda.avisado(jid, r.id, ahora);
        fallosEnvio.delete(r.id);
        log.info(`aviso entregado a ${usuarios.nombreDe(jid)}`);
      } catch (e) {
        const n = (fallosEnvio.get(r.id) || 0) + 1;
        fallosEnvio.set(r.id, n);
        log.warn(`aviso para ${usuarios.nombreDe(jid)} sin entregar (${n}): ${e.message}`);
        // Uno que no hay forma de entregar no puede bloquear a los demás para siempre.
        if (n >= 6) { agenda.avisado(jid, r.id, ahora); fallosEnvio.delete(r.id); }
        if (!conn.conectado) break;
      }
    }
    await repaso(conn, ahora);
  } finally {
    enCurso = false;
  }
}

// Una vez al día, a la hora de repaso, a quien le queden tareas y no lo haya
// desactivado. La fecha del último se guarda: un reinicio no lo repite.
async function repaso(conn, ahora) {
  if (cfg.HORA_REPASO == null) return;
  const hora = Math.floor(T.minutosDelDia(ahora) / 60);
  if (hora < cfg.HORA_REPASO) return;
  const hoy = T.isoDe(ahora);
  for (const d of agenda.todos()) {
    if (d.ultimoRepaso === hoy || d.ajustes.repaso === false) continue;
    const texto = textoRepaso(d.jid);
    if (!texto) continue;
    try {
      await conn.enviar(d.jid, { text: texto });
      agenda.marcarRepaso(d.jid, hoy);
      log.info(`repaso enviado a ${usuarios.nombreDe(d.jid)}`);
    } catch (e) {
      log.warn(`repaso para ${usuarios.nombreDe(d.jid)} sin entregar: ${e.message}`);
      if (!conn.conectado) return;
    }
  }
}

module.exports = {
  manejar, ejecutar, tick, desdeModelo, contextoParaModelo, resumenParaConversacion,
  cancelarEspera, hayEspera, textoTareas, textoRepaso, AYUDA,
};
