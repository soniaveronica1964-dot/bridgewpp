using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class BridgeWppDataHost
{
    private const string DataDirectoryName = "BridgeWppDataHost";
    private const string DataFileName = "profiles.bin";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BridgeWppDataHost-v1");

    private static string DataFilePath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            DataDirectoryName, DataFileName);
    }

    private static string CreateDeviceProofKey()
    {
        byte[] key = new byte[32];
        using (var random = RandomNumberGenerator.Create())
            random.GetBytes(key);
        return Convert.ToBase64String(key);
    }

    private static Dictionary<string, object> ReadProfiles()
    {
        var path = DataFilePath();
        if (!File.Exists(path)) return new Dictionary<string, object>();
        var encrypted = File.ReadAllBytes(path);
        var plaintext = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(plaintext))
            ?? new Dictionary<string, object>();
    }

    private static void WriteProfiles(Dictionary<string, object> profiles)
    {
        var path = DataFilePath();
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var plaintext = Encoding.UTF8.GetBytes(Json.Serialize(profiles));
        var encrypted = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
        var temporaryPath = path + ".tmp";
        File.WriteAllBytes(temporaryPath, encrypted);
        if (File.Exists(path))
            File.Replace(temporaryPath, path, null);
        else
            File.Move(temporaryPath, path);
    }

    private static Dictionary<string, object> ReadMessage()
    {
        var header = Console.OpenStandardInput();
        var lengthBytes = new byte[4];
        ReadFully(header, lengthBytes, 4);
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length < 2 || length > 1024 * 1024)
            throw new InvalidOperationException("El mensaje nativo supera el tamaño permitido.");
        var payload = new byte[length];
        ReadFully(header, payload, length);
        var message = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
        if (message == null)
            throw new InvalidOperationException("El mensaje nativo no es un objeto JSON.");
        return message;
    }

    private static void ReadFully(Stream stream, byte[] buffer, int length)
    {
        int offset = 0;
        while (offset < length)
        {
            int count = stream.Read(buffer, offset, length - offset);
            if (count == 0) throw new EndOfStreamException("El mensaje nativo quedó incompleto.");
            offset += count;
        }
    }

    private static string GetString(Dictionary<string, object> message, string key)
    {
        object value;
        return message.TryGetValue(key, out value) ? value as string : null;
    }

    private static bool IsPrivateAddress(string host)
    {
        IPAddress address;
        if (IPAddress.TryParse(host, out address))
        {
            byte[] bytes = address.GetAddressBytes();
            if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            {
                return bytes[0] == 10 || bytes[0] == 127 ||
                    bytes[0] == 169 && bytes[1] == 254 ||
                    bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31 ||
                    bytes[0] == 192 && bytes[1] == 168;
            }
            return IPAddress.IsLoopback(address) ||
                (bytes[0] & 0xfe) == 0xfc ||
                bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80;
        }
        string normalized = host.ToLowerInvariant();
        return normalized.EndsWith(".local") || normalized.EndsWith(".lan") ||
            normalized.EndsWith(".internal") || normalized == "localhost";
    }

    private static object Handle(Dictionary<string, object> message)
    {
        string profileSelector = GetString(message, "profileSelector");
        if (!Regex.IsMatch(profileSelector ?? "",
            @"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"))
            throw new InvalidOperationException("El identificador local del perfil Chrome no es válido.");
        string profileKey = Guid.Parse(profileSelector).ToString("D");
        var profiles = ReadProfiles();
        object profileValue;
        var profile = profiles.TryGetValue(profileKey, out profileValue)
            ? profileValue as Dictionary<string, object>
            : null;
        if (profile == null)
        {
            profile = new Dictionary<string, object>
            {
                { "installationId", Guid.NewGuid().ToString() },
                { "apiOrigin", "" },
                { "credential", "" },
                { "deviceId", "" },
                { "deviceProofKey", CreateDeviceProofKey() }
            };
            profiles[profileKey] = profile;
            WriteProfiles(profiles);
        }

        string command = GetString(message, "command");
        if (command == "get")
        {
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "installationId", profile["installationId"] },
                { "apiOrigin", profile["apiOrigin"] },
                { "credential", profile["credential"] },
                { "deviceId", profile["deviceId"] },
                { "deviceProofKey", profile["deviceProofKey"] }
            };
        }
        if (command == "sign")
        {
            string method = GetString(message, "method");
            string requestPath = GetString(message, "requestPath");
            if (!Regex.IsMatch(method ?? "", @"^(GET|POST|DELETE)$") ||
                String.IsNullOrEmpty(requestPath) || requestPath[0] != '/' ||
                requestPath.Contains("\r") || requestPath.Contains("\n"))
                throw new InvalidOperationException("La solicitud a firmar no tiene un formato válido.");
            string deviceId = GetString(profile, "deviceId");
            Guid parsedDeviceId;
            if (!Guid.TryParse(deviceId, out parsedDeviceId))
                throw new InvalidOperationException("Este perfil aún no está enrolado en el servidor de datos.");
            long timestamp = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            byte[] nonceBytes = new byte[32];
            using (var random = RandomNumberGenerator.Create())
                random.GetBytes(nonceBytes);
            string nonce = Convert.ToBase64String(nonceBytes)
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
            string signedData = method + "\n" + requestPath + "\n" +
                timestamp.ToString(CultureInfo.InvariantCulture) + "\n" + nonce;
            byte[] keyBytes = Convert.FromBase64String(GetString(profile, "deviceProofKey"));
            byte[] signature;
            using (var hmac = new HMACSHA256(keyBytes))
                signature = hmac.ComputeHash(Encoding.UTF8.GetBytes(signedData));
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "deviceId", deviceId },
                { "timestamp", timestamp },
                { "nonce", nonce },
                { "signature", Convert.ToBase64String(signature)
                    .TrimEnd('=').Replace('+', '-').Replace('/', '_') }
            };
        }
        if (command == "store")
        {
            string apiOrigin = GetString(message, "apiOrigin");
            string credential = GetString(message, "credential");
            string deviceId = GetString(message, "deviceId");
            Uri apiUri;
            Guid parsedId;
            if (String.IsNullOrWhiteSpace(apiOrigin) || !Uri.TryCreate(apiOrigin, UriKind.Absolute, out apiUri) ||
                apiUri.Scheme != Uri.UriSchemeHttps || apiUri.AbsolutePath != "/" ||
                apiUri.Query.Length != 0 || apiUri.Fragment.Length != 0 ||
                !IsPrivateAddress(apiUri.Host) ||
                !Regex.IsMatch(credential ?? "", @"^[A-Za-z0-9_-]{43}$") ||
                !Guid.TryParse(deviceId, out parsedId))
                throw new InvalidOperationException("La URL o credencial de la API no tiene un formato válido.");
            profile["apiOrigin"] = apiOrigin;
            profile["credential"] = credential;
            profile["deviceId"] = deviceId;
            WriteProfiles(profiles);
            return new Dictionary<string, object> { { "ok", true } };
        }
        if (command == "clear")
        {
            profile["credential"] = "";
            WriteProfiles(profiles);
            return new Dictionary<string, object> { { "ok", true } };
        }
        throw new InvalidOperationException("Comando del host nativo desconocido.");
    }

    private static void WriteMessage(object result)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(result));
        byte[] header = BitConverter.GetBytes(payload.Length);
        var output = Console.OpenStandardOutput();
        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    public static int Main()
    {
        try
        {
            WriteMessage(Handle(ReadMessage()));
            return 0;
        }
        catch (Exception error)
        {
            WriteMessage(new Dictionary<string, object>
            {
                { "ok", false },
                { "error", error.Message }
            });
            return 0;
        }
    }
}
