# Exportación e importación de datos por perfil Chrome

## Objetivo

Este documento especifica una función previa a la migración a PostgreSQL para
exportar y reingresar, de forma verificable, los datos funcionales de un perfil
Chrome de la extensión.

Cada archivo representa **un solo perfil Chrome**. No se intenta leer los demás
perfiles del navegador, de Windows o de otras PC: Chrome aísla
`chrome.storage.local` por perfil y la extensión solo tiene acceso al perfil en
que está ejecutándose. Para respaldar varios perfiles, se repite la exportación
en cada uno y se etiqueta cada archivo fuera de su contenido sensible.

El respaldo es un artefacto de transporte entre estructuras/versiones, no una
segunda fuente activa de datos ni una sincronización automática. El archivo se
puede conservar offline hasta que la base central esté lista.

## Alcance del respaldo

### Incluido

La exportación lee la instantánea completa mediante
`chrome.storage.local.get(null)`, no una lista fija de claves conocidas. De esa
forma incluye claves heredadas, datos creados por versiones futuras y claves
desconocidas:

- ajustes del perfil, como rol, ID de agente, sufijos y vista del panel;
- secretos que la extensión ya guarda, como `bridgeToken`,
  `userCreationPassword`, sesión MultiPanel copiada a Chrome Storage y tokens
  de destinos remotos;
- `remoteCreateDestinations`, con su orden, IDs y valores exactos;
- `activeBonusConfig`, incluidos ausencia/null y sus variantes;
- `contactFlowCounters`, incluyendo paneles, contadores, orden y listas de
  teléfonos usados para deduplicar;
- todas las claves `agentMovement:*`, incluidos registros incompletos,
  pendientes, intercambios y campos que versiones previas no reconozcan;
- cualquier otra clave de `chrome.storage.local`.

No se interpreta ni corrige el contenido durante la exportación. Se conserva el
valor original y su tipo JSON; una migración posterior puede normalizar los
campos sin perder la representación de origen.

### Excluido deliberadamente

- `chrome.storage.sync`, IndexedDB de la extensión y otros perfiles Chrome.
- Permisos concedidos por `chrome.permissions`; deben solicitarse de nuevo en
  cada PC/perfil.
- `localStorage` del sitio MultiPanel, incluida la clave
  `lux-support-user.session`. El respaldo puede incluir únicamente la copia de
  sesión que la extensión mantenga en `chrome.storage.local`.
- `credentials.json`, claves de dispositivo, credenciales PostgreSQL, outbox
  local del bridge, logs y demás archivos bajo `%LOCALAPPDATA%`.
- Estado efímero que solo existe en memoria.

Esta herramienta no respalda Windows, Chrome ni las carpetas de datos del
bridge; no debe presentarse como un backup integral del equipo.

## Interfaz en Opciones

Agregar una sección independiente **Respaldo de este perfil Chrome** a
`options.html`/`options.js`:

- **Exportar perfil**: crea y descarga un archivo cifrado del perfil que tiene
  abierta esa página de opciones.
- **Importar a PostgreSQL**: selecciona un archivo, lo descifra y lo entrega al
  proceso de importación/staging de PostgreSQL descrito en
  [MIGRACION_POSTGRESQL.md](./MIGRACION_POSTGRESQL.md).
- Mostrar estado de servicio, workspace/perfil destino, versión del archivo,
  cantidades y diferencias antes de confirmar la importación.
- Deshabilitar el envío/confirmación hasta que el archivo haya sido validado y
  el servicio destino haya confirmado su identidad.
- El texto de estado nunca muestra contraseñas, tokens, sesiones ni valores de
  datos. No registrar payloads o passphrases en logs.

La pantalla debe advertir que la exportación actual corresponde solo al perfil
Chrome que está usando las opciones. Se recomienda que el usuario indique un
nombre/etiqueta descriptiva para el nombre de descarga
(por ejemplo `respaldo-perfil-operaciones-2026-10-09.json`); esa etiqueta es
solo para el usuario, se sanitiza para formar el nombre y no se trata como
identidad autenticada. No incluir secretos ni datos personales en ella.

La descarga puede implementarse en la página de opciones con un `Blob`, URL
temporal y enlace de descarga activado por la acción del usuario. La importación
usa un `<input type="file">` con selección explícita. No se requieren permisos
de filesystem, acceso a rutas arbitrarias ni permiso de descarga si no lo exige
la implementación elegida.

