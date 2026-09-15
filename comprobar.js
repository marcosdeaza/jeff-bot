// Comprobación de arranque. `node --check` solo valida sintaxis: no detecta una
// referencia que quedó sin definir tras un refactor. Esto ejercita de verdad
// cada pieza antes de dar por bueno un despliegue.
const pruebas = [];
const probar = (nombre, fn) => pruebas.push([nombre, fn]);

probar('config: hay al menos un proveedor', () => {
  const cfg = require('./src/config');
  if (!cfg.PROVEEDORES.length) throw new Error('ningún proveedor con clave');
  return cfg.PROVEEDORES.map(p => `${p.nombre}/${p.modelo}`).join(' -> ');
});
probar('horario: resuelve el día de hoy', () => {
  const H = require('./src/horario');
  const ov = require('./src/overrides'); ov.cargar();
  const hoy = H.hoyISO();
  const { clases } = H.clasesDeDia('prueba@lid', hoy);
  return `${hoy}, ${clases.length} clases`;
});
probar('ia: estadoIA responde', () => JSON.stringify(require('./src/ia').estadoIA()));
probar('intent: interpreta lo básico', () => {
  const I = require('./src/intent');
  for (const [t, esperado] of [['hoy', 'fecha'], ['hola', 'saludo'], ['lo que queda', 'restantes']]) {
    const r = I.consulta(t);
    if (!r || r.tipo !== esperado) throw new Error(`"${t}" dio ${r && r.tipo} en vez de ${esperado}`);
  }
  if (!I.cambio('no curso Álgebra')) throw new Error('no detecta quitar una asignatura');
  if (!I.anadir('ponme Redes los martes a las 16:30')) throw new Error('no detecta un alta');
  return 'ok';
});
probar('comandos: responde una consulta local', async () => {
  const cmd = require('./src/comandos');
  const us = require('./src/usuarios'); us.cargar();
  const r = await cmd.manejar('humo@lid', 'mis cambios', { sesion: { historial: [] } });
  if (!r || !r.texto) throw new Error('sin respuesta');
  return r.texto.split('\n')[0];
});
probar('tareas: apuntar, listar y completar', async () => {
  const T = require('./src/tareas'); T.cargar();
  const cmd = require('./src/comandos');
  const J = 'humo-tareas@lid';
  T.de(J).slice().forEach(t => T.descartar(J, t.id));
  let r = await cmd.manejar(J, 'apunta probar el humo', { sesion: { historial: [] } });
  if (!/Apuntado/.test(r.texto)) throw new Error('no apunta');
  if (T.pendientes(J).length !== 1) throw new Error('no queda pendiente');
  r = await cmd.manejar(J, 'ya hice probar el humo', { sesion: { historial: [] } });
  if (T.pendientes(J).length !== 0) throw new Error('no la completa');
  if (T.hechasHoy(J).length !== 1) throw new Error('no cuenta como hecha hoy');
  T.de(J).slice().forEach(t => T.descartar(J, t.id));
  return 'ok';
});
probar('formato: render limpio', () => {
  const f = require('./src/formato');
  const t = f.clase({ inicio: '10:30', fin: '12:30', asignatura: 'Álgebra', edificio: 'VG25', aula: 'M11' });
  if (t.includes('12:30') || t.includes('M11')) throw new Error('muestra el rango o el aula');
  return t.replace('\n', ' / ');
});

(async () => {
  let fallos = 0;
  for (const [nombre, fn] of pruebas) {
    try { console.log(`  ok    ${nombre}: ${await fn()}`); }
    catch (e) { console.log(`  FALLA ${nombre}: ${e.message}`); fallos++; }
  }
  console.log(fallos ? `\n${fallos} comprobaciones fallaron` : '\ntodo correcto');
  process.exit(fallos ? 1 : 0);
})();
