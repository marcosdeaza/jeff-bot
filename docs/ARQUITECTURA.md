# Arquitectura

## El problema

Un horario de clase parece un dato único y compartido, pero no lo es. Conviven:

- Lo que vale para todos: las horas oficiales de cada asignatura.
- Lo que vale para un grupo: un cambio de aula que anuncia el profesor.
- Lo que vale para una persona: un repetidor que arrastra una asignatura, o
  alguien que solo va ciertos días.

Si el horario es un único documento que se edita, cualquier corrección se la
come todo el mundo. Si cada persona tiene su copia, un cambio real hay que
repetirlo treinta veces y las copias divergen.

## La solución: capas

El horario oficial no se edita nunca. Los cambios se guardan como registros
aparte y se aplican al vuelo, por persona, cuando hay que responder.

```
L0  BASE       src/horario-base.js     inmutable
L1  GLOBAL     overrides scope=global  afecta a todos
L2  PERSONAL   overrides scope=personal afecta a su dueño
L3  EVENTOS    events.json             exámenes y avisos, con alcance
```

`resolverSemestre(usuario, fecha)` toma L0, aplica los globales por orden y
después los personales. Lo personal se aplica al final, así que siempre gana.

## Un cambio, por dentro

```json
{
  "id": "ov_1789403269232_inicial",
  "seq": 1,
  "scope": "global",
  "owner": null,
  "tipo": "quitar",
  "match": { "asignatura": "Álgebra" },
  "set": {},
  "fecha": null,
  "motivo": "quitar Álgebra (solo la cursan repetidores)",
  "creadoPor": "sistema",
  "creadoEn": 1789403269232,
  "activo": true
}
```

- `scope` y `owner` deciden a quién afecta.
- `match` selecciona las clases; `set` dice qué cambia.
- `fecha` a `null` es permanente; con una fecha, solo ese día.
- `seq` es un contador monótono. Hace falta porque varios cambios creados en el
  mismo milisegundo empataban en `creadoEn` y `deshacer` revertía el que no era.
- `activo` en `false` en vez de borrar: el historial se conserva.

Tipos: `quitar`, `cancelar`, `aula`, `hora`, `mover`, `anadir` e
`ignorar-global`.

## Excluirse de un cambio global

`ignorar-global` es un cambio personal cuyo `match` apunta al `id` de uno global.
Al resolver, los globales que estén en la lista de ignorados de esa persona se
saltan.

Esto permite el caso del repetidor sin duplicar nada: se quita Álgebra para toda
la clase, y quien la cursa se excluye de ese cambio y recupera sus horas
oficiales exactas.

## Resolución, paso a paso

1. Se busca el semestre que corresponde a la fecha. Fuera de él, no hay clases.
2. Se comprueba si es festivo, vacaciones o fin de semana.
3. Se parte de las clases de ese semestre en L0.
4. Se aplican los globales activos que esa persona no ignore, por `seq`.
5. Se aplican sus personales, por `seq`.
6. Se ordena por día y hora y se filtra por el día pedido.

Los cambios se aplican sobre el semestre entero, no sobre el día, para que
`mover` y `anadir` puedan cambiar de día una clase.

## Interpretación del lenguaje

Antes de gastar una llamada al modelo, `intent.js` intenta resolver el mensaje:

1. `consulta()` — consultas inequívocas (`hoy`, `semana`, `ahora`).
2. `anadir()` — añadir o recuperar una asignatura.
3. `cambio()` — propuestas de cambio.
4. `consultaDebil()` — ambiguas, como `el lunes`, que podría ser consulta o
   parte de un cambio. Van después a propósito.
5. El modelo de lenguaje, con el horario ya resuelto de esa persona.

Las consultas frecuentes no cuestan dinero y responden al instante.

## Conexión de WhatsApp

`wa.js` mantiene la invariante de que solo existe un socket vivo:

- Cerrojo `conectando` para que no se solapen dos intentos.
- Derribo explícito antes de crear el siguiente: quitar escuchadores, cerrar el
  websocket, terminar el socket.
- Retroceso exponencial con jitter, hasta 60 s, que se reinicia al conectar.
- Por código de cierre: `loggedOut` y `badSession` paran y piden QR nuevo;
  `restartRequired` reconecta al momento; `connectionReplaced` espera 60 s para
  no pelear con la otra sesión; el resto va al retroceso normal.
- Dedupe de mensajes entrantes por `key.id`.
- Vigilante: cinco minutos sin conexión y el proceso sale con código 1, para que
  Docker levante uno limpio.

## Persistencia

`store.js` escribe a un temporal y renombra, y serializa las escrituras por
fichero. Si el JSON está corrupto al leerlo, se aparta con marca de tiempo en vez
de perderlo en silencio.

Todo el estado vive en `data/`, montado como volumen:

```
memory.json      historial de conversación por usuario
users.json       quién usa el bot
overrides.json   L1 y L2
events.json      L3
broadcast.json   cola de anuncios
coste.json       gasto acumulado
.alive           latido para el healthcheck
```

## Coste del modelo

El proveedor cachea por prefijo común y el acierto de caché es unas 50 veces más
barato que el fallo. Por eso el prompt pone primero lo estable (reglas de
formato, horario, eventos) y al final lo volátil (fecha y hora). Con la hora en
medio, el prefijo se rompía cada minuto.

La caché de respuestas se indexa por usuario y por huella de su horario
resuelto. Una caché global por texto filtraría el horario de una persona a otra.