## Formato de archivo

Usar JSON UTF-8 versionado, con un sobre exterior pequeño y un payload completo
cifrado. El archivo no debe contener valores de configuración, nombres de
claves, conteos ni hashes sin cifrar.

### Sobre exterior v1

```json
{
  "format": "bridgewpp-profile-archive",
  "formatVersion": 1,
  "encryption": {
    "algorithm": "AES-256-GCM",
    "kdf": "PBKDF2-SHA-256",
    "iterations": 600000,
    "salt": "<base64>",
    "iv": "<base64>"
  },
  "ciphertext": "<base64>"
}
```

El `ciphertext` es AES-GCM del documento interior en UTF-8. El encabezado
canónico (formato, versión, algoritmo, KDF, iteraciones, salt e IV) se usa como
Additional Authenticated Data (AAD). La autenticación del cifrado debe fallar si
se altera cualquier campo del encabezado o ciphertext.

La versión 1 fija AES-256-GCM, PBKDF2-HMAC-SHA-256, 600 000 iteraciones, salt
aleatoria de al menos 16 bytes e IV/nonce aleatorio de 12 bytes nunca reutilizado
con la misma clave. El lector rechaza algoritmos desconocidos, iteraciones fuera
del valor permitido para la versión, salt/IV/ciphertext mal formados y archivos
por encima del máximo implementado antes de ejecutar KDF. No aceptar parámetros
KDF arbitrarios del archivo: impedir valores bajos que debiliten la derivación y
valores enormes que provoquen denegación de servicio.

El passphrase se solicita dos veces al exportar y una vez al importar; mínimo
16 caracteres y máximo 1024, con recomendación de frase larga única. No se
guarda en Chrome Storage, IndexedDB, el archivo, logs ni servidor. La clave AES se deriva en
memoria con Web Crypto, se usa una vez y se descarta al completar la operación.
Perder el passphrase significa que el contenido no puede recuperarse. No hay
password de recuperación ni bypass administrativo.

### Payload interior v1

Después del descifrado, el JSON interior tiene esta forma:

```json
{
  "format": "bridgewpp-profile-payload",
  "formatVersion": 1,
  "exportId": "uuid-aleatorio",
  "exportedAt": "2026-10-09T00:00:00.000Z",
  "source": {
    "extensionId": "id-de-la-extension",
    "storageArea": "chrome.storage.local"
  },
  "integrity": {
    "keyCount": 12,
    "movementCount": 320,
    "canonicalSha256": "hex-sha256"
  },
  "entries": [
    {
      "key": "bridgeRole",
      "value": "primary",
      "valueSha256": "hex-sha256"
    }
  ]
}
```

Requisitos:

- `exportId` es aleatorio y único por exportación. No identifica al usuario,
  perfil ni PC.
- `exportedAt` es informativo, no una prueba de autenticidad.
- `entries` contiene exactamente una entrada por clave, ordenada
  lexicográficamente por `key`. Las listas/arreglos internos conservan su orden.
- `value` preserva el tipo y contenido JSON original, incluida la distinción
  entre clave ausente y una clave presente con `null`.
- `valueSha256` es SHA-256 del valor codificado en JSON canónico. El hash global
  es SHA-256 de la serialización canónica de
  `{format, formatVersion, entries:[{key,value},...]}`. Excluye `integrity`,
  `exportId`, `exportedAt` y `source`, para que el digest no sea autorreferente
  y pueda recalcularse sin ambigüedad. El proceso valida hashes individuales y
  global tras descifrar y antes de usar cualquier dato.
- La serialización canónica ordena recursivamente las propiedades de objetos,
  conserva el orden de arreglos, rechaza valores no finitos/no JSON y define
  explícitamente el encoding UTF-8.
- El identificador `extensionId` sirve solo para compatibilidad/diagnóstico;
  no es identidad de confianza. Un archivo creado por una extensión con otro
  ID puede importarse después de validación y confirmación explícita.

Un archivo válido no se considera confiable solo porque descifre: alguien con
el passphrase puede haber creado contenido deliberadamente malformado. Toda
entrada se trata como datos no confiables; no se evalúa como JavaScript ni se
usa para formar HTML, SQL, rutas de archivo o comandos.

## Exportación

1. El usuario abre las opciones del perfil Chrome que quiere respaldar y pulsa
   **Exportar perfil**.
