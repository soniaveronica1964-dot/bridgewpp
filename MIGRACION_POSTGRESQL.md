# Migración de persistencia a una base PostgreSQL compartida en la LAN

## Objetivo y criterio de aceptación

Este documento especifica cómo reemplazar `chrome.storage.local` como almacén de
datos funcionales por una base relacional PostgreSQL central, accesible desde
varios perfiles de Chrome y varias PC de una misma LAN. El navegador no se
conecta directamente a PostgreSQL: un servicio/API autenticado es el único
acceso a la base.

La migración no consiste solamente en crear tablas. También debe conservar:

- todos los valores y las claves que ya existan en cada perfil de Chrome;
- todos los movimientos, incluidos los históricos incompletos y los pendientes;
- la separación de los datos que deben seguir siendo privados por perfil;
- el acceso concurrente de varios perfiles y PC a los datos compartidos;
- los permisos de Chrome, las sesiones de los sitios y las credenciales del
  bridge en sus respectivos ámbitos;
- el orden y el resultado observable de las operaciones actuales;
- la capacidad de recuperar los datos antiguos si la importación o el cambio de
  versión falla.

Se considerará completa únicamente cuando:

1. la extensión ya no lea ni escriba datos funcionales mediante
   `chrome.storage.local`;
2. las lecturas y escrituras funcionales terminen en PostgreSQL a través de la
   API de datos autorizada;
3. cada perfil que tenía datos conserve sus propios datos e historial;
4. la migración de un perfil sea verificable, repetible sin duplicar datos y
   recuperable;
5. las comprobaciones funcionales de este documento pasen antes de eliminar la
   copia anterior.

## Alcance y límites

### Incluido

- La configuración leída y escrita actualmente con `chrome.storage.local`.
- Las claves dinámicas `agentMovement:*` y todos sus registros asociados.
- Los contadores y la configuración de paneles de contacto.
- La sesión de MultiPanel que la extensión copia a su almacenamiento.
- La configuración del bono activo y su sincronización existente entre perfiles.
- El intercambio de datos entre páginas de contenido, página de opciones,
  service worker y bridge.
- La importación de datos ya existentes en perfiles Chrome.
- La asociación de cada perfil Chrome y cada instalación/PC a un espacio de
  trabajo compartido.
- La lectura y escritura concurrente de los datos designados como compartidos.
- La detección del servicio central y el tratamiento explícito de servicio
  ausente, identidad desconocida o perfil aún no enrolado.

### No se debe confundir con la migración

- El `localStorage` del sitio de MultiPanel con clave `lux-support-user` es
  propiedad de ese sitio. La extensión lo lee para obtener una sesión activa,
  pero no es `chrome.storage.local`. No se debe borrar, modificar ni migrar como
  si fuera un registro propio de la extensión.
- Los permisos de origen concedidos con `chrome.permissions` pertenecen a
  Chrome. No son filas de almacenamiento de la extensión y no se trasladan a
  PostgreSQL.
- `credentials.json`, el indicador `remote-creation-enabled` y
  `bridge-tray.log` pertenecen al bridge y a su aplicación de bandeja. Están
  bajo `%LOCALAPPDATA%\GanamosWhatsAppBridge`, fuera de `chrome.storage.local`.
  No se deben mover automáticamente como efecto lateral de esta migración.
- `dataProfileSelector` es una excepción técnica: un UUID aleatorio no secreto
  que permite al host nativo seleccionar el registro DPAPI de este perfil.
  Permanece en el almacenamiento local de Chrome, pero no contiene estado de la
  aplicación y no forma parte del respaldo/exportación del perfil.
- El estado transitorio de long polling que el bridge mantiene en memoria no se
  migra. La configuración funcional `activeBonusConfig`, en cambio, pasa a ser
  compartida/persistente en PostgreSQL conforme a la tabla de ámbitos.
- Balances, resultados de búsqueda, formularios, notificaciones y otros estados
  temporales que hoy solo viven en memoria no deben empezar a persistirse por
  accidente.

## Estado actual: inventario de datos

El inventario se deriva de los accesos actuales a `chrome.storage.local` en
[options.js](./options.js), [background.js](./background.js) y
[content/whatsapp.js](./content/whatsapp.js). Las claves conocidas son:

| Clave actual | Forma actual | Uso que debe conservarse |
|---|---|---|
| `bridgeRole` | Texto: `standalone`, `primary` o `secondary`. | Define el modo del perfil. Si falta, el comportamiento actual es independiente. |
| `bridgeToken` | Texto. Puede ser vacío en modo independiente. | Código de emparejamiento usado por el bridge. Es secreto. |
| `ganamosUserId` | Texto numérico. | Identificador de agente usado para consultas de Ganamos; se aplica el valor predeterminado actual cuando corresponde. |
| `ganamosSuffix` | Texto de una letra. | Sufijo de alias para Ganamos. |
| `multiPanelSuffix` | Texto de una letra. | Sufijo de alias para MultiPanel. Debe ser distinto al de Ganamos. |
| `userCreationPassword` | Texto. | Contraseña automática para creación/restauración de usuarios. Es secreto. |
| `remoteCreateDestinations` | Arreglo de hasta tres destinos. | Configuración privada del perfil Chrome; cada elemento puede contener `id`, `name`, `url`, `token`, `ganamosSuffix` y `multiPanelSuffix`. Incluye datos de red y secretos. |
| `multiPanelSession` | Texto de sesión. | Caché de la sesión que obtiene el service worker desde la pestaña MultiPanel y que puede renovarse al consultar reportes. Es secreto. |
| `activeBonusConfig` | Objeto o ausencia de clave. | Tipo, estado, porcentajes, plataforma, umbrales y, en el modo misterioso, resultados/pesos. Puede recibirse desde el perfil principal. |
| `contactFlowCounters` | Objeto compuesto. | Contadores, paneles, palabras clave, PCs destino y listas de números ya contabilizados. |
| `agentBalanceView` | Texto de una vista. | Última vista del panel de balances/movimientos. |
| `agentBalancesMinimized` | Booleano. | Compatibilidad adicional para la vista minimizada; se escribe junto con `agentBalanceView`. |
| `agentMovement:<timestamp>:<uuid>` | Una clave por registro. | Historial de depósitos, retiros e intercambios. No se encontró borrado automático. |

### Ámbito de propiedad de los datos

Que todos los clientes consulten una base no significa que todas las filas
deban ser visibles para todos. La nueva API debe aplicar un ámbito explícito:

| Dato | Ámbito recomendado | Regla |
|---|---|---|
| Destinos `remoteCreateDestinations` | Perfil Chrome | Cada perfil administra su propia lista; las pestañas de WhatsApp de ese perfil usan esa lista y los demás perfiles no la heredan. Cada perfil Chrome solicita por separado los permisos de host de Chrome. |
| Movimientos `agentMovement:*` | Espacio de trabajo compartido | Se consultan desde las PC autorizadas; se conserva el perfil/instalación que originó cada movimiento para auditoría e idempotencia. |
| Contadores y paneles `contactFlowCounters` | Espacio de trabajo compartido | Incrementos/deduplicación deben ser atómicos en el servidor para impedir doble conteo entre PC. |
| Bono activo | Espacio de trabajo compartido | La revisión/publicación existente se conserva; una actualización remota no se vuelve a publicar como local. |
| `bridgeRole`, `bridgeToken`, ID de agente, sufijos y vista del panel | Perfil Chrome | No se propagan automáticamente a otros perfiles. |
| `userCreationPassword`, `multiPanelSession` | Perfil Chrome autorizado | Secretos aislados por perfil; no se devuelven en lecturas generales ni se comparten por defecto. |
| Token de cada destino remoto | Perfil Chrome, secreto | Solo lo reciben las pestañas del perfil propietario mediante la API autenticada; se cifra en el servidor. |
| Permisos Chrome y `lux-support-user.session` del sitio | Fuera de la base compartida | Permanecen en Chrome/el sitio y cada PC/perfil mantiene su propio estado. |

Esta tabla es la política predeterminada de esta especificación. Cualquier dato
que se mueva del ámbito perfil al compartido es un cambio visible de
comportamiento y debe aprobarse, probarse con datos reales y documentarse. No se
deben copiar contraseñas o sesiones personales al ámbito compartido solo para
que “todo sincronice”.

La migración de esquema que introduce el ámbito por perfil reasigna la
configuración de destinos que antes estaba en el workspace al perfil que realizó
su última modificación registrada (o al administrador del workspace si no hay
un evento de cambio disponible). Los demás perfiles quedan sin esa lista y
pueden configurar la suya desde sus propias opciones.

### Topología operativa prevista

La instalación inicial contempla 3–4 PC en una LAN:

- **Publicidad** ejecuta perfiles Chrome que atienden teléfonos/conexiones y
  acceden a otras PC. No es automáticamente el servidor PostgreSQL ni obtiene
  permisos administrativos por ser el origen de los teléfonos.
- **Dos PC operativas actuales y una tercera futura** mantienen cada una un
  perfil Chrome principal y uno o más perfiles secundarios conectados según el
  bridge actual. Puede haber perfiles adicionales que conecten a otra PC para
  duplicar/atender WhatsApp de Publicidad.
- Una de las PC designadas aloja PostgreSQL y la API central; todas las demás,
  incluida Publicidad si no es el host, usan esa API por LAN. La elección del
  host se configura explícitamente y su endpoint estable/certificado queda
  aprobado en todos los perfiles.

Todos los perfiles que deban compartir movimientos, paneles, destinos y bono
se enrolan al mismo `workspace_id`, independientemente de si son `primary`,
`secondary` o un perfil adicional que opera contra otra PC. `bridgeRole` sigue
controlando exclusivamente el enrutamiento de operaciones existente; no
selecciona workspace, no autentica PostgreSQL y no concede permisos de
administración. El rol de almacenamiento se asigna aparte al enrolar el
perfil/dispositivo. Por defecto, perfiles de Publicidad pueden crear/consultar
lo necesario para su flujo pero no administrar enrolamientos, destinos o
secretos; un administrador designado habilita esas capacidades explícitamente.

