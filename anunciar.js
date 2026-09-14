// Encola un anuncio para todos los usuarios registrados.
//   docker exec jeff-bot node /app/anunciar.js /app/data/mensaje.txt [etiqueta]
// El proceso principal lo detecta en <15s y lo envía con freno de ritmo.
const fs = require('fs');
const usuarios = require('./src/usuarios');
const difusion = require('./src/difusion');

const ruta = process.argv[2];
const etiqueta = process.argv[3] || 'anuncio';
if (!ruta) { console.error('uso: node anunciar.js <fichero.txt> [etiqueta]'); process.exit(1); }

const texto = fs.readFileSync(ruta, 'utf8').trim();
usuarios.cargar();
difusion.cargar();

const destinatarios = usuarios.activos().map(u => u.jid);
if (!destinatarios.length) { console.error('no hay usuarios registrados'); process.exit(1); }

const d = difusion.encolar({ texto, destinatarios, etiqueta });
console.log(`encolado ${d.id} para ${destinatarios.length} destinatarios:`);
destinatarios.forEach(j => console.log('  -', j));