2. La extensión muestra el alcance: perfil Chrome actual, número de claves y
   movimientos; advierte que el archivo incluye secretos cifrados y que se debe
   guardar el passphrase por separado.
3. Se solicita dos veces el passphrase. No se permite exportar sin cifrado en
   la primera versión.
4. El código obtiene `chrome.storage.local.get(null)` y forma una instantánea
   inmutable en memoria. Se verifica que todos los valores se serializan como
   JSON y que no se omitieron claves.
5. Calcula metadatos y hashes, genera `exportId`, salt e IV criptográficamente
   aleatorios, deriva la clave y cifra el payload completo.
6. Solo después de terminar cifrado/validación inicia la descarga con extensión
   `.json`. No altera ni limpia los datos de Chrome.
7. La interfaz informa éxito con nombre y tamaño del archivo, nunca con valores
   internos. En error, indica que no se generó un respaldo completo; no descarga
   un archivo parcial que parezca válido.
8. Libera referencias a passphrase, clave, payload y Blob lo antes posible; revoca
   la object URL luego de la descarga.

El código no debe guardar una copia temporal sin cifrar en disco/IndexedDB, ni
mandar el payload a la API para exportarlo. La implementación inicial permite
hasta 100 000 claves, 24 MiB de payload UTF-8 antes de cifrar y 32 MiB para el
archivo `.json` final. Si el navegador no puede procesar el tamaño, debe fallar
explícitamente sin truncar. Estos límites se muestran en la interfaz y se
prueban con un perfil al máximo permitido por Chrome. No inventar un respaldo
parcial ni partir en archivos que el importador no pueda verificar como un
conjunto completo.

## Importación hacia PostgreSQL

### Destino y significado

La acción **Importar a PostgreSQL** toma una copia de un perfil y la usa como
fuente para la migración. No restaura automáticamente `chrome.storage.local`,
no altera el perfil origen y no replica el archivo a otras PC.

El usuario selecciona explícitamente workspace destino y perfil destino
autenticados. El servicio determina el `profile_id`, `device_id` y
`workspace_id` por credenciales; no usa IDs declarados por el archivo como
autorización. El archivo se puede importar desde otro perfil/PC que tenga
permiso, pero su `source` se conserva como procedencia y no sustituye al
perfil autenticado.

La importación al modelo PostgreSQL se hace mediante el mismo staging,
validación, control de idempotencia y consolidación de datos compartidos
definidos en [MIGRACION_POSTGRESQL.md](./MIGRACION_POSTGRESQL.md). No se debe
implementar un segundo parser de negocio o un endpoint SQL de importación.

### Pasos de importación

1. El usuario selecciona un archivo `.json` y escribe el passphrase.
2. El cliente limita tamaño antes de parsear, valida estrictamente el sobre,
   versión, campos, codificación Base64 y parámetros criptográficos permitidos.
3. Descifra en memoria con Web Crypto. Un error de passphrase o autenticación
   detiene el flujo; no se ofrece importar el contenido parcialmente.
4. Valida el JSON interior, tipos, unicidad de claves, cantidades, hashes,
   checksum canónico, conteo de movimientos y límites admitidos. Rechaza claves
   duplicadas, valores JSON inválidos, versión desconocida o checksum distinto.
5. El servidor central valida TLS, `server_id`, identidad del perfil y
   workspace, permisos de importación y estado de migración. Un servicio
   inaccesible o con otra identidad bloquea la operación; no hay fallback local.
6. Antes de subir datos, presenta una vista previa sin secretos:
   - etiqueta que el usuario asigna al archivo;
   - fecha y versión de exportación;
   - claves totales/desconocidas y movimientos por tipo/estado;
   - perfil/workspace destino autenticados;
   - entidades privadas frente a compartidas;
   - conflictos de claves, destinos, bonos, contadores y movimientos heredados;
   - permisos de Chrome que deberán solicitarse luego por separado.
7. El usuario confirma el destino y el plan de consolidación compartida. Los
   datos no se hacen visibles todavía.
8. El cliente envía por TLS lotes limitados por bytes al staging autenticado.
   Se transmite el JSON de origen y se cifra el staging del lado del servidor.
   Nunca se escribe el passphrase ni el plaintext en logs.
