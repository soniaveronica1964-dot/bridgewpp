# Puesta en marcha de una PC de Publi

Guía para conectar una PC nueva a los datos PostgreSQL de la LAN y usarla
principalmente para WhatsApp y altas remotas. La PC de Publi no necesita tener
sesiones locales de Ganamos ni MultiPanel: las altas se envían a una PC destino
que sí tenga esas sesiones abiertas.

## Cómo se conectan los componentes

- **API PostgreSQL**: servicio HTTPS en la PC principal. La extensión usa esta
  API para importar y guardar el estado del perfil; Chrome no se conecta
  directamente a PostgreSQL.
- **Bridge de altas remotas**: servicio independiente en una PC que tenga
  Ganamos y MultiPanel iniciados. La extensión de Publi se conecta a su puerto
  `32146` para solicitar altas.
- **PC de Publi**: usa WhatsApp y mantiene su propia configuración de destinos.
  No se configura como perfil **Secundario**: ese modo es para el bridge local
  entre perfiles de Chrome de una misma PC, no para conectarse por la LAN.

## Datos que hay que tener a mano

Pedile al responsable de la PC principal, antes de empezar:

- IP privada fija o reservada de la API PostgreSQL y puerto HTTPS. En la
  instalación ya configurada de esta LAN es `https://192.168.1.18:3443`; si
  cambia la IP reservada, usá la nueva dirección y verificá que el certificado
  TLS incluya esa IP.
- Archivo público de la CA raíz de BridgeWPP (`.cer`) para confiar en el
  certificado HTTPS de la API. No copies una clave privada de la CA.
- Archivo de respaldo cifrado del perfil que se quiere importar y su frase de
  contraseña.
- Código de enrolamiento de un solo uso para esta PC/perfil. Dura 20 minutos:
  pedilo cuando estés listo para importar.
- Para cada PC que vaya a recibir altas: nombre visible, IP privada, puerto
  `32146`, `remoteCreateToken` y los sufijos Ganamos/MultiPanel de esa PC.

El archivo de respaldo y su frase de contraseña, los códigos de enrolamiento y
los tokens son secretos. Compartilos solo por un medio seguro y no los pegues
en tickets, chats públicos ni capturas.

## 1. Comprobar la PC principal y las PC destino

En la PC principal:

1. Confirmá que PostgreSQL y la API estén activos. La API debe responder en
   `https://<IP-privada>:3443/health`.
2. Reservá la IP de la API en el router o usá un nombre LAN estable. El
   certificado TLS debe cubrir exactamente el nombre o la IP que se usará.
3. Permití el puerto HTTPS de la API en el firewall solo desde la LAN necesaria.
   **No** abras el puerto PostgreSQL `5432` a la red.
4. Confirmá que el ID de la extensión de Chrome que se instalará en Publi esté
   permitido en `DATA_ALLOWED_EXTENSION_IDS`. El ID se obtiene en
   `chrome://extensions` después de cargar la extensión. Si se modifica la
   lista, reiniciá la API.
5. Para cada equipo que recibirá altas, verificá que el bridge esté iniciado,
   tenga activado **Permitir altas remotas**, y que Ganamos, MultiPanel y el
   perfil principal de Chrome tengan sus sesiones abiertas. Permití `32146` en
   el firewall solo en redes privadas. No publiques ese puerto en Internet.
6. Entregá a Publi solo el `remoteCreateToken` de cada destino. No copies ni
   compartas `credentials.json` completo, `primaryToken` o `clientToken`.

## 2. Instalar la extensión y el host nativo en Publi

1. Instalá Chrome e iniciá sesión en el perfil de Chrome que se usará para
   Publi.
2. Copiá la carpeta de la extensión a una ubicación estable en esa PC.
3. Abrí `chrome://extensions`, activá **Modo desarrollador** y elegí **Cargar
   descomprimida**. Seleccioná la carpeta que contiene `manifest.json`.
4. Copiá el **ID** que Chrome muestra para la extensión. Usá este ID tanto para
   la autorización de la API como para instalar el host nativo. Si Chrome
   muestra un ID diferente al de otra PC, el administrador debe permitir ese
   ID en la API.
5. Abrí PowerShell en la carpeta de la extensión y ejecutá, reemplazando el
   marcador por el ID real:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native-host\install.ps1 -ExtensionId "ID_DE_32_CARACTERES"
   ```

   El script instala el host para el usuario actual de Windows. No lo ejecutes
   con otra cuenta de Windows distinta a la que usa Chrome.
6. Volvé a `chrome://extensions` y recargá la extensión. Si se actualizó la
   extensión, recargala antes de probar.

## 3. Confiar en el certificado HTTPS de la API

La CA raíz debe instalarse en el almacén de confianza de **la misma cuenta de
Windows que ejecuta Chrome**. Pedí el archivo `.cer` al administrador por un
medio seguro y verificá que sea la CA de BridgeWPP esperada. En esta LAN, el
thumbprint informado para la raíz es
`8EDF6190440F8670CF8D4746ADF0A822C4992DE6`.

