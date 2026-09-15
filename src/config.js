const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const AUTH_DIR = process.env.AUTH_DIR || '/app/auth';

module.exports = {
  DATA_DIR,
  AUTH_DIR,
  F: {
    memoria:   path.join(DATA_DIR, 'memory.json'),
    eventos:   path.join(DATA_DIR, 'events.json'),
    overrides: path.join(DATA_DIR, 'overrides.json'),
    usuarios:  path.join(DATA_DIR, 'users.json'),
    difusion:  path.join(DATA_DIR, 'broadcast.json'),
    personalidad: path.join(DATA_DIR, 'personalidad.md'),
    tareas:    path.join(DATA_DIR, 'tasks.json'),
  },
  TZ: 'Europe/Madrid',
  DEEPSEEK_API: 'https://api.deepseek.com/chat/completions',
  MODELO: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  MODELO_RESERVA: process.env.DEEPSEEK_MODEL_RESERVA || 'deepseek-v4-pro',

  // PROVEEDORES, por orden de preferencia. Cada uno es una API compatible con
  // el formato de OpenAI: basta la URL, la clave y el modelo. Se usa el primero
  // que esté sano; los que fallan se apartan y se recuperan solos.
  //
  // El orden importa: arriba lo más rápido o barato, abajo lo que siempre
  // estará ahí. Un proveedor sin clave o sin modelo se ignora, así que quitar
  // uno es dejar su variable vacía en .env, sin tocar código. Se usa ?? y no
  // ||, porque con || una cadena vacía caía en el valor por defecto y el
  // proveedor seguía en la cadena.
  get PROVEEDORES() {
    return [
      {
        nombre: 'aws',
        url: process.env.AWS_API_URL || 'https://bedrock-mantle.eu-west-2.api.aws/v1/chat/completions',
        clave: process.env.AWS_API_KEY || '',
        modelo: process.env.AWS_MODEL ?? 'deepseek.v3.2',
      },
      {
        nombre: 'deepseek',
        url: 'https://api.deepseek.com/chat/completions',
        clave: process.env.DEEPSEEK_API_KEY || '',
        modelo: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
      },
      {
        nombre: 'deepseek-pro',
        url: 'https://api.deepseek.com/chat/completions',
        clave: process.env.DEEPSEEK_API_KEY || '',
        modelo: process.env.DEEPSEEK_MODEL_RESERVA ?? 'deepseek-v4-pro',
        razona: true,   // gasta salida pensando: necesita más plazo y más techo
      },
    ].filter(p => p.clave && p.url && p.modelo);
  },
  // Un modelo averiado queda fuera media hora. No se espera a que expire: un
  // sondeo de fondo lo devuelve en cuanto responde, sin que nadie lo sufra.
  PAUSA_MODELO_MS: Number(process.env.PAUSA_MODELO_MS || 30 * 60 * 1000),
  // Cada fallo seguido dobla la pausa: un proveedor que desaparece del todo
  // deja de costar sondeos en lugar de comprobarse cada dos minutos para siempre.
  PAUSA_MODELO_MAX_MS: Number(process.env.PAUSA_MODELO_MAX_MS || 6 * 60 * 60 * 1000),
  SONDEO_MODELO_MS: Number(process.env.SONDEO_MODELO_MS || 2 * 60 * 1000),
  DEEPSEEK_KEY: process.env.DEEPSEEK_API_KEY || '',
  GROQ_API: 'https://api.groq.com/openai/v1/audio/transcriptions',
  GROQ_KEY: process.env.GROQ_API_KEY || '',
  // JIDs con permiso para forzar cambios globales sin voto. Coma-separado.
  ADMINS: (process.env.ADMIN_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Cuánto se apoya en el modelo:
  //   ahorro        todo lo interpretable se responde en local (más barato)
  //   equilibrado   los saludos y lo ambiguo van al modelo (por defecto)
  //   conversacional además, lo dudoso se consulta antes de darlo por local
  MODO_IA: process.env.MODO_IA || 'conversacional',
  // Medido en producción: un proveedor sano contesta entre 0,6 y 2,6 s. Doce
  // segundos de plazo solo servían para que un cuelgue puntual se notara mucho;
  // con seis, el relevo al siguiente pasa casi desapercibido.
  IA_TIMEOUT_MS: Number(process.env.IA_TIMEOUT_MS || 6000),
  // Techo para la consulta ENTERA, recorriendo proveedores incluidos. Sin él,
  // añadir un proveedor más alarga lo que espera quien tropiece con la avería.
  IA_PRESUPUESTO_MS: Number(process.env.IA_PRESUPUESTO_MS || 20000),
  // Repaso de tareas al final del día (hora local 0-23). HORA_REPASO= lo apaga.
  HORA_REPASO: process.env.HORA_REPASO === '' ? null : Number(process.env.HORA_REPASO || 21),
  MAX_HISTORIAL: 8,
  // Reconexión
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 60000,
  WATCHDOG_MS: 5 * 60 * 1000,   // sin conexión 5 min -> exit(1) y Docker reinicia limpio
  KEEPALIVE_MS: 20000,
};