9. El servidor valida checksum/cantidades de nuevo, aplica las reglas de ámbito
   y conflictos de [MIGRACION_POSTGRESQL.md](./MIGRACION_POSTGRESQL.md), y
   presenta el resultado de validación.
10. Un segundo acto explícito confirma el commit. El servicio confirma por
    `exportId`/hash para que repetir la solicitud no duplique datos. Si el mismo
    `exportId` aparece con otro checksum, rechaza la operación.
11. Solo tras commit se muestra éxito. El archivo permanece intacto y el usuario
    puede guardarlo como respaldo offline.

No mezclar de forma automática contadores/deduplicación de varios perfiles. No
deduplicar movimientos por contacto, monto y fecha solamente. Los conflictos se
resuelven mediante las reglas administrativas de consolidación, conservando el
archivo original.

## Importación/restauración al Chrome anterior

La restauración directa a `chrome.storage.local` es un flujo distinto y no es
necesaria para importar los datos a PostgreSQL. No debe reutilizarse el botón
**Importar a PostgreSQL** ni aplicarse automáticamente al abrir un archivo.

Si se implementa una acción separada **Restaurar en este perfil Chrome**:

- debe advertir que afecta solo al perfil actual y mostrar una vista previa;
- antes de cambiar nada, debe generar y verificar un respaldo cifrado de la
  instantánea actual, guardarlo mediante descarga y requerir confirmación;
- no debe sobrescribir claves con conflictos sin mostrar los cambios;
- debe escribir primero a una clave de staging versionada y aplicar un journal
  de recuperación que sobreviva al cierre del service worker;
- dado que `chrome.storage.local` no ofrece transacción multi-clave, debe
  conservar la copia anterior hasta verificar todos los valores restaurados;
- ante interrupción o error, debe ofrecer volver al estado anterior desde el
  journal; nunca borrar toda el área para después intentar reconstruirla;
- solo elimina claves que pertenecen al estado anterior si el usuario eligió
  explícitamente reemplazar perfil completo. Un modo merge nunca elimina claves;
- no importa permisos de Chrome ni valores al `localStorage` del sitio.

No habilitar esta función hasta contar con pruebas de interrupción en cada paso.
La implementación inicial puede limitarse a exportar e importar a PostgreSQL,
que es el caso de migración previsto.

## Idempotencia, conflictos y múltiples respaldos

- La unidad de importación privada es
  `(target_profile_id, exportId, canonicalSha256)`. La consolidación de datos
  compartidos usa además un identificador de consolidación único por workspace;
  así, repetir el archivo para otro perfil no omite accidentalmente sus ajustes
  privados ni vuelve a sumar snapshots compartidos.
- Una repetición idéntica devuelve el resultado previo y nunca duplica
  movimientos.
- Igual `exportId` con distinto hash se rechaza.
- Importar el mismo contenido desde dos respaldos distintos se reporta como
  posible duplicado; no se considera idéntico solo por coincidir el conteo.
- Una clave heredada duplicada con distinto valor genera conflicto y mantiene
  ambas fuentes en staging/reporte para revisión; no gana la última llegada.
- El perfil fuente del archivo no se considera autenticación ni destino final.
- Las fuentes compartidas se consolidan una sola vez por workspace con
  aprobación explícita; no se importan una vez por cada PC sin revisar porque
  los snapshots pueden ser copias del mismo estado.
- Los errores de transporte permiten reintentar el mismo lote/ID. Si el estado
  del commit es incierto, el cliente consulta el estado de esa importación antes
  de volver a enviar o crear otra.

## Privacidad y seguridad

- El JSON exterior solo contiene campos del algoritmo y ciphertext; incluso
  claves, conteos, perfil, nombres de destino y fechas internas van cifrados.
- El archivo es un secreto portátil: quien tenga archivo y passphrase puede
  leer secretos como tokens de bridge/destinos y sesión MultiPanel. La UI avisa
  antes de exportar y recomienda almacenamiento cifrado/restringido.
- Nunca colocar el passphrase en nombre de archivo, clipboard, logs, URL,
  query-string o telemetry.
- No mostrar ni registrar el contenido durante vista previa/diagnóstico. Para
  destinos, mostrar URL/nombre si la política de permisos lo permite, pero
  ocultar tokens. Para sesión y contraseñas, mostrar solo “incluido”.
- No aceptar rutas de archivo del JSON ni seguir URLs contenidas como resultado
  de la importación.