La topología de almacenamiento no reemplaza la topología de operaciones:
`32145` permanece loopback en cada PC para su bridge local y `32146` permanece
el canal firmado de creación remota en cada host que lo utilice. La API
PostgreSQL central usa endpoint/puerto separado. No se redirige el tráfico
actual `primary`/`secondary` ni los destinos de creación a través de la base.
Se verifica como prueba de aceptación que perfiles adicionales conectados a
otra PC sigan ejecutando exactamente los flujos previos, mientras leen/escriben
el workspace autorizado en la API central.

### Estructura de `contactFlowCounters`

El objeto contiene:

- `arrived`: contador de chats individuales entrantes.
- `derived`: mapa de `destinationId` a contador de derivados.
- `countedNumbers`: números telefónicos ya contados como llegados.
- `panels`: arreglo de paneles. Cada panel contiene:
  - `id`;
  - `title`;
  - `keyword`;
  - `destinationId`;
  - `count`;
  - `countedNumbers`, la lista de números ya contados para ese panel.

Las listas de números son parte de la lógica de deduplicación, no simples datos
de presentación. No se deben omitir ni limpiar durante la importación. El
reinicio de valores conserva paneles; la opción “Reiniciar valores” conserva
además las listas de números, mientras que “Reiniciar todo” las vacía.

### Estructura de movimientos

Cada registro `agentMovement:*` tiene, según la operación y la versión que lo
creó:

- `contactKey`: identidad histórica del contacto, serializada como texto.
- `operation`: `deposit`, `withdrawal` o `exchange`.
- `amount`: importe usado para mostrar o sumar el movimiento.
- `platform`: plataforma del registro; en un intercambio es la plataforma de
  origen.
- `timestamp`: epoch en milisegundos.
- `username`: alias, si se conoce.
- `transactionAmount`: importe original, cuando se guardó.
- `bonusAmount`: bono, cuando se guardó.
- `fromPlatform` y `toPlatform`: datos de intercambio.
- `status`: por ejemplo `pending-verification` o estados de intercambio.
- `verification`: objeto de verificación del depósito, que puede incluir
  estado, saldo inicial/final, aumento esperado y error.

Los movimientos históricos pueden no tener todos los campos. En particular,
hay depósitos antiguos cuyo monto original y bono no fueron guardados por
separado. Esa ausencia se muestra expresamente en la interfaz y afecta los
totales. No se debe inventar el dato faltante ni completar con cero un campo que
está ausente.

`contactKey` se construye con los nombres de usuario detectados y/o el teléfono
del chat. Es una clave opaca de asociación histórica: no se debe volver a
calcular a partir de alias actuales, normalizar, traducir ni separar durante la
migración. Preservar su valor exacto es necesario para que los historiales
existentes sigan apareciendo en el mismo contacto.

### Claves heredadas o desconocidas

La migración debe exportar `chrome.storage.local.get(null)`, no una lista
codificada de las claves conocidas. Puede haber claves creadas por una versión
anterior, una versión futura o una instalación particular. Toda clave que no
esté en el inventario también debe conservarse en una tabla de compatibilidad
como JSON original y reportarse en el resultado de la importación. No debe
descartarse silenciosamente.

## Arquitectura objetivo

### Estado de implementación del backend de migración

El repositorio está preparando un servicio independiente en `data-api/`. El
esquema y el migrador versionado están definidos; la API HTTPS tiene rutas de
salud/identidad, enrolamiento de un solo uso y recepción de lotes cifrados en
reposo para staging. La validación vuelve a comprobar hashes, cantidades y
checksum canónico, y genera una vista previa de conflictos con conteos, sin
devolver valores. Un endpoint autenticado permite consultar el estado y
recuperar el informe de una migración ante una respuesta perdida. El commit
importa ajustes y secretos privados, movimientos y claves heredadas de forma
transaccional e idempotente; la inicialización de datos compartidos requiere
una decisión explícita de un administrador del workspace.

La capa de estado de ejecución (`GET/POST /v1/state`) está conectada al service
worker y a las opciones/scripts de contenido mediante mensajes de extensión.
Se eliminaron los accesos funcionales a `chrome.storage.local`; las
lecturas/escrituras usan PostgreSQL, aplican revisiones optimistas a cambios
compartidos y notifican cambios entre pestañas/perfiles. La única excepción es
`dataProfileSelector`: un UUID aleatorio no secreto guardado en el
almacenamiento local de Chrome para seleccionar el registro DPAPI del perfil,
porque Chrome no expone al host nativo una identidad fiable del perfil activo.
Ese UUID no se exporta como dato funcional ni contiene credenciales.
La sincronización periódica consulta una bitácora incremental, no descarga todo
el historial en cada sondeo. Los destinos, contadores y bono también actualizan
sus tablas relacionales en la misma transacción. Las credenciales del API se
guardan por perfil de Chrome en un host nativo Windows protegido con DPAPI.

La configuración todavía requiere operaciones explícitas de despliegue:

- en cada PC Windows, abrir `chrome://extensions`, copiar el ID de la
  extensión, ejecutar `powershell -ExecutionPolicy Bypass -File
  .\native-host\install.ps1 -ExtensionId <ID>` desde la carpeta del proyecto,
  reiniciar Chrome y confiar en el certificado HTTPS del servidor;
- configurar la API en la PC que aloja PostgreSQL con
  `DATA_API_HOST=<IP-privada-del-servidor>`, `DATA_API_PORT=3443`,
  `DATA_TLS_CERT_FILE`, `DATA_TLS_KEY_FILE`, `DATA_ALLOWED_EXTENSION_IDS` y
  `DATA_WORKSPACE_ID`. La conexión de API a PostgreSQL debe permanecer en
  `127.0.0.1`; no abrir `5432` en el firewall;
- en Opciones, indicar `https://<IP-privada-o-nombre-LAN>:3443`, dar permiso
  explícito a Chrome y enrolar/importar cada respaldo individualmente;
- no abrir PostgreSQL a la LAN. La API es el único cliente de PostgreSQL.
  La cuenta de base, el cifrado, backups, firewall, revocación, rotación y
  recuperación siguen requiriendo instalación/configuración operativa;
- la extensión crea y conserva un UUID selector por perfil en
  `chrome.storage.local`; el host nativo usa ese selector para recuperar las
  credenciales y la llave HMAC cifradas con DPAPI. No deduce el perfil a partir
  de argumentos del proceso Chrome;
- el token individual identifica en PostgreSQL el perfil y dispositivo del
  enrolamiento y solo persiste cifrado con DPAPI. Las solicitudes autenticadas
  llevan una firma HMAC por dispositivo, con nonce de un solo uso y ventana
  temporal limitada. La prueba de clave se cifra en PostgreSQL con
  `DATA_ENCRYPTION_KEY`. La separación de perfiles depende del UUID local; al
  probar un perfil Chrome nuevo debe generarse un UUID distinto y este nunca
  debe copiarse manualmente entre perfiles;
- las operaciones con servicios externos mantienen sus efectos actuales: la
  API persiste estado e historial, pero no reintenta acciones Ganamos/
  MultiPanel ni aporta una cola durable de operaciones financieras.

La UI de Opciones descifra y valida el respaldo, enrola el perfil, confirma la
importación y conserva la credencial en DPAPI. El respaldo original no se
modifica. El servicio permite descartar staging no confirmado y mantiene los
commits idempotentes; las pruebas de integración usan una base temporal. El
permiso `storage` permanece únicamente para guardar/leer `dataProfileSelector`;
la extensión no guarda allí ajustes, sesiones, movimientos ni credenciales.
Los archivos de respaldo siguen declarando `chrome.storage.local` como
formato/origen heredado para mantener compatibilidad con las exportaciones ya
creadas.

La suite incluye pruebas del descifrado/verificación de archivos y una prueba
de integración HTTPS contra un clúster PostgreSQL temporal: verifica
importación privada, inicialización explícita de datos compartidos, vista
previa de conflictos sin revelar secretos, recepción de valores grandes,
rechazo de firmas inválidas y nonces repetidos, rechazo de duplicados, descarte
de staging y consistencia transaccional. La
integración PostgreSQL es opcional en el uso ordinario y se habilita con
variables `TEST_*`; un certificado autofirmado solo se usa dentro de esa
prueba.

El puerto `5432` debe permanecer accesible solo localmente. El puerto TLS de la
API debe permitirse en el firewall únicamente para la LAN y la IP privada
concreta del servidor. Para despliegue permanente, la API debe ejecutarse como
servicio con un rol PostgreSQL de privilegios mínimos, secretos protegidos y
procedimientos probados de backup/restauración y revocación.

### Componentes

1. **PostgreSQL en un servidor designado de la LAN** será la única fuente de
   verdad de los datos funcionales compartidos. No se instalará una base
   independiente por PC ni se expondrá PostgreSQL directamente a las
   extensiones.
2. **Una API de datos Node** en el mismo servidor o en un host de confianza
   cercano será el único proceso de aplicación con credenciales PostgreSQL.
   Todas las operaciones usarán parámetros/consultas preparadas y transacciones.
3. **El service worker de Manifest V3** será el único cliente de la API desde
   cada perfil de extensión. Las páginas de contenido y opciones le solicitarán
   operaciones mediante `chrome.runtime.sendMessage`.
4. El servidor de datos escuchará en una interfaz LAN designada y un puerto
   configurable, separado del listener local `32145` y del listener de altas
   remotas `32146`. El listener `32146` no se convertirá en API de base de datos.
