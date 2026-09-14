// Cola de difusión persistida en disco.
// Nunca se abre una segunda conexión de WhatsApp para mandar anuncios: eso
// provocaría un 440 (connectionReplaced) y tumbaría el bot. En su lugar se
// encola aquí y el proceso principal la va vaciando con freno de ritmo.
const { F } = require('./config');
const store = require('./store');
const log = require('./log');

let cola = [];

function cargar() {
  cola = store.leer(F.difusion, []);
  if (!Array.isArray(cola)) cola = [];
  const pend = cola.filter(c => c.estado === 'pendiente').length;
  if (pend) log.info(`difusiones pendientes: ${pend}`);
}
function guardar() { return store.escribir(F.difusion, cola); }

function encolar({ texto, destinatarios, etiqueta = '' }) {
  const d = {
    id: `dif_${Date.now()}`,
    etiqueta, texto,
    destinatarios: [...new Set(destinatarios)],
    enviados: [], fallidos: [],
    creado: Date.now(), estado: 'pendiente',
  };
  cola.push(d);
  guardar();
  log.info(`difusión encolada (${d.destinatarios.length} destinatarios): ${etiqueta}`);
  return d;
}

function pendientes() { return cola.filter(c => c.estado === 'pendiente'); }

// Relee el fichero y AÑADE las difusiones nuevas que haya encolado alguien de
// fuera (un docker exec, por ejemplo), sin pisar el progreso de las que ya
// están en vuelo. Así se pueden lanzar anuncios sin reiniciar el bot.
function sincronizar() {
  const enDisco = store.leer(F.difusion, []);
  if (!Array.isArray(enDisco)) return 0;
  const conocidas = new Set(cola.map(c => c.id));
  let nuevas = 0;
  for (const d of enDisco) {
    if (!conocidas.has(d.id)) { cola.push(d); nuevas++; }
  }
  if (nuevas) log.info(`difusiones nuevas detectadas: ${nuevas}`);
  return nuevas;
}

// Envía respetando un ritmo humano para no disparar el antispam de WhatsApp.
async function procesar(conn, { pausaMs = 1500 } = {}) {
  for (const d of pendientes()) {
    if (!conn.conectado) { log.warn('difusión aplazada: sin conexión'); return; }
    const restantes = d.destinatarios.filter(j => !d.enviados.includes(j) && !d.fallidos.includes(j));
    log.info(`difundiendo "${d.etiqueta}": ${restantes.length} restantes`);
    for (const jid of restantes) {
      if (!conn.conectado) { log.warn('difusión interrumpida: sin conexión'); await guardar(); return; }
      try {
        await conn.enviar(jid, { text: d.texto });
        d.enviados.push(jid);
        log.info(`  → enviado a ${jid}`);
      } catch (e) {
        d.fallidos.push(jid);
        log.error(`  → falló ${jid}: ${e.message}`);
      }
      await guardar();
      await new Promise(r => setTimeout(r, pausaMs + Math.random() * 700));
    }
    d.estado = 'hecho';
    d.terminado = Date.now();
    await guardar();
    log.info(`difusión "${d.etiqueta}" completada: ${d.enviados.length} ok, ${d.fallidos.length} fallidos`);
  }
}

module.exports = { cargar, guardar, encolar, pendientes, sincronizar, procesar, todas: () => cola };