- Validar esquema con límites de profundidad, longitud, número de claves,
  movimientos y tamaño total para evitar agotamiento de memoria/CPU.
- Validar KDF y tamaños antes de derivar claves; no permitir que valores del
  archivo configuren un número arbitrario de iteraciones o memoria.
- Las respuestas y errores de API no reflejan token, passphrase ni valores
  importados.
- La autenticación de la API procede del enrolamiento actual, nunca del archivo,
  `exportId`, `profile_id`, `workspace_id` o IP.
- Mantener TLS y controles de acceso; el cifrado del archivo no reemplaza la
  autenticación para importar a PostgreSQL.
- Borrar referencias a texto claro lo antes posible, entendiendo que JavaScript
  no garantiza borrado seguro de memoria ni del garbage collector. Por ello se
  minimiza el tiempo de exposición y no se usa almacenamiento persistente local
  para plaintext.

## Pruebas requeridas

### Exportación

- Perfil vacío produce archivo válido con cero claves.
- Perfil con todas las claves conocidas, desconocidas y múltiples movimientos
  produce conteos correctos y el mismo hash al verificar.
- Preserva `null`, tipos heredados, ausencia, orden de destinos/paneles, campos
  desconocidos, `pending-verification`, `exchange` y datos incompletos.
- Dos perfiles Chrome exportados sucesivamente producen respaldos separados;
  un archivo nunca incluye claves del otro perfil.
- Passphrase incorrecto no descifra; archivo o AAD alterados fallan la
  autenticación.
- Reutilizar salt/IV está prohibido y se prueba con exportaciones repetidas.
- Tamaño máximo, Unicode, caracteres no ASCII, JSON profundo y volumen alto:
  éxito completo o error explícito, nunca truncamiento.
- Descargar/guardar/cancelar no cambia `chrome.storage.local`.

### Importación a PostgreSQL

- Archivo válido se previsualiza sin mostrar secretos.
- Archivo truncado, corrupto, alterado, de versión desconocida, con claves
  duplicadas, hash inválido o KDF fuera de rango se rechaza antes del staging.
- Perfiles privados se mapean al perfil autenticado y ámbitos compartidos al
  workspace aprobado; los IDs del archivo no pueden cambiar el destino.
- Varios archivos con movimientos heredados coincidentes crean conflicto y no
  sobrescriben ni duplican silenciosamente.
- Respuesta perdida luego de staging o commit se recupera consultando el mismo
  `exportId` y hash.
- Servicio no disponible, TLS erróneo, otro `server_id`, perfil revocado,
  workspace distinto o permiso insuficiente impiden commit.
- Interrupción durante lotes deja datos no visibles y staging recuperable o
  descartable por acción explícita.
- Simular errores nunca borra/modifica el archivo ni el storage original.
- Confirmar que las autorizaciones/permisos de Chrome se vuelven a solicitar en
  cada perfil y no se importan del archivo.

### Compatibilidad y operación

- Probar con los perfiles principales, secundarios y perfiles adicionales que
  conectan a otra PC: la exportación corresponde al perfil seleccionado, pero
  el importador lo puede asignar al workspace configurado tras autorización.
- Confirmar que este mecanismo no cambia puertos `32145`/`32146`, roles
  `primary`/`secondary`, destinos remotos ni el enrutamiento actual.
- Documentar procedimiento de nombrado/archivo para que el operador distinga
  perfiles sin poner datos sensibles dentro del JSON exterior.
- Documentar retención/custodia de los archivos y destrucción segura al terminar
  la ventana de migración, según política del equipo.

## Criterios para habilitar en producción

- Exportación/descifrado/importación probados con una copia de prueba de cada
  tipo de perfil, sin reemplazar los datos originales.
- Formato v1, cifrado, parámetros KDF y canonicalización fijados en pruebas de
  compatibilidad.
- Restauración directa a Chrome Storage permanece deshabilitada salvo que su
  journal/recovery haya sido probado por separado.
- El pipeline de importación de PostgreSQL aplica staging, consolidación e
  idempotencia de [MIGRACION_POSTGRESQL.md](./MIGRACION_POSTGRESQL.md).
- Operadores saben que se exporta un perfil a la vez y que los archivos incluyen
  secretos cifrados.
- Existen al menos dos copias verificadas por perfil antes de retirar la fuente
  Chrome; una copia no se borra hasta validar los datos en PostgreSQL y probar
  recuperación.