5. Las operaciones serán específicas y tipadas; ni la extensión ni otros
   clientes podrán enviar SQL arbitrario.
6. PostgreSQL, la API, su configuración, migraciones de esquema y backups se
   desplegarán y administrarán como un servicio central. Los bridges existentes
   en las PC conservarán sus responsabilidades actuales de operaciones y colas;
   no se asumirán como propietarios de la base central.

El flujo normal será:

```text
content script / options page
        │ chrome.runtime.sendMessage
        ▼
service worker ── HTTPS/LAN autenticado ──► API de datos
                                                │
                                                ▼
                                           PostgreSQL
```

La extensión nunca recibe credenciales PostgreSQL. La API valida identidad y
ámbito en cada operación; CORS y la validación del remitente en el service
worker son defensas adicionales, no autenticación. Las páginas web de WhatsApp
o MultiPanel no se conectan directamente a la API ni a PostgreSQL.

### Servidor central, detección y enrolamiento de clientes

La ubicación de la base la determina el servidor/API central, no cada perfil ni
cada PC cliente. El hostname/IP de servicio y puerto se configuran durante el
despliegue (por ejemplo, en configuración administrada de la extensión o del
bridge). Se recomienda un nombre DNS estable o una reserva DHCP para el servidor
y un certificado cuyo SAN cubra ese nombre. No se descubre ni se acepta
automáticamente un servidor encontrado por broadcast. Si se habilita
descubrimiento mDNS/SSDP en una implementación futura,
el resultado solo sirve para sugerir el endpoint: antes de enviar datos debe
validarse la identidad del servidor mediante certificado TLS fijado/confiable y
un enrolamiento aprobado por el administrador.

Al iniciar, el cliente consulta un endpoint autenticado `GET /v1/identity` que
devuelve identificadores no secretos `server_id`, `workspace_id`, versión de
API/esquema y estado de enrolamiento. El cliente comprueba que coincidan con la
configuración/enrolamiento local. No basta con que `/health` responda, ni con
que el endpoint esté en una IP privada. Si el servicio no responde, presenta
una identidad distinta, TLS falla o el perfil/dispositivo no está enrolado, la
extensión falla de forma visible y no escribe en una base local de respaldo ni
crea silenciosamente otro espacio de trabajo.

Para una instalación nueva, primero se lee `GET /v1/server-info` sobre TLS para
mostrar el `server_id` del endpoint configurado; esta respuesta no entrega datos
ni autoriza operaciones. El usuario/administrador verifica ese servidor y
aprueba el código de enrolamiento de un solo uso. Solo después el cliente recibe
credenciales y puede consultar `GET /v1/identity`. En toda conexión posterior
se vuelve a comparar el `server_id`, workspace y perfil. Un `server_id`
inesperado, certificado no válido o endpoint sin configuración aprobada bloquea
la operación y solicita intervención; no se intenta otro host encontrado en la
red automáticamente.

Cada instalación de extensión conserva en IndexedDB solo la identidad bootstrap:

- `installation_id`: UUID aleatorio de esa instalación/perfil Chrome;
- `server_id` y `workspace_id` ya aprobados;
- referencia/credencial opaca de perfil, nunca en logs.

El `device_id` se aprovisiona por separado en cada PC mediante la instalación
administrada del bridge/servicio local y un enrolamiento del administrador. Ese
agente entrega a cada perfil enrolado una credencial individual limitada a
`profile_id`. El agente es requisito para cumplir la detección confiable de PC;
sin él, el sistema puede identificar el perfil enrolado, pero no afirmar desde
qué equipo opera. IndexedDB no es un almacén de secretos fuerte: la
credencial debe ser revocable, de alcance mínimo y rotarse; su confidencialidad
no se basa en ocultarla en JavaScript.

El administrador enrola cada instalación, y el servidor asigna un `profile_id`
opaco dentro del `workspace_id`. La primera conexión requiere un código de
enrolamiento de un solo uso o aprobación explícita; no permite crear espacios de
trabajo arbitrarios. Perfil Chrome e instalación no se deducen del nombre del
usuario, IP, hostname, alias ni token remoto de creación. La misma PC puede
tener varios perfiles Chrome y cada uno debe poder revocarse por separado.

La detección no puede depender únicamente de la IP: DHCP puede cambiarla y
varios perfiles/equipos pueden compartir NAT. Cada petición autenticada lleva
la credencial de perfil más una prueba de posesión de la credencial del
dispositivo; el servidor deriva `profile_id`, `device_id` y `workspace_id` de
credenciales enroladas y nunca confía en IDs libres del cuerpo. El servidor
devuelve la identidad efectiva para que el cliente detecte desconfiguraciones.

Si se pierde IndexedDB o se reinstala la extensión, no se genera una identidad
nueva y se importa automáticamente como si fuese un perfil vacío. Se exige
recuperación/re-enrolamiento, se localiza el perfil existente por su credencial
de recuperación o aprobación administrativa y se comprueba su estado de
migración antes de habilitar escrituras. Revocar un perfil impide futuras
peticiones, pero no borra sus datos históricos.

### PostgreSQL, despliegue y disponibilidad

El servicio requiere instalación reproducible de PostgreSQL y de la API, con
versiones soportadas fijadas, migraciones versionadas, usuario de base con
privilegios mínimos y health checks que prueben la conexión y la versión de
esquema. PostgreSQL solo debe aceptar conexiones del host de la API (firewall y
ACL); la extensión no conecta al puerto SQL. `/health` no indica servicio
saludable hasta verificar API y base. Definir backups verificados, recuperación
PITR o equivalente, retención y procedimiento de actualización antes de
producción.

La API debe imponer límites de concurrencia/timeout, usar transacciones y
reintentos solo para errores transitorios seguros. En errores de conexión,
restricción, timeout, falta de espacio o commit incierto debe devolver error
explícito; nunca confirmar una operación cuyo commit no esté confirmado. No
crear una base nueva ni cambiar de `server_id` como recuperación silenciosa.
Para una LAN sin Internet, el servicio sigue operando localmente si el servidor
y la red LAN están disponibles; cuando no estén, las escrituras quedan
rechazadas/pendientes solo si existe una cola durable idempotente expresamente
especificada. No se simula éxito con almacenamiento local divergente.

#### Registro durable de resultados de operaciones remotas

Las operaciones contra Ganamos/MultiPanel son efectos externos y no pueden
compartir una transacción PostgreSQL con la operación financiera. Antes de
despachar una operación que pueda cambiar dinero, el cliente debe crear en
PostgreSQL un `operation_id` y una intención con estado `prepared`. El servicio
solo autoriza su ejecución una vez y el bridge ejecutor conserva ese mismo ID
durante todo el flujo. Si no se puede registrar la intención, no se envía la
operación externa.

Al recibir un resultado del sitio remoto, el bridge que lo ejecutó lo escribe
primero en un outbox durable local protegido (por ejemplo, en los datos del
bridge, con ACL de Windows y cifrado de los payloads sensibles). El outbox
incluye `operation_id`, resultado/status, hash y hora; nunca vuelve a ejecutar
la acción externa al reintentarse. Después sincroniza idempotentemente el
resultado con PostgreSQL y lo marca confirmado localmente solo tras recibir
confirmación del servidor. Si hay desconexión o commit incierto, conserva el
registro, informa resultado incierto y permite reintentar únicamente la
persistencia del resultado. Al reiniciar, el bridge reenvía resultados
pendientes con el mismo ID; el servidor aplica una única transición permitida
(`prepared` → `succeeded`/`failed`/`uncertain`) y devuelve el resultado previo
en duplicados.

El registro local debe incluir como mínimo `operation_id`, `workspace_id`,
`source_profile_id`, tipo de operación, resultado completo necesario para
crear el movimiento, hash, instante de recepción y estado de sincronización.
Su escritura debe ser durable antes de responder al cliente que el resultado
quedó registrado localmente. PostgreSQL actualiza en una transacción el estado
de `financial_operation_results`, inserta el movimiento con la misma clave de
operación y publica el evento de revisión; solo entonces confirma sincronización.
Si el resultado se repite con otro hash, el servidor lo rechaza y lo marca para
conciliación; no reemplaza el resultado previo. Tras confirmación, el bridge
puede eliminar el payload sensible local según retención operativa, conservando
solo el mínimo recibo no secreto de auditoría requerido.

La intención `prepared` lleva hash del payload esperado y una concesión de
despacho corta, de un solo uso. Una concesión vencida no autoriza automáticamente
un segundo despacho: el estado pasa a `uncertain` y requiere consultar el
resultado remoto o conciliación manual. Así, un timeout no habilita una
repetición potencialmente monetaria.

Este outbox es una excepción acotada para resultados de acciones ya ejecutadas,
no una segunda fuente de verdad ni una cola para ejecutar acciones pendientes.
Debe tener límites/alertas de espacio, protección equivalente a los datos
financieros, política de retención tras confirmación y pruebas de recuperación.
Si el bridge no puede guardar durablemente el resultado, no informa éxito
persistido: muestra estado incierto y requiere conciliación antes de repetir
manualmente la acción. La operación de reconciliación nunca vuelve a enviar el
efecto externo.

## Esquema relacional propuesto

El esquema combina columnas relacionales consultables con copias JSON
compatibles. Las columnas sirven para filtrar/sumar; el JSON conserva todos los
campos originales y permite migrar campos que una versión nueva aún no conozca.
Los JSON de preservación no son una segunda fuente de verdad para lecturas
normales.

No todas las entidades comparten el mismo ámbito. Las filas compartidas se
identifican por `workspace_id`; las preferencias/secretos privados por
`profile_id`; los registros migrados conservan ambos cuando aplique. El servidor
deriva ambos IDs del cliente autenticado y verifica autorización en cada acceso.
Las claves primarias y únicas deben incluir el ámbito que corresponda para
evitar colisiones entre espacios de trabajo o perfiles.

