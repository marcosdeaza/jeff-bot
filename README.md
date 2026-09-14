![Jeff](docs/banner.png)

# Jeff

Bot de WhatsApp que lleva el horario de una clase. Cada persona ajusta el suyo
sin cambiárselo a nadie.

Entiende texto y notas de voz, en lenguaje normal. Sin comandos que memorizar.

---

## El problema

Un horario de clase parece un dato único, pero no lo es. Hay repetidores que
arrastran asignaturas que el resto ya aprobó, gente que no va ciertos días y
cambios de aula que afectan a unos y a otros no.

Con un horario global, cualquier corrección se la come todo el mundo. Con una
copia por persona, un cambio real hay que repetirlo treinta veces.

Jeff separa lo común de lo de cada uno. Ante un cambio pregunta a quién afecta:
solo a quien lo pide, o a toda la clase. Quien reciba un cambio de clase que no
le corresponde puede desvincularse de él sin tocar el de los demás.

---

## Formato de respuesta

Se lee en el móvil, entre clases, con prisa. El formato es parte del diseño:

```
Hoy es lunes. Estas son las clases de hoy:

10:30 *Álgebra*
VG25

14:30 *Análisis de circuitos*
VG04
```

Contrato que cumple todo el texto del bot:

- Solo la hora de inicio; el rango sobra cuando las clases van seguidas.
- Solo el edificio; el aula rara vez cambia y ocupa sitio.
- Nombres cortos, configurables por asignatura.
- Negrita con un asterisco, el de WhatsApp, y solo en el nombre.
- Sin emojis, viñetas, flechas ni títulos en mayúsculas.
- Sin saludos ni recuentos finales.

El modelo de lenguaje recibe el mismo contrato con un ejemplo literal, y su
salida se filtra después para retirar cualquier adorno que reintroduzca.

---

## Qué entiende

| Intención | Formas admitidas |
| --- | --- |
| Clases de un día | `hoy`, `mañana`, `el viernes`, `pasado mañana` |
| Momento actual | `ahora`, `siguiente`, `y la de después` |
| Lo que resta del día | `lo que queda`, `las que quedan` |
| Vista semanal | `semana` |
| Exámenes y avisos | `exámenes`, `apunta <texto>` |
| Días libres | `festivos` |
| Quitar una asignatura | `no curso <asignatura>` |
| Recuperar una propia | `yo sí curso <asignatura>` |
| Alta manual | `tengo una asignatura llamada <X> en el aula <Y> los <días> a las <hora>` |
| Asistencia parcial | `solo voy <días>` |
| Corregir aula | `el aula de <X> es <Y>` |
| Corregir hora | `<X> pasa a las <hora>` |
| Anular una clase | `se cancela <X> el <día>` |
| Desvincularse de un cambio | `no me aplica <X>` |
| Gestión | `mis cambios`, `deshacer`, `resetear`, `ayuda` |

Acepta varios días en una frase, avisa si la clase nueva se solapa con otra, y
el aula puede llamarse como sea: `205`, `B12`, `VH09`, `Lab 3`.

Absorbe cómo se escribe de verdad: argot (`q`, `xq`, `pa`), muletillas (`dime`,
`oye`, `porfa`) y números dictados por voz, de modo que "la VG treinta no es la
VG cero cinco" equivale a escribirlo con cifras.

---

## Arquitectura

El horario oficial no se edita nunca. Los cambios se apilan encima como
registros y se resuelven al vuelo, por persona.

```
L0  BASE       horario oficial, inmutable
L1  GLOBAL     cambios de toda la clase
L2  PERSONAL   cambios de una sola persona
L3  EVENTOS    exámenes y avisos, con el mismo alcance
               |
               v
    resolver(usuario, fecha) -> su horario efectivo
```

Que un cambio sea un registro y no una edición da tres propiedades gratis: es
reversible, es auditable (quién, cuándo, por qué) y permite que lo personal
prevalezca sobre lo global sin duplicar datos.

Detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

---

## Puesta en marcha

Requisitos: Docker y Docker Compose, y una cuenta de WhatsApp para el bot.

```bash
git clone https://github.com/marcosdeaza/jeff-bot.git
cd jeff-bot
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f
```

El QR aparece en los logs la primera vez. Se escanea desde WhatsApp, en
Dispositivos vinculados. La sesión queda en `auth/` y no se repite.

---

## Adaptarlo a otra clase

El horario admite dos vías. En caliente, sin tocar el código:

```bash
docker exec jeff-bot node /app/horario-export.js
$EDITOR data/horario.json
docker compose restart
```

`data/horario.json` prevalece sobre el horario incorporado. Se valida al
arrancar: si tiene errores, se registra el motivo y se sigue con el de fábrica
en lugar de dejar el bot sin horario.

En el código, el valor de fábrica está en
[`src/horario-base.js`](src/horario-base.js), con una clase por línea:

```js
C(1, 1, '10:30', '12:30', 'Álgebra', 'VG25', 'M11'),
// semestre, día (1=lunes), inicio, fin, asignatura, edificio, aula
```

Ahí mismo van el calendario académico, festivos, vacaciones y exámenes.

Otros puntos pensados para tocarse:

| Qué | Dónde |
| --- | --- |
| Nombres cortos por asignatura | `CORTO` en `src/formato.js` |
| Abreviaturas y apodos de asignatura | `ALIAS` en `src/horario.js` |
| Argot y muletillas | `ARGOT`, `MULETILLAS` en `src/intent.js` |
| Plantillas de respuesta | `src/formato.js` |
| Reglas de estilo del modelo | `src/ia.js` |
| Reconexión y tiempos de espera | `src/config.js` |

---

## Configuración

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | sí | Preguntas libres |
| `GROQ_API_KEY` | no | Transcribir notas de voz |
| `DEEPSEEK_MODEL` | no | Por defecto `deepseek-flash` |
| `ADMIN_JIDS` | no | Cuentas con permisos de administración |
| `TZ` | no | Por defecto `Europe/Madrid` |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` |

---

## Operación

Anuncio a todos los usuarios registrados, sin reiniciar:

```bash
docker exec jeff-bot node /app/anunciar.js /app/data/mensaje.txt etiqueta
```

Se encola en disco y el proceso principal lo envía con pausas. No abras una
segunda conexión de WhatsApp para mandar anuncios: la primera se cierra con un
`connectionReplaced` y el bot cae.

Gasto acumulado del modelo:

```bash
docker exec jeff-bot cat /app/data/coste.json
```

Los cambios administrativos sobre `data/overrides.json` se recogen solos en
menos de quince segundos; no hace falta reiniciar.

---

## Coste

El 81 % de los mensajes reales se resuelve en local, sin llamar al modelo: son
instantáneos y gratis. Solo llega al modelo lo genuinamente conversacional.

Una consulta que sí llega son unos 512 tokens de caché, 243 nuevos y 300 de
salida: 0,00044 $ con `deepseek-flash` en hora punta. La salida es el 83 % del
coste, así que la brevedad no es solo estética.

Para 30 personas y 180 días lectivos:

| Preguntas al día por persona | Al día | Curso completo |
| --- | --- | --- |
| 3 | 0,007 $ | 1,34 $ |
| 10 | 0,025 $ | 4,47 $ |
| 20 | 0,050 $ | 8,95 $ |

---

## Decisiones de diseño

**Responder sin el modelo siempre que se pueda.** Un horario es determinista:
consultarlo no necesita un modelo de lenguaje. La interpretación local cubre lo
frecuente y el modelo queda para lo que de verdad es conversación. Esto rebajó
el gasto un 72 % y quitó latencia donde más se nota.

**Un solo socket, siempre.** Reconectar reinvocando el arranque sin cerrar el
socket anterior los apila, junto con sus escuchadores, y deja dos escritores
concurrentes sobre las credenciales, que acaban corrompiéndose. Hay cerrojo de
un solo vuelo, derribo explícito, retroceso exponencial con jitter y
tratamiento por código de cierre. Sin conexión durante cinco minutos, el proceso
sale con código 1 y Docker levanta uno limpio.

**Lo volátil, al final del prompt.** El proveedor cachea por prefijo común y el
acierto es unas cincuenta veces más barato. Con la hora en medio, ese prefijo se
rompía cada minuto; con el horario primero y la hora al final se reutilizan 512
tokens entre llamadas y entre usuarios.

**Caché por usuario.** Indexar respuestas solo por el texto haría que dos
personas con la misma pregunta compartieran respuesta, lo que con horarios
personalizados devuelve el horario de otro. La clave incluye al usuario y la
huella de su horario resuelto.

**Escritura atómica.** El estado se escribe a un temporal y se renombra, con las
escrituras serializadas por fichero. Un corte a mitad no deja un JSON roto, y un
fichero ilegible se aparta con marca de tiempo en vez de perderse.

---

## Estructura

```
main.js              arranque y reparto de mensajes
healthcheck.js       latido que lee Docker
anunciar.js          encolar un anuncio
horario-export.js    volcar el horario a JSON editable
src/
  config.js          rutas, claves, constantes
  log.js             registro
  store.js           persistencia JSON atómica
  horario-base.js    L0: horario de fábrica y calendario
  horario.js         resolución de capas, fechas, carga en caliente
  overrides.js       L1 y L2: cambios con alcance
  eventos.js         L3: exámenes y avisos
  usuarios.js        registro de quién usa el bot
  intent.js          interpretación local del lenguaje
  comandos.js        reparto de respuestas
  ia.js              modelo de lenguaje y transcripción
  formato.js         render para WhatsApp
  difusion.js        cola de anuncios
  wa.js              conexión de WhatsApp
```

---

## Licencia

MIT. Ver [LICENSE](LICENSE).