En PowerShell, cambiá la ruta por la ubicación real del archivo recibido.
Primero verificá el thumbprint del archivo; **no instales** el certificado si
no coincide exactamente:

```powershell
$caPath = "$env:USERPROFILE\Downloads\bridgewpp-lan-root-ca.cer"
$ca = Get-PfxCertificate -FilePath $caPath
$ca | Format-List Subject, Thumbprint, NotAfter
if ($ca.Thumbprint -ne "8EDF6190440F8670CF8D4746ADF0A822C4992DE6") {
  throw "El certificado no coincide con la CA esperada."
}
Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\CurrentUser\Root
```

Verificá que quedó instalada la raíz correcta:

```powershell
Get-ChildItem Cert:\CurrentUser\Root |
  Where-Object Thumbprint -eq "8EDF6190440F8670CF8D4746ADF0A822C4992DE6" |
  Format-List Subject, Thumbprint, NotAfter
```

Comprobá la API desde PowerShell:

```powershell
curl.exe -i -H "Origin: chrome-extension://ID_DE_32_CARACTERES" "https://192.168.1.18:3443/health"
```

Esperá una respuesta HTTP `200` y un estado saludable. Si la IP de la API es
otra, reemplazala también en la URL.

- `SEC_E_UNTRUSTED_ROOT`: falta confiar en la CA correcta, se instaló en otra
  cuenta o el servidor no está presentando la cadena esperada.
- `CRYPT_E_NO_REVOCATION_CHECK` o error de revocación: como diagnóstico de
  `curl` únicamente, probá
  `curl.exe --ssl-no-revoke -i "https://192.168.1.18:3443/health"`. Esto **no**
  configura Chrome ni corrige el certificado. No desactives globalmente la
  comprobación de revocación de Windows. Si la extensión sigue sin conectar,
  el administrador debe corregir la configuración del certificado/servicio;
  no se debe dejar de validar TLS en Chrome.
- Error de conexión o timeout: revisá IP, que la API esté iniciada y el
  firewall de la PC principal.

Una respuesta correcta de `curl` es una comprobación de red/TLS; la prueba final
de CORS y permisos se hace desde la extensión.

## 4. Exportar el respaldo del perfil de origen

Si todavía no existe el archivo que se va a importar:

1. En el perfil Chrome que contiene los datos, abrí las opciones de la
   extensión.
2. En **Respaldo de este perfil Chrome**, elegí **Exportar perfil cifrado**.
3. Guardá el archivo y la frase de contraseña por separado y en un lugar seguro.

Cada archivo representa un perfil Chrome. La exportación incluye la
configuración y secretos funcionales de ese perfil; tratala como información
sensible. No uses el archivo de respaldo como sustituto de una copia segura de
los tokens del bridge o de las sesiones de los sitios.

## 5. Importar y enrolar el perfil de Publi

1. En las opciones de la extensión de Publi, abrí **Importar respaldo y
   conectar este perfil a PostgreSQL**.
2. Completá:
   - **Origen HTTPS**: `https://192.168.1.18:3443` (o la dirección estable
     indicada por el administrador).
   - **Archivo**: el respaldo cifrado.
   - **Frase de contraseña**: la usada al exportarlo.
   - **Nombre de esta PC/perfil**: un nombre identificable, por ejemplo
     `Publi - Caja 2`.
   - **Código temporal de enrolamiento**: pedilo al administrador justo antes
     de este paso; se usa una sola vez y vence a los 20 minutos.
3. Si Chrome pregunta por acceso a la API, permitilo. El administrador debe
   tener autorizado el ID exacto de la extensión en la API.
4. Elegí **Descifrar, validar y preparar vista previa**. Revisá el destino,
   perfil/workspace, cantidades y conflictos.
5. Si la vista previa es correcta, completá la decisión explícita sobre datos
   compartidos si aparece y elegí **Confirmar importación a PostgreSQL**. Si no
   vas a continuar, elegí **Descartar importación sin confirmar**.
6. Confirmá que la pantalla indique que la importación terminó. No repitas el
   commit por una pestaña que parece demorada sin revisar primero el estado.

Si aparece **Origen no autorizado**, compará el ID de `chrome://extensions`
con `DATA_ALLOWED_EXTENSION_IDS` en la PC principal y reiniciá la API después
de corregirlo. Si aparece **No se pudo conectar con la API HTTPS** o
**Failed to fetch**, revisá primero la confianza TLS, luego permisos de Chrome,
CORS/ID permitido, IP, puerto y firewall.

## 6. Configurar Publi para usar solo altas remotas

Después de importar, abrí las opciones y revisá explícitamente estos valores:

1. Dejá el modo como **Independiente**. No elijas **Secundario**: el modo
   Secundario usa el bridge local de la misma PC y no es un modo de acceso por
   LAN. No configures en Publi credenciales de emparejamiento local para este
   flujo.
2. Revisá el ID de agente y los sufijos si la extensión los requiere. Los
   sufijos Ganamos y MultiPanel deben ser letras distintas.