### Versionado del esquema

```sql
CREATE TABLE schema_migrations (
  version       BIGINT PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at_ms BIGINT NOT NULL
);
```

Las migraciones PostgreSQL se aplican en orden dentro de transacciones. No usar
`CREATE TABLE IF NOT EXISTS` como sustituto de versionado: puede ocultar que una
tabla existente tiene columnas o índices incompatibles.

### Identidad y estado de importación

```sql
CREATE TABLE workspaces (
  workspace_id UUID PRIMARY KEY,
  server_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE enrolled_devices (
  device_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  device_public_key BYTEA NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enrolled_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  UNIQUE (device_id, workspace_id)
);

CREATE TABLE extension_profiles (
  profile_id       UUID PRIMARY KEY,
  workspace_id     UUID NOT NULL REFERENCES workspaces(workspace_id),
  device_id        UUID NOT NULL,
  installation_id  UUID NOT NULL UNIQUE,
  source_extension TEXT NOT NULL,
  enrolled_at_ms   BIGINT NOT NULL,
  revoked_at_ms    BIGINT,
  UNIQUE (profile_id, workspace_id),
  FOREIGN KEY (device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id)
);

CREATE TABLE profile_credentials (
  credential_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES extension_profiles(profile_id),
  credential_hash BYTEA NOT NULL UNIQUE,
  permissions_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  revoked_at_ms BIGINT
);

CREATE TABLE data_migrations (
  profile_id         UUID NOT NULL REFERENCES extension_profiles(profile_id),
  migration_id       TEXT NOT NULL,
  source             TEXT NOT NULL,
  status             TEXT NOT NULL
                     CHECK (status IN ('staging', 'validated', 'committed', 'failed')),
  started_at_ms      BIGINT NOT NULL,
  completed_at_ms    BIGINT,
  source_key_count   BIGINT,
  movement_count     BIGINT,
  source_sha256      TEXT,
  report_json        TEXT,
  error_text         TEXT,
  PRIMARY KEY (profile_id, migration_id)
);
```

`migration_id` es estable para reintentos de la misma instantánea fuente. La
misma migración no debe producir dos copias de movimientos.

### Configuración funcional

```sql
CREATE TABLE app_settings (
  profile_id    UUID NOT NULL REFERENCES extension_profiles(profile_id),
  setting_key   TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  revision      BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (profile_id, setting_key)
);
```

`app_settings` guarda cada valor privado original como JSON válido, incluidas
claves conocidas cuyo valor sea `null`, vacío o de tipo inesperado. La capa de
aplicación conserva las mismas validaciones, valores predeterminados y errores
que existen hoy. No guardar defaults recién calculados como si fueran datos
originales durante la importación. La configuración compartida usa una entidad
equivalente con clave `(workspace_id, setting_key)` y control de revisión; no
guardar ajustes compartidos en esta tabla de perfil.

```sql
CREATE TABLE workspace_settings (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  updated_by_profile_id UUID,
  PRIMARY KEY (workspace_id, setting_key),
  FOREIGN KEY (updated_by_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);
```

```sql
CREATE TABLE workspace_revisions (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  revision BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE workspace_change_log (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  revision BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  actor_profile_id UUID,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, revision),
  FOREIGN KEY (actor_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);
```

La API incrementa `workspace_revisions` e inserta el evento en la misma
transacción que el cambio funcional. Los suscriptores pueden usar long polling,
SSE o WebSocket solo como aviso; para recuperar eventos perdidos consultan
`workspace_change_log` desde su última revisión confirmada. El registro no
incluye secretos ni payloads completos. La retención de eventos puede ser
acotada solo si el cliente detecta revisiones antiguas y fuerza una recarga
completa antes de continuar.

Las opciones complejas pueden exponerse como objetos al cliente, pero sus
escrituras deben sustituir el valor completo de forma atómica y versionada.
`activeBonusConfig` se guarda como ajuste del workspace. Los destinos remotos se
guardan por perfil en `extension_state_values` cifrado y se normalizan en
`remote_destinations` con `workspace_id` y `profile_id`; no mantener una copia
editable adicional del arreglo en `workspace_settings`.

La contraseña, tokens, sesión MultiPanel y tokens de destinos son secretos. Se
deben separar en una tabla de secretos, o cifrar antes de almacenarlos, sin
incluirlos en logs, errores, respuestas de diagnóstico ni exportes legibles:

```sql
CREATE TABLE app_secrets (
  profile_id    UUID NOT NULL REFERENCES extension_profiles(profile_id),
  secret_key    TEXT NOT NULL,
  ciphertext    BYTEA NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (profile_id, secret_key)
);
```

`BYTEA` representa aquí el ciphertext, no cifrado automático de PostgreSQL. Los
secretos privados se cifran con una clave protegida por el sistema operativo del
servidor o un gestor de secretos; DPAPI `CurrentUser` de cada PC no sirve para
que otro equipo descifre el valor. La clave no se guarda en la misma base ni en
el repositorio. La API solo descifra en memoria al atender una operación
autorizada. Los secretos de destinos se cifran por perfil. Deben cubrirse
`bridgeToken`, `userCreationPassword`, `multiPanelSession` y el token de cada
destino. La credencial de cliente que autentica la API es independiente de
`bridgeToken`; no se recupera de una configuración de negocio ni se devuelve en
respuestas generales.

Los tokens de destinos no se incluyen en `remote_destinations` serializado ni
en `legacy_json` en claro. El campo `token_ciphertext` contiene solo el
ciphertext; cualquier JSON de preservación de esa tabla omite el token. La API
solo devuelve la configuración descifrada al perfil propietario, por la lectura
autenticada de su estado.

Los ajustes privados quedan en `app_settings`, incluidos `bridgeRole`,
`ganamosUserId`, los sufijos, `agentBalanceView` y `agentBalancesMinimized`.
`activeBonusConfig` reside en la configuración del workspace compartido. El
valor de cada clave se guarda en JSON para distinguir correctamente texto,
booleano, ausencia y otros tipos heredados.

### Destinos remotos

Si se normalizan los destinos, la tabla puede ser:

```sql
CREATE TABLE remote_destinations (
  workspace_id        UUID NOT NULL REFERENCES workspaces(workspace_id),
  profile_id          UUID NOT NULL,
  destination_id      TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  token_ciphertext    BYTEA NOT NULL,
  ganamos_suffix      TEXT NOT NULL,
  multipanel_suffix   TEXT NOT NULL,
  legacy_json         TEXT NOT NULL,
  revision            BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, profile_id, destination_id),
  UNIQUE (workspace_id, profile_id, ordinal),
  FOREIGN KEY (profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);
```

Debe mantenerse el orden del arreglo actual, el `id` (incluidos los IDs
`remote-1`, `remote-2` y `remote-3`), URL normalizada, nombre, sufijos y token.
La lectura para la interfaz devuelve el mismo arreglo ordenado. Los cambios
requieren autorización de administración del workspace y control de revisión
para no perder ediciones concurrentes. Cada perfil Chrome solicita sus propios
permisos `chrome.permissions` para los hosts devueltos. El servicio no debe
alterar la validación actual de URL privada, puerto `32146`, formato de token,
nombre ni sufijos.

### Paneles y contadores

```sql
CREATE TABLE contact_flow_state (
  workspace_id           UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  arrived                BIGINT NOT NULL CHECK (arrived >= 0),
  legacy_unknown_json    TEXT NOT NULL DEFAULT '{}',
  revision               BIGINT NOT NULL DEFAULT 1,
  updated_at_ms          BIGINT NOT NULL
);

CREATE TABLE contact_flow_derived (
  workspace_id    UUID NOT NULL REFERENCES workspaces(workspace_id),
  destination_id  TEXT NOT NULL,
  count           BIGINT NOT NULL CHECK (count >= 0),
  PRIMARY KEY (workspace_id, destination_id)
);

CREATE TABLE contact_flow_counted_numbers (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  phone       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, phone)
);

CREATE TABLE contact_flow_panels (
  workspace_id     UUID NOT NULL REFERENCES workspaces(workspace_id),
  panel_id         TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  title            TEXT NOT NULL,
  keyword          TEXT NOT NULL,
  destination_id   TEXT NOT NULL,
  count            BIGINT NOT NULL CHECK (count >= 0),
  legacy_json      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, panel_id),
  UNIQUE (workspace_id, ordinal)
);

CREATE TABLE contact_flow_panel_counted_numbers (
  workspace_id UUID NOT NULL,
  panel_id    TEXT NOT NULL,
  phone       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, panel_id, phone),
  FOREIGN KEY (workspace_id, panel_id)
    REFERENCES contact_flow_panels(workspace_id, panel_id)
    ON DELETE CASCADE
);

CREATE TABLE applied_workspace_operations (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  operation_type TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);
```

Las tablas se actualizan en una sola transacción. La operación compartida debe
comprobar revisión e incrementar/deduplicar en el servidor; no aceptar
`replace(snapshot)` sin control de versión, porque dos PC podrían sobrescribirse
mutuamente. Para preservar el comportamiento existente, el servicio no debe
reinterpretar palabras clave ni reglas de contabilización; esas reglas
permanecen en la extensión. Las filas con `destination_id` que ya no esté
configurado se conservan: quitar un destino o panel no debe borrar conteos
históricos automáticamente.

Cada llamada que incrementa contadores, incluso un incremento manual que no
tenga teléfono para deduplicar, lleva un UUID `operation_id` generado una vez
por intención del usuario/evento. En la misma transacción, la API inserta el ID
con `operation_type`, hash de la petición y resultado en
`applied_workspace_operations`, y aplica el incremento. Un reintento con el
mismo ID/hash devuelve el resultado original sin volver a incrementar; el mismo
ID con otro hash/tipo se rechaza como conflicto. El cliente conserva ID y
payload hasta respuesta definitiva (en IndexedDB solo como outbox pendiente,
no como copia del estado funcional), de modo que suspender/reiniciar el service
worker no genere un ID nuevo para el mismo intento. Los IDs nuevos se generan
solo para nuevas acciones explícitas.

