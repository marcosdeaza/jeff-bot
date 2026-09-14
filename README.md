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
| Una fecha concreta | `el 12 de abril`, `qué toca el 10 de febrero`, `3/03` |
| Un semestre entero | `asignaturas del segundo semestre`, `del semestre que viene` |
| El curso completo | `todas mis asignaturas`, `cuántas tengo en total` |
| Momento actual | `ahora`, `siguiente`, `y la de después` |
| Lo que resta del día | `lo que queda`, `las que quedan` |
| Vista semanal | `semana` |
| Exámenes y avisos | `exámenes`, `apunta <texto>` |
| Días libres | `festivos` |
| Quitar una asignatura | `no curso <asignatura>` |
| Recuperar una propia | `yo sí curso <asignatura>` |
| Alta manual | `tengo una asignatura nueva llamada <X> en el aula <Y> los <días> a las <hora>` |
| Asistencia parcial | `solo voy <días>` |
| Corregir aula | `el aula de <X> es <Y>` |
| Corregir hora | `<X> pasa a las <hora>` |
| Anular una clase | `se cancela <X> el <día>` |
| Desvincularse de un cambio | `no me aplica <X>` |
| Gestión | `mis cambios`, `deshacer`, `resetear`, `ayuda` |

Acepta varios días en una frase, avisa si la clase nueva se solapa con otra, y
el aula puede llamarse como sea: `205`, `B12`, `VH09`, `Lab 3`.

Si faltan datos los pide y recuerda de qué asignatura se hablaba, así que se
puede dar el nombre primero y el horario después, en mensajes distintos.

Absorbe cómo se escribe de verdad: argot (`q`, `xq`, `pa`), muletillas (`dime`,
`oye`, `porfa`) y números dictados por voz, de modo que "la VG treinta no es la
VG cero cinco" equivale a escribirlo con cifras.

Responde por cualquier fecha del curso, no solo por el semestre en marcha: en
septiembre sabe decir qué toca un lunes de abril. El año de una fecha sin año se
deduce del calendario académico, así que "12 de abril" en un curso que empieza en
septiembre cae en el año natural siguiente. Y un semestre se nombra de las dos
maneras: en segundo de carrera, el primer semestre es también el tercero.

---

## Datos exactos, redacción del modelo

El resolver calcula el horario de esa persona y el modelo lo entrega. Ni uno ni
otro por separado: el resolver no sabe conversar y el modelo no debe inventarse
un aula.

Todo mensaje pasa por el modelo, con los datos ya resueltos delante y la
instrucción de no alterarlos. Así puede responder lo que de verdad se pregunta
en lugar de soltar un listado:

```
- ¿me da tiempo a comer entre clases el lunes?
- Sí, de 12:30 a 14:30 tienes dos horas libres. Después vas encadenado
  de 14:30 a 20:30 sin huecos.
```

Dos salvaguardas: si el modelo falla o tarda, se entrega la respuesta que ya
había calculado el resolver, así que nunca se queda peor que sin él; y todo lo
que **modifica estado** (aplicar un cambio, deshacer, resetear) se resuelve en
local, sin modelo, porque ahí hace falta exactitud y no estilo.

El modelo no es uno, es una cadena de proveedores por orden de preferencia:
cualquier endpoint compatible con el formato de OpenAI vale, y basta URL, clave
y modelo. Se usa el primero que esté sano.

Cuando uno deja de responder queda apartado y se pasa al siguiente, así que la
avería de un proveedor no cuesta la conversación: solo la primera consulta paga
el plazo y las siguientes entran directas al que funciona. Cada fallo seguido
dobla su pausa hasta un tope, de modo que una API que desaparece del todo acaba
costando un sondeo cada pocas horas en lugar de uno cada dos minutos.

No se espera a que expire la pausa: cada dos minutos un sondeo de un token
comprueba el proveedor preferente y lo recupera en cuanto vuelve. Y la consulta
entera tiene su propio techo (`IA_PRESUPUESTO_MS`), para que recorrer la cadena
no alargue la espera según se añaden proveedores.

Añadir o quitar un proveedor es poner o borrar su clave en `.env`. El sistema
está pensado para que la marcha de cualquiera de ellos no requiera tocar código. Si ninguno responde, cada consulta
espera como mucho `IA_TIMEOUT_MS` (12 s; el doble para modelos de razonamiento,
que necesitan más) y a los dos fallos seguidos se deja de llamarlos durante tres
minutos: el bot sigue contestando al instante con el resolver y reintenta solo. El plazo cubre la petición entera, cabeceras y
cuerpo; limitar solo la conexión deja fuera la lectura de la respuesta, y una
respuesta que se corta a medias cuelga la petición indefinidamente.

`MODO_IA` gradúa ese reparto:

| Modo | Comportamiento |
| --- | --- |
| `conversacional` | Todo lo redacta el modelo. Por defecto |
| `equilibrado` | El modelo solo para lo conversacional y lo ambiguo |
| `ahorro` | Sin modelo salvo preguntas libres. El más barato |

El tono se edita en `data/personalidad.md`, que se inyecta en el prompt. Se crea
solo al arrancar y se aplica al reiniciar.

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
| Tono y personalidad | `data/personalidad.md` |
| Reglas de formato del modelo | `src/ia.js` |
| Reconexión y tiempos de espera | `src/config.js` |

---

## Configuración

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | sí | Preguntas libres |
| `GROQ_API_KEY` | no | Transcribir notas de voz |
| `DEEPSEEK_MODEL` | no | Por defecto `deepseek-flash` |
| `AWS_API_KEY`, `AWS_API_URL`, `AWS_MODEL` | no | Proveedor preferente, si lo hay |
| `DEEPSEEK_MODEL_RESERVA` | no | Último recurso. Por defecto `deepseek-v4-pro` |
| `IA_PRESUPUESTO_MS` | no | Techo de la consulta completa. Por defecto 20000 |
| `IA_TIMEOUT_MS` | no | Plazo por consulta. Por defecto 12000 |
| `PAUSA_MODELO_MS` | no | Cuánto queda apartado un modelo averiado. Por defecto 30 min |
| `SONDEO_MODELO_MS` | no | Cada cuánto se comprueba si volvió. Por defecto 2 min |
| `MODO_IA` | no | `conversacional`, `equilibrado` o `ahorro` |
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

Medido en producción con `deepseek-flash`: unos 0,00039 $ por mensaje, con un
68 % de los tokens de entrada servidos desde caché. La salida es el grueso del
coste, así que la brevedad no es solo estética.

Para 30 personas y 180 días lectivos, con todo pasando por el modelo:

| Preguntas al día por persona | Al día | Curso completo |
| --- | --- | --- |
| 3 | 0,032 $ | 5,67 $ |
| 10 | 0,105 $ | 18,90 $ |
| 20 | 0,210 $ | 37,80 $ |

Con `MODO_IA=ahorro` el 81 % de los mensajes se resuelve sin modelo y esas
cifras bajan alrededor de un 72 %, a cambio de respuestas más rígidas.

---

## Decisiones de diseño

**Separar el cálculo de la redacción.** Un horario es determinista y se
resuelve sin modelo; conversar sobre él, no. El resolver produce el dato exacto
y el modelo lo entrega, con el dato delante y prohibición de tocarlo. El modelo
no puede equivocarse en un aula porque no la deduce, y aun así responde lo que
se le pregunta. Si falla, queda la respuesta del resolver.

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
comprobar.js         comprobación de arranque de cada módulo
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
