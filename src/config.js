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
  },
  TZ: 'Europe/Madrid',
  DEEPSEEK_API: 'https://api.deepseek.com/chat/completions',
  // Fijado explícitamente: 'deepseek-chat' es un alias que hoy apunta a
  // deepseek-flash, pero podría moverse a un modelo más caro sin avisar.
  MODELO: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
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
  // 20s era demasiado: en un chat, esperar tanto para nada es peor que
  // responder al instante con el dato exacto que ya se tiene calculado.
  IA_TIMEOUT_MS: Number(process.env.IA_TIMEOUT_MS || 12000),
  MAX_HISTORIAL: 8,
  // Reconexión
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 60000,
  WATCHDOG_MS: 5 * 60 * 1000,   // sin conexión 5 min -> exit(1) y Docker reinicia limpio
  KEEPALIVE_MS: 20000,
};