Para las acciones automáticas vinculadas a un teléfono, la unicidad de
`(workspace_id, phone)` y `(workspace_id, panel_id, phone)` es además la
deduplicación de negocio. El ID de intento y el payload pendiente en IndexedDB
para acciones manuales contienen únicamente la operación de contador, no datos
de contacto. El cliente elimina el registro pendiente solo tras recibir un
resultado definitivo o recuperar el mismo resultado por idempotency key.

### Movimientos

```sql
CREATE TABLE agent_movements (
  workspace_id           UUID NOT NULL REFERENCES workspaces(workspace_id),
  source_profile_id      UUID NOT NULL REFERENCES extension_profiles(profile_id),
  source_device_id       UUID NOT NULL,
  operation_id           UUID,
  legacy_storage_key     TEXT NOT NULL,
  timestamp_ms           BIGINT,
  contact_key            TEXT,
  operation              TEXT,
  amount_minor           BIGINT,
  platform               TEXT,
  username               TEXT,
  transaction_minor      BIGINT,
  bonus_minor            BIGINT,
  from_platform          TEXT,
  to_platform            TEXT,
  status                 TEXT,
  verification_json      TEXT,
  legacy_record_json     TEXT NOT NULL,
  imported_at_ms         BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, source_profile_id, legacy_storage_key),
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id),
  FOREIGN KEY (source_device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id),
  UNIQUE (workspace_id, operation_id)
);

CREATE TABLE financial_operation_results (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  source_profile_id UUID NOT NULL,
  source_device_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'succeeded', 'failed', 'uncertain')
  ),
  result_json TEXT,
  result_sha256 TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id),
  FOREIGN KEY (source_device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id)
);

CREATE INDEX agent_movements_by_contact_time
  ON agent_movements(workspace_id, contact_key, timestamp_ms DESC);

CREATE INDEX agent_movements_by_time
  ON agent_movements(workspace_id, timestamp_ms DESC);

CREATE INDEX agent_movements_withdrawals
  ON agent_movements(workspace_id, contact_key, operation, timestamp_ms DESC);
```

Reglas para esta tabla:

- La clave primaria usa la clave Chrome completa, por ejemplo
  `agentMovement:...`, además de `workspace_id`. Si se importan dos perfiles
  cuyas claves coinciden pero su JSON difiere, no se sobrescribe ni se fusiona
  silenciosamente: se registra el conflicto para resolución explícita.
- Cada movimiento nuevo incluye un `operation_id` idempotente generado antes
  del intento de escritura y único por workspace. Reintentar tras timeout
  devuelve el movimiento confirmado en vez de duplicarlo. `source_profile_id` y
  `source_device_id` son trazabilidad, no filtros de aislamiento de las
  consultas normales del workspace.
- `legacy_record_json` conserva el registro completo recibido, incluidos campos
  desconocidos y diferencias entre versiones.
- El importe se almacena como entero de centavos en las columnas de consulta.
  Mantener el JSON original como representación exacta de origen y rechazar o
  reportar valores no finitos/no convertibles sin perder el registro.
- Un movimiento con campos inválidos para una consulta normal se conserva. Las
  lecturas de la aplicación aplican los mismos filtros actuales antes de
  mostrarlo o sumarlo.
- Los movimientos que no son reconocibles no deben borrarse. Se incluyen en el
  reporte y pueden conservarse con columnas normalizadas nulas más el JSON
  original para permitir recuperación posterior.
- `verification_json` debe preservar el objeto completo. No truncar
  `verificationError` ni transformar ausencia en `null` si el cliente distingue
  esos casos.
- No usar `ON DELETE CASCADE` desde contactos o alias hacia movimientos. El
  historial nunca debe desaparecer por borrar una entidad secundaria.

### Compatibilidad de claves desconocidas

```sql
CREATE TABLE legacy_extension_values (
  profile_id       UUID NOT NULL REFERENCES extension_profiles(profile_id),
  storage_key      TEXT NOT NULL,
  value_ciphertext BYTEA NOT NULL,
  imported_at_ms   BIGINT NOT NULL,
  source_sha256    TEXT NOT NULL,
  PRIMARY KEY (profile_id, storage_key)
);
```

Esta tabla es para claves que no tienen aún una transformación específica y
para valores fuente íntegros de migración. Se cifra porque una clave desconocida
puede contener un secreto no reconocido. Las claves conocidas tienen una
representación canónica en sus tablas propias; si también se conservan allí como
respaldo, marcarlas como legado de solo lectura y no exponer dos fuentes
editables.

## API de datos LAN requerida

La extensión no debe enviar sentencias SQL. La API debe recibir operaciones
validadas, usar consultas parametrizadas y responder un sobre de error uniforme,
por ejemplo `{ ok: false, error: "mensaje seguro", code: "..." }`.

### Autenticación y validación

- Escuchar la API en la interfaz LAN configurada, con TLS obligatorio y
  certificado verificable por todos los clientes. No aceptar HTTP sin cifrar
  para credenciales o datos. Las reglas del firewall limitan los clientes a la
  subred/hosts autorizados.
- El puerto local `32145` continúa ligado a loopback. La nueva API de datos LAN
  tiene puerto/ruta propios, configuración de endpoint y certificado
  administrados; no reutiliza accidentalmente `32145`.
- No agregar endpoints de base de datos al listener remoto `32146`.
- Autenticar cada instalación/perfil con credencial individual revocable y
  autorización por workspace y operación. No reutilizar `primaryToken`,
  `clientToken` ni `remoteCreateToken` como credencial general de base.
- Derivar `server_id`, `workspace_id`, `profile_id` y `device_id` de la
  credencial autenticada; ignorar/rechazar esos campos si el cliente intenta
  elegir un namespace arbitrario en el cuerpo.
- Validar tipo, tamaño, campos y rangos en el servidor; no confiar únicamente
  en la validación del navegador.
- Rechazar origen HTTP no autorizado y mantener CORS limitado a orígenes de
  extensión permitidos. CORS no sustituye autenticación/autorización.
- No devolver datos de otros workspaces. Los datos compartidos son visibles
  solo para miembros enrolados y los datos personales solo para su perfil o
  permisos administrativos expresos.
- No incluir tokens, contraseñas, sesión, SQL, paths sensibles ni payloads
  completos en logs.
- Aplicar límites de petición y timeout. Los errores de PostgreSQL se traducen
  a códigos seguros, pero se registran en el servidor con suficiente detalle no
  secreto para diagnóstico.
- Para identificar la PC y no solo el perfil, el bridge instalado en cada PC
  mantiene una clave de dispositivo protegida por Windows y firma un nonce
  corto emitido por `POST /v1/device-challenge`. El service worker obtiene la
  aserción del bridge por `GET /v1/device-assertion` de loopback autenticado y
  la adjunta a la llamada LAN. La API valida nonce, firma, caducidad y
  asociación perfil-dispositivo. Si no se despliega este agente, el servicio
  solo puede identificar el perfil enrolado, no demostrar de manera fiable qué
  PC lo está usando.
- El endpoint de enrolamiento usa códigos de un solo uso y caducidad, limita
  intentos y requiere aprobación para asociar el perfil al workspace. Una
  respuesta de descubrimiento no enrola automáticamente clientes.

### Operaciones lógicas

Como mínimo se necesitan operaciones equivalentes a:

- `identity.get()` y `identity.enroll(code)`/`identity.revoke()`;
- `profileSettings.get(keys)` y `profileSettings.set(values, expectedRevision)`;
- `workspaceSettings.get(keys)` y `workspaceSettings.set(values, expectedRevision)`;
- `bonusConfig.get()` y `bonusConfig.set(config|null, expectedRevision)`;
- `destinations.get()` y `destinations.replace(array, expectedRevision)`;
- `destinations.useToken(destinationId, purpose)` solo para flujos autorizados,
  si la ejecución no se traslada completamente a una operación proxy del
  servicio;
- `contactFlow.get()` y operaciones atómicas `contactFlow.increment(...)`,
  `contactFlow.panelIncrement(..., operationId)` y reemplazos con
  `expectedRevision`;
- `movements.insert(record, operationId, legacyId)`;
- `financialOperations.prepare(operationId, operation)` y
  `financialOperations.recordResult(operationId, result, resultHash)`;
- `movements.listForContact(contactKey, usernames, filters)`;
- `movements.findRecentWithdrawal(contactKey, cutoff, now)`;
- `movements.findLastWithdrawal(contactKey, now)`;
- `movements.listForAgentBalance(view, contactKey, range)`;
- estado y operaciones de migración descritos más abajo;
- `events.subscribe(afterRevision)` o polling equivalente para cambios
  confirmados en el workspace.

El contrato final puede usar menos rutas HTTP agrupándolas bajo un endpoint
`POST /v1/storage`, pero cada `operation` debe tener un esquema tipado y una
implementación específica. No se permite un endpoint `query` que acepte SQL.

Las escrituras de sustitución completa requieren `expectedRevision` y responden
con conflicto recuperable si otro cliente escribió antes. Contadores usan
incremento/deduplicación transaccional, no read-modify-write en el cliente. Los
cambios confirmados reciben una revisión monotónica por workspace y se publican
mediante outbox durable o polling de revisiones; no dependen de que los service
workers estén activos simultáneamente. Al reconectar, cada cliente consulta
cambios desde su última revisión y refresca la vista.