3. En **Destinos de creación remota de este perfil Chrome**, agregá cada PC
   operativa:
   - **Nombre visible**: por ejemplo, `PC Principal`.
   - **Dirección**: `http://<IP-privada-del-destino>:32146`.
   - **Código de creación remota**: el `remoteCreateToken` del destino.
   - **Sufijos**: los de Ganamos y MultiPanel configurados en esa PC destino.
4. Guardá y aceptá en Chrome el permiso de acceso a las direcciones privadas
   cuando lo solicite. La lista de destinos es privada de este perfil Chrome;
   configurala aquí aunque se haya importado un respaldo de otro perfil.
5. Recargá la pestaña de WhatsApp Web e iniciá sesión solo donde corresponda.
   Para la PC Publi, no inicies sesiones locales de Ganamos/MultiPanel si el
   objetivo es que opere exclusivamente mediante las altas remotas.

La contraseña usada para crear un usuario es la configurada en la PC destino,
no una contraseña enviada desde Publi. Mantené abiertas en esa PC las sesiones
de Ganamos/MultiPanel y WhatsApp que el bridge necesita.

## 7. Prueba de funcionamiento

1. En las opciones de Publi, verificá que se hayan guardado los destinos y
   volvé a abrir esa pantalla para comprobar que persisten.
2. En WhatsApp, verificá que aparezca el destino esperado al iniciar una
   creación. Hacé una prueba controlada acordada con el operador y confirmá el
   resultado en la PC destino.
3. Comprobá que la solicitud llegó al equipo/plataforma elegidos y que el alias
   usa el sufijo de ese destino.
4. No tomes una consulta local de saldo fallida en Publi como prueba de que la
   API PostgreSQL está caída: los saldos directos requieren una sesión de
   Ganamos/MultiPanel en esa PC. El objetivo de esta PC es enviar altas al
   bridge remoto.

## Errores que aparecieron y cómo resolverlos

| Mensaje o síntoma | Causa probable | Qué revisar |
|---|---|---|
| `SEC_E_UNTRUSTED_ROOT` en `curl` | Windows no confía en la CA que emitió el certificado de la API | Instalar el `.cer` correcto en `Cert:\CurrentUser\Root` para el mismo usuario de Chrome y verificar el thumbprint. |
| Error de revocación en `curl` | No se pudo comprobar la revocación del certificado | `--ssl-no-revoke` sirve solo como diagnóstico de `curl`; no desactives la validación global y no asumas que Chrome ya quedó configurado. |
| No se pudo conectar con la API HTTPS / `Failed to fetch` al importar o guardar | TLS, permisos del host, CORS/ID, IP o firewall | Probar `/health`; verificar CA y SAN, permiso de Chrome a la API, ID permitido, API activa y puerto `3443`. |
| `Origen no autorizado` | El ID `chrome-extension://...` no está permitido por la API | Autorizar el ID exacto de `chrome://extensions` en `DATA_ALLOWED_EXTENSION_IDS` y reiniciar la API. |
| No aparece contenido en **Response** de DevTools | El navegador pudo cortar la solicitud antes de que la API respondiera por TLS, permisos o CORS | Usar `/health` y revisar Console/Network; no compartir headers de autorización, bearer, firma ni tokens. |
| La importación se confirmó, pero WhatsApp muestra `Failed to fetch` al actualizar saldo | Se intentó consultar Ganamos/MultiPanel localmente en Publi, donde no hay sesión | Es esperable para consulta local. Verificá el bridge remoto y probá el flujo de altas remotas. |
| Guardar destinos sigue fallando aunque `/health` funciona | Puede faltar permiso de host de Chrome, o la solicitud real falla por CORS/autorización | Aceptar el permiso de dirección privada, comprobar el ID autorizado y revisar el error de la extensión sin copiar credenciales. |
| El destino no aparece o no crea el usuario | Bridge remoto apagado/deshabilitado, puerto bloqueado, token incorrecto o sesión ausente en el destino | Confirmar **Permitir altas remotas**, IP/`32146`, firewall privado, `remoteCreateToken`, sufijos y sesiones abiertas en la PC destino. |

Nunca publiques capturas o comandos `curl` que incluyan
`authorization`, `x-bridge-device-signature`, `x-bridge-device-id`,
`x-bridge-device-nonce` o códigos/tokens. Si una credencial quedó expuesta,
revocala desde la administración de la API y enrolá nuevamente ese perfil; no
reutilices los headers compartidos.

## Lista final antes de dar la PC por lista

- [ ] La API principal responde por HTTPS en una dirección privada estable.
- [ ] El certificado raíz correcto está instalado para el usuario de Chrome.
- [ ] El ID de la extensión está permitido por la API y el host nativo se
  instaló con ese mismo ID.
- [ ] El respaldo se importó y confirmó en el workspace esperado.
- [ ] Publi quedó en modo **Independiente**, no **Secundario**.
- [ ] Se configuraron los destinos, tokens remotos y sufijos correctos en Publi.
- [ ] Chrome concedió permiso a las direcciones privadas de los destinos.
- [ ] El bridge y las sesiones de plataforma están activos en cada PC destino.
- [ ] Se comprobó una creación remota controlada.
- [ ] No se expusieron ni se reutilizan credenciales compartidas en comandos o
  capturas.