`financialOperations.prepare` registra el estado `prepared` antes de autorizar
el despacho por el bridge. `recordResult` aplica como máximo una transición
válida por `operation_id` y hash. Una transición conflictiva no sustituye el
resultado confirmado: requiere estado `uncertain` y conciliación explícita.

### Tamaño y transporte de importación

La UI envía lotes cuyo objetivo es 48 KiB, midiendo bytes UTF-8 reales y
manteniendo como máximo 500 entradas. Un valor individual mayor se envía solo,
sin truncarlo; la API impone un máximo de 24 MiB más la envoltura JSON, acorde
con el límite del payload cifrado. El tamaño se comprueba tanto antes de
descifrar como antes de aceptar cada solicitud. Las importaciones grandes
pueden tardar y se pueden reintentar con el mismo `exportId`, porque recibir
dos veces una clave con el mismo hash es idempotente.

## Equivalencia de comportamiento

La capa de acceso a PostgreSQL debe ofrecer al resto de la aplicación operaciones
equivalentes a las actuales. No basta con que “los datos estén en tablas”.

### Opciones

- El formulario seguirá validando modo, ID de agente, letras distintas, tokens,
  contraseña y destinos con las reglas actuales.
- Los permisos de host se solicitan/revocan con `chrome.permissions` exactamente
  como hoy. La escritura PostgreSQL y la actualización de permisos deben tratar sus
  errores por separado y mostrar el estado real de cada paso.
- Al guardar opciones, el resultado solo se muestra como exitoso después de que
  PostgreSQL confirma la transacción.
- Al cargar, los defaults visibles seguirán siendo los actuales: independiente,
  ID de agente predeterminado y sufijos predeterminados donde hoy se aplican.
  Los defaults de UI no se persistirán hasta que el usuario guarde.
- La contraseña y tokens nunca se insertan en HTML no confiable ni se envían en
  respuestas de lectura que no los necesiten.
- La lectura de destinos devuelve metadatos y `tokenConfigured`, no el token
  remoto. La pantalla muestra que hay un token guardado; dejar el campo vacío
  conserva el token existente y escribir uno nuevo lo rota. Quitar el destino
  elimina su token en la misma transacción. La extensión solo obtiene/usa el
  secreto en el flujo autorizado de creación remota, no al listar destinos.

### Sesión MultiPanel

- [content/multipanel.js](./content/multipanel.js) continúa leyendo
  `lux-support-user.session` del
  `localStorage` del sitio y comunica la sesión al service worker.
- El service worker valida origen, frame y formato exactamente como hoy.
- La sesión aceptada se persiste en PostgreSQL bajo el perfil correspondiente.
- Las renovaciones procedentes de `getReport` actualizan la misma fila.
- El perfil secundario sigue sin escribir la sesión del perfil principal.
- Un error de persistencia no debe responder al sitio como si la sesión hubiera sido
  guardada.
- La sesión en el sitio MultiPanel no se borra ni se migra.

### Bono activo y sincronización entre perfiles

- `activeBonusConfig` pasa a tener una única versión canónica por workspace en
  PostgreSQL, conservando la revisión y long polling/eventos existentes. Esto
  amplía intencionalmente la sincronización desde perfiles de una PC a todos los
  perfiles enrolados del workspace.
- Se conservan los tipos y validaciones existentes: `none`, `simple`, `double`,
  `specific`, `special` y `mysterious`.
- `null`/ausencia y una configuración de tipo `none` siguen representando los
  estados actuales; no equipararlos si el flujo actual los distingue.
- Al guardar una configuración se confirma PostgreSQL antes de actualizar el botón
  y cerrar el diálogo.
- Todos los perfiles del workspace actualizan el indicador tras recibir un
  cambio confirmado. Cambios desde cualquier perfil autorizado se persisten en
  el mismo namespace compartido y no se republican en bucle.
- Las revisiones y la notificación de cambios se mantienen en el servicio
  central; PostgreSQL es la fuente persistente y el servicio publica solo
  después del commit.

### Contadores de llegados y derivados

- Persistir cada modificación manual y automática.
- Mantener deduplicación por número y por panel usando las listas de números.
- Mantener los límites seguros de conteo actuales y reportar si se llega a
  ellos.
- Conservar el orden de paneles y destinos que determina la interfaz.
- Actualizar los contadores visibles después de una escritura confirmada.
- Una falla al guardar no puede simular que se persistió el valor. Mostrar el
  error conforme al patrón de la aplicación y permitir reintentar sin duplicar
  el conteo. Cada intento conserva el mismo `operation_id` en reintentos,
  incluso después de suspensión/reinicio del service worker; la API registra
  idempotencia y cambio de contador en una sola transacción.
- Una actualización desde otra instalación/perfil debe refrescar filas y
  configuración del panel, equivalente al listener actual de
  `chrome.storage.onChanged`.

### Movimientos y totales

- Escribir un movimiento solo en los mismos puntos de éxito actuales.
- No guardar una operación fallida como exitosa.
- Mantener los intercambios como un único registro `exchange`; no separarlos en
  depósito y retiro ni incluirlos en esos totales.
- Mantener los depósitos `pending-verification` excluidos de los totales que hoy
  los excluyen y visibles con su advertencia.
- No modificar regla de bono: total acreditado, monto original y bono se siguen
  interpretando como ahora.
- Mantener selección por contacto, plataforma, alias y rango de fechas.
- Mantener filtros “Todo el historial”, rango personalizado y “Desde el último
  retiro”, con los límites horarios actuales.
- Mantener la alerta de retiro reciente: retiro de las últimas 24 horas, mismo
  `contactKey`, plataformas admitidas y timestamp dentro del intervalo actual.
- Mantener el historial general del panel de balances, incluidos los filtros
  por contacto/vista y la ordenación descendente por timestamp.
- No agregar paginación que cambie silenciosamente el total visible o el alcance
  de “Todo el historial”. Para volúmenes grandes, la consulta SQL puede paginar
  internamente, pero debe devolver todos los resultados aplicables.
- El historial debe seguir disponible aunque una consulta a la API remota falle.

### Preferencia del panel

Al cargar `agentBalanceView` y `agentBalancesMinimized`, conservar la precedencia
que aplica hoy el código: se usa una vista reconocida; si no hay una reconocida,
el booleano minimizado determina `minimized`; de lo contrario se usa `balance`.
Al cambiar la vista, guardar ambas claves en una misma transacción para mantener
compatibilidad de semántica.

## Migración de datos ya existentes

El archivo cifrado por perfil descrito en
[MIGRACION_EXPORTACION_IMPORTACION.md](./MIGRACION_EXPORTACION_IMPORTACION.md)
es el artefacto portátil opcional para preparar y transportar las instantáneas.
Su importación debe alimentar el mismo staging y las mismas reglas de
consolidación de esta sección; no crea un segundo mecanismo de escritura ni
autoriza por sí sola un perfil/workspace.

### Regla principal

**No borrar, limpiar ni sobrescribir `chrome.storage.local` durante la primera
importación.** La fuente original queda intacta hasta que los datos importados y
el comportamiento real hayan sido comprobados.

La importación de origen se ejecuta una vez por perfil Chrome. Cada instalación
ya enrolada obtiene del servidor su `profile_id`, `device_id` y `workspace_id`,
toma una instantánea completa de su propio `chrome.storage.local` y la importa
con esa procedencia. El administrador selecciona explícitamente el workspace
de destino antes de importar; que dos clientes estén en la misma LAN no implica
que deban compartir datos ni autoriza unirlos automáticamente.

La migración debe separar filas privadas de filas compartidas según la tabla de
ámbitos. Preferencias y secretos privados se importan al `profile_id` que las
originó. Destinos, bono, contadores e historial asignados al workspace requieren
un plan de consolidación por workspace antes de quedar visibles para todos.
No sumar contadores de perfiles ni unir listas de números automáticamente:
snapshots antiguos pueden contener conteos duplicados. Para cada clave de
destino/bono/contador, la revisión previa muestra coincidencias y conflictos;
un administrador elige una fuente canónica o aprueba una regla de combinación
explícita. Movimientos de perfiles diferentes se conservan con su
`source_profile_id`; claves heredadas coincidentes no se sobrescriben. Posibles
duplicados semánticos se reportan para revisión y no se eliminan comparando solo
importe/contacto/fecha.

### Fase A: preparación

1. Cerrar todas las páginas de WhatsApp que puedan escribir movimientos o
   contadores durante la toma inicial, o implementar un bloqueo/coordinación de
   escritura durante la instantánea. No exportar mientras se está cambiando el
   storage activo sin una estrategia de corte.
2. Detectar el endpoint configurado del servicio, validar TLS y consultar
   `/v1/server-info`; mostrar/confirmar el `server_id`. No descubrir/aceptar un
   host por estar en la LAN ni usar una base local de fallback.
3. Crear/recuperar el `installation_id` en IndexedDB si no existe y completar
   el enrolamiento aprobado. Después consultar `/v1/identity` autenticado y
   comprobar workspace, perfil, versión y estado antes de seguir. Llamadas
   simultáneas deben terminar con la misma identidad; instalación perdida
   requiere recuperación, no identidad nueva silenciosa.
4. Leer todas las claves con `chrome.storage.local.get(null)`.
5. Serializar determinísticamente la instantánea para calcular un SHA-256.
   Guardar temporalmente en IndexedDB solo `migration_id`, checksum, cursor y
   estado; no guardar una copia local adicional del payload. La instantánea
   contiene secretos: no persistirla en logs, archivos ni staging en claro.
6. Contar las claves totales, las claves `agentMovement:*`, paneles, listas de
   números y destinos. Guardar esos totales para la comparación posterior.

### Fase B: staging

1. Enviar `migration_id`, identidad autenticada, versión del formato, checksum
   global y cantidad esperada a la API.
2. El servicio crea un registro `data_migrations` con estado `staging`.
3. Insertar los registros en tablas temporales/de staging identificados por
   `(profile_id, migration_id, storage_key)`.
4. Cada lote contiene claves completas y valores JSON, sin transformación
   destructiva. Repetir un lote con el mismo hash debe ser idempotente. El
   servicio cifra el payload de staging antes de persistirlo y no registra el
   cuerpo HTTP.
5. Para movimientos, preservar la clave heredada completa y JSON del movimiento.
6. Para contadores, preservar primero el objeto original y luego derivar las
   filas normalizadas; no normalizar solo en memoria y descartar el origen.
7. Para secretos y valores heredados, transmitirlos solo por TLS autenticado y
   cifrarlos en el servicio antes de escribirlos en staging o tablas finales.
   Nunca incluirlos en reporte/log.
8. Rechazar JSON inválido, lote alterado, repetición conflictiva de la misma
   clave o checksum inconsistente. La operación debe informar el error y dejar
   intacto el almacenamiento de Chrome.

### Fase C: validar y confirmar

Antes del commit se deben verificar, como mínimo:

- claves recibidas y claves esperadas;
- claves dinámicas de movimientos recibidas y movimientos esperados;
- JSON canónico/checksum de la instantánea;
- tipos, timestamps e importes interpretables;
- claves heredadas desconocidas preservadas;
- configuración, cantidad/orden de destinos, paneles y listas de números;
- cantidad de retiros, depósitos, intercambios y depósitos pendientes;
- ausencia de duplicados por la clave heredada.

Luego, en una transacción PostgreSQL:

1. verificar que perfil, dispositivo y workspace están enrolados y activos;
2. escribir configuración/secrets privados para ese perfil;
3. aplicar al workspace los datos compartidos solo según la decisión de
   consolidación aprobada, sin sobrescribir cambios concurrentes;
4. insertar movimientos con `workspace_id`, `source_profile_id`,
   `source_device_id` y `legacy_storage_key`;
5. conservar las claves desconocidas bajo el perfil de origen;
6. marcar `data_migrations.status = 'committed'` y guardar reporte/checksum;
7. hacer `COMMIT`.

Si cualquier validación o escritura falla, hacer `ROLLBACK` y marcar/reportar
fallo fuera de la transacción cuando sea posible. Un perfil en estado `staging` o `failed` no habilita lecturas funcionales de
sus datos todavía no confirmados; otros perfiles ya activos del workspace
continúan operando.

### Fase D: verificación lado a lado

La extensión debe ofrecer temporalmente una comprobación que compare la fuente
antigua con PostgreSQL sin duplicar escrituras. Comparar, por perfil y por
workspace:

- número de claves totales y desconocidas;
- número de movimientos total y por tipo;
- suma de depósitos, retiros y bonos para un conjunto fijo de pruebas;
- cantidad de depósitos pendientes y movimientos de intercambio;
- primer/último timestamp;
- retiros usados por la alerta de 24 horas;
- `contactKey` para cada movimiento de una muestra;
- llegada, derivados, paneles, orden, conteos y listas deduplicadas;
- valores y tipos JSON de ajustes, excluyendo la visualización de secretos;
- vistas del panel y precedencia de `agentBalancesMinimized`.

Comparar los datos semánticos y no solo el número de filas. Por ejemplo, un
movimiento puede existir pero haber quedado asociado a otro `contactKey`, lo
cual sería una migración fallida.

### Fase E: activar PostgreSQL y conservar rollback

1. Activar PostgreSQL como fuente de lectura/escritura solo si la verificación
   pasa y la consolidación del workspace fue aprobada.
2. Mantener la copia Chrome Storage sin cambios, de solo lectura, durante el
   período de observación acordado.
3. No escribir simultáneamente en PostgreSQL y Chrome Storage como estrategia
   permanente. La escritura doble puede fallar parcialmente y crear divergencia.
4. Registrar la versión del cliente y del esquema usados para activar la base.
5. Si aparece una regresión, no reactivar escrituras independientes en Chrome
   Storage. Detener escrituras, preservar la base autoritativa y ejecutar el
   procedimiento de rollback/reconciliación. Registrar operaciones posteriores
   al corte con sus IDs idempotentes y reconciliarlas antes de reabrir
   escrituras; nunca fusionar a ciegas ni perder commits confirmados.
6. Después de confirmar la operación normal y contar con una copia recuperable,
   retirar el acceso funcional a `chrome.storage.local`. La limpieza de la copia
   debe ser un paso separado, explícito y posterior; no automática durante la
   actualización.

### Reintentos, interrupciones y cambio de versión

- Repetir una importación con el mismo `migration_id`, misma clave y mismo hash
  devuelve el resultado previo sin duplicar.
- Si una clave se repite con contenido distinto, abortar; no “ganar” por orden
  de llegada.
- La interrupción antes de marcar `committed` deja staging recuperable o
  eliminable por un comando explícito, nunca parcialmente visible.
- La actualización del esquema no borra datos heredados ni staging de otra
  versión que siga siendo necesario.
- La extensión debe leer el estado de migración antes de operar. No debe
  asumir que la falta de filas significa que el usuario no tenía datos.
- Si la API, la red LAN o la base no están disponibles durante un guardado,
  informar el error.
  No devolver `ok` y no descartar silenciosamente el movimiento/contador.
- Las operaciones financieras remotas ya ejecutadas no se repiten por fallas de
  persistencia. Su resultado se conserva en el outbox durable del bridge y se
  reintenta únicamente su registro en PostgreSQL con el mismo `operation_id`;
  nunca se reenvía la acción financiera. Si no se pudo persistir el resultado
  localmente, el estado se informa como incierto y se requiere conciliación
  antes de repetir manualmente, igual que los mensajes actuales para
  timeout/incertidumbre.

## Especificación de componentes y brechas operativas

Las siguientes subsecciones conservan los requisitos de diseño y las
comprobaciones de aceptación. No significan que el servicio ya esté instalado
como servicio de Windows, que todos los perfiles hayan sido enrolados ni que
el despliegue LAN se encuentre operativo. La sección «Estado actual» describe
lo implementado en el código.

### [manifest.json](./manifest.json)

- Mantener `storage` únicamente para `dataProfileSelector`, el UUID no secreto
  que el host nativo necesita para distinguir perfiles Chrome.
- Mantener permisos actuales de loopback para el bridge y los permisos
  opcionales del listener remoto.
- Añadir como permiso opcional el origen HTTPS exacto de la API de datos
  configurada, o incluirlo en el manifiesto administrado. Solicitarlo durante
  enrolamiento por perfil Chrome; no pedir comodines de toda la LAN.
- No añadir permisos de archivos ni conexión directa a PostgreSQL al navegador.
- No usar `chrome.storage` para estado funcional; no retirar el permiso mientras
  exista el selector local por perfil.

### [background.js](./background.js)

- Implementar el cliente HTTPS a la API LAN y las operaciones de lectura y
  escritura centralizadas; verificar TLS y la identidad del servidor.
- Validar remitente, origen, frame y forma del mensaje antes de ejecutar
  operaciones, igual que se validan las solicitudes actuales.
- Migrar todos los accesos a settings, secretos, sesión, destinos y bono.
- Mantener IDs/payloads de incrementos manuales pendientes en IndexedDB hasta
  confirmación idempotente; no convertir esa cola en una copia del estado de
  contadores ni almacenar teléfonos en ella.
- Mantener validación, valores por defecto y errores actuales.
- Tratar cada `chrome.runtime.onMessage` de manera compatible con la vida
  efímera del service worker; cada operación debe poder reconectarse si el
  worker se suspende.
- No conectar el service worker directamente a PostgreSQL; credenciales SQL
  solo existen en el servicio central.
- Emitir cambios confirmados a las pestañas pertinentes para reemplazar los
  eventos que hoy se reciben mediante `chrome.storage.onChanged`.

### [options.js](./options.js) y [options.html](./options.html)

- Leer y guardar mediante mensajes al service worker, no directamente en
  `chrome.storage.local`.
- Mantener solicitud/revocación de permisos con `chrome.permissions`.
- Reflejar error de base, servicio no disponible, migración pendiente y éxito
  de guardado con mensajes claros y accionables.
- Evitar exponer secretos a logs o incluirlos en el reporte de diagnóstico.

### [content/whatsapp.js](./content/whatsapp.js)

- Migrar lecturas/escrituras de ajustes, destinos por perfil, contadores,
  movimientos compartidos y vista privada del panel.
- Sustituir los listeners de `chrome.storage.onChanged` por eventos de
  actualización de la API central entregados al service worker.
- Las consultas de historial deben pedir resultados filtrados a la API con
  filtros equivalentes a los actuales; las reglas de negocio y formato de UI
  deben permanecer iguales.
- Usar operaciones atómicas del servidor y revisión esperada para evitar
  sobrescrituras concurrentes entre perfiles/PC.
- Mantener la tolerancia de lectura a registros incompletos sin convertirla en
  pérdida de registros.

### [content/multipanel.js](./content/multipanel.js)

- Seguir leyendo la clave que mantiene MultiPanel en su propia página.
- Enviar la sesión al service worker para validación y persistencia privada por
  perfil mediante la API de datos.
- No abrir conexión local directa desde la página de MultiPanel.
- No borrar la clave del sitio.

### [content/bridge.js](./content/bridge.js)

- Cargar rol y token desde la capa de persistencia autorizada mediante el service worker, o recibir
  del service worker una decisión equivalente.
- No usar `chrome.storage.local.get` para decidir si inicia el bridge.
- Preservar la cola, expiraciones y manejo de errores del bridge actual.

### [bridge/server.js](./bridge/server.js) y bandeja

- El bridge cliente permanece local y conserva el servicio `32145` en loopback
  y el listener remoto `32146` sin cambios funcionales.
- Añadir al bridge local la emisión autenticada de aserciones de dispositivo
  firmadas con una clave protegida por Windows; limitarla a la extensión
  autorizada, nonces breves y origen loopback.
- Desplegar la API de datos como servicio central separado (o modo servidor
  explícito), con TLS y conexión PostgreSQL privada. No enlazarla a `0.0.0.0`
  sin TLS, autenticación y reglas de firewall.
- No guardar credenciales PostgreSQL en la extensión ni en bridges cliente.
- No persistir solicitudes financieras pendientes como cola de ejecución en
  este alcance; la cola de despacho existente conserva su comportamiento.
  Implementar, como excepción requerida, el outbox durable de resultados ya
  ejecutados descrito arriba. Nunca reproducir desde el outbox la acción
  financiera; solo registrar su resultado en PostgreSQL.
- Desplegar PostgreSQL y API de forma reproducible, con migraciones, health
  checks, backups restaurables y actualización coordinada.
- Añadir comprobaciones al arranque y mensajes de error a la bandeja/log sin
  filtrar secretos.
- Conservar sin cambios `credentials.json`, el indicador de altas remotas, las
  reglas del puerto `32146` y su firma HMAC.

## Seguridad, privacidad y respaldo

- PostgreSQL solo acepta conexiones desde la API central mediante red privada y
  firewall; nunca desde la extensión ni mediante el listener de creación remota.
- TLS protege el tránsito. Las credenciales de clientes son individuales,
  revocables, con caducidad/rotación y permisos mínimos. La autenticación no se
  basa en CORS, IP o `profile_id`.
- Proteger credenciales PostgreSQL y claves de cifrado en el almacén de
  secretos del servidor, fuera de la base. Cifrar secretos sensibles en reposo;
  los backups deben tener ACL/cifrado equivalentes.
- La API limita datos por `workspace_id` y `profile_id` derivados de la sesión
  autenticada. Auditar enrolamientos, revocaciones, escrituras compartidas y
  cambios de permisos sin registrar secretos o datos personales innecesarios.
- Definir backups PostgreSQL consistentes, WAL/PITR o mecanismo equivalente,
  retención y pruebas periódicas de restauración. Una copia no probada no se
  considera respaldo recuperable.
- No exponer SQL en `32146`, LAN pública, VPN no autorizada ni endpoints de
  creación remota.
- Los logs registran IDs de migración, conteos y códigos de error, no datos
  personales completos ni valores secretos.
- No borrar filas de historial por política de retención nueva sin aprobación:
  hoy no se encontró caducidad automática.

## Plan de pruebas y criterios de salida

### Pruebas de migración

- Perfil vacío: importa cero claves y queda operativo.
- Perfil con todas las claves conocidas y varios movimientos: sin pérdidas.
- Perfil con claves desconocidas: se preservan en `legacy_extension_values`.
- Perfil con movimiento histórico sin `transactionAmount` o `bonusAmount`: se
  muestra como dato histórico incompleto y no se inventan totales.
- Movimiento con `pending-verification`: conserva estado y detalle.
- Movimiento `exchange`: aparece una sola vez, filtra por cualquiera de las dos
  plataformas y no suma como depósito/retiro.
- Dos perfiles Chrome importados: preferencias/sesiones privadas permanecen
  aisladas; los datos compartidos llegan al workspace solo tras la
  consolidación aprobada, y cada movimiento conserva su perfil de origen.
- Repetir importación idéntica: no duplica filas.
- Repetir una clave con hash diferente: aborta y no altera la importación
  confirmada.
- Interrumpir el proceso antes/después de cada lote y antes del commit: el
  staging se recupera sin hacer visibles datos parciales.
- JSON grande/listas grandes: lotes por bytes, sin truncamiento ni exceder el
  límite de petición.

### Pruebas de compatibilidad funcional

- Abrir opciones, editar/guardar valores, reiniciar Chrome y confirmar que
  reaparecen igual.
- Confirmar modo independiente, principal y secundario, incluidas sesiones y
  sincronización del bono.
- Iniciar/cambiar sesión MultiPanel y verificar renovación desde `getReport`.
- Consultar movimientos por contacto y sin contacto en vistas diaria, semanal,
  mensual y total.
- Aplicar filtros por plataforma, rango personalizado y desde el último retiro.
- Verificar totals, bono, diferencia, registros incompletos y estados pendientes.
- Verificar alerta de retiro de 24 horas, expiración y último retiro.
- Incrementar/reiniciar contadores manuales y automáticos; confirmar que la
  deduplicación de números no cambia.
- Añadir, editar y quitar paneles; conservar contadores de destinos anteriores.
- Simular bridge detenido, base bloqueada, disco lleno, permisos denegados,
  timeout y error de cifrado; mostrar error y no indicar éxito falso.
- Confirmar que si falla guardar después de una operación remota, no se reenvía
  automáticamente una operación monetaria.
- Dos perfiles Chrome en una PC y perfiles en PC distintas enrolados al mismo
  workspace ven las mismas destinaciones, bono, contadores e historial
  compartido después de refrescar/reconectar.
- Preferencias y sesiones privadas de esos perfiles siguen aisladas; revocar un
  perfil impide nuevas lecturas/escrituras sin borrar el historial atribuido.
- Un cliente en otro workspace, sin enrolar o con credencial revocada no puede
  leer ni escribir los datos.
- Probar servicio inaccesible, certificado incorrecto, endpoint con otro
  `server_id`, cambio de IP del cliente, DHCP del servidor y conflicto de
  revisión; no crear una base/identidad alternativa ni indicar éxito falso.
- Probar escrituras simultáneas de movimientos, contadores y destinos desde
  varias PC, duplicación de peticiones tras timeout y reconexión de eventos.
- Simular respuesta perdida después de que un incremento fue confirmado; el
  reintento con el mismo `operation_id` no incrementa por segunda vez. Reusar
  ese ID con payload diferente debe producir conflicto.
- Suspender/reiniciar el service worker con un incremento manual pendiente; al
  reanudar, reutiliza el mismo ID y no duplica el contador.
- Simular caída/desconexión de PostgreSQL luego de una operación financiera
  externa: al reiniciar, el bridge solo sincroniza el resultado durable y no
  vuelve a ejecutar la acción externa.
- Confirmar que el listener remoto no puede leer/escribir la base y que
  PostgreSQL no es accesible directamente desde los clientes.
- Reiniciar API/PostgreSQL y comprobar restauración, migraciones de esquema,
  backups y health checks.

### Gate antes de retirar Chrome Storage

No retirar el permiso ni limpiar la fuente antigua hasta cumplir todo lo
siguiente:

- todos los perfiles activos importados tienen estado `committed`;
- los conteos y checksum de cada instantánea coinciden;
- la lista de errores/valores anómalos fue revisada;
- pruebas de comportamiento anterior/nuevo pasan en escenarios reales;
- existe respaldo recuperable de cada fuente;
- rollback documentado y probado;
- no quedan usos funcionales de `chrome.storage.local`, listeners de cambios
  ni lecturas dinámicas con `get(null)`; la única clave local permitida es el
  UUID no secreto `dataProfileSelector`;
- cada perfil/instalación está enrolado al workspace correcto y su
  `server_id`/certificado fue validado;
- la API/PostgreSQL se despliega y restaura de acuerdo con el procedimiento
  operativo; el servidor no crea workspaces alternativos silenciosamente.

## Decisiones que no se deben tomar implícitamente

1. **Ámbitos:** bono, contadores e historial son compartidos dentro del
   workspace designado; destinos de creación remota y preferencias/sesiones
   indicadas son privados por perfil. No crear workspaces ni compartir datos
   por detección de LAN sola.
2. **Eliminación de datos Chrome antiguos:** es un paso posterior separado, no
   parte de la primera importación.
3. **Migración de `credentials.json`:** queda fuera; no mezclar credenciales de
   autenticación del bridge con ajustes de la extensión.
4. **Cifrado:** PostgreSQL no cifra por sí solo los secretos a nivel de
   aplicación; especificar y probar TLS, cifrado en reposo, gestión de claves y
   restauración de backups.
5. **Detección/enrolamiento:** endpoint administrado y credencial individual
   determinan workspace/perfil; no usar descubrimiento de red como autorización.
6. **Retención:** no agregar borrado automático de movimientos ni contadores.
7. **Mensajes de error y operaciones monetarias:** nunca ocultar fallos de
   persistencia ni reintentar depósitos/retiros automáticamente.
8. **Disponibilidad:** sin acceso al servidor central no hay escrituras
   confirmadas. No habilitar almacenamiento local paralelo ni sincronización
   automática divergente.

## Resumen de decisiones recomendadas

- PostgreSQL central en un servidor designado de la LAN, detrás de una API
  autenticada con TLS; nunca exponer el puerto SQL a la extensión.
- Identidad y enrolamiento separados por workspace, PC e instalación/perfil
  Chrome; endpoint de servidor administrado, no descubierto automáticamente.
- Destinos, bono, contadores e historial compartidos por workspace; ajustes y
  secretos privados en el perfil correspondiente, según la tabla de ámbitos.
- El service worker es el único cliente de la API desde la extensión; las
  credenciales SQL permanecen solo en el servicio central.
- Ajustes JSON-tipados en tablas relacionales, secretos cifrados aparte,
  contadores/paneles normalizados y movimientos como filas con clave heredada y
  JSON de preservación.
- Importación completa por staging, lotes acotados, checksum, validación,
  transacción e idempotencia.
- Conservación de la fuente antigua hasta validar la equivalencia y probar
  rollback.
- `localStorage` del sitio MultiPanel, permisos Chrome y archivos de credenciales
  del bridge se mantienen en sus ámbitos actuales; cada perfil solicita los
  permisos de host que requiere para la API/destinos.
