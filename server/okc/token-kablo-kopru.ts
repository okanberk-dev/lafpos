import { TOKEN_FIRMA } from '@shared/eski-adlar';
/**
 * Token kablolu bağlantının köprüsü: Windows PowerShell'de (32 bit; Token'ın IntegrationHub.dll'i içindeki yerel
 * kütüphane x86) çalışan küçük bir program. Token'ın C# kütüphanesini yükler, cihazla USB/RS232 üzerinden konuşur,
 * AsilPOS sunucusuyla standart giriş ve çıkıştan satır satır anlaşır. Ek program kurulmaz: Windows'ta hazır gelen
 * PowerShell, C# kaynağını açılışta kendisi derler (Add-Type). Kütüphanenin uçları ve geri çağrıları Token'ın belgesi
 * ("Token X Connect Wire › Geliştirici Dokümanı") ve örnek projesinden (hizlisepet-clienttemplate). Ayrıntı:
 * docs/04-YAZARKASA.md §9.
 *
 * Giriş (sunucudan, satır başına bir komut): `kimlik<TAB>komut<TAB>base64(UTF-8 gövde)`; komutlar `basket`
 * (sendBasket), `payment` (sendPayment), `fiscal` (getFiscalInfo), `index` (getActiveDeviceIndex: 0 X30TR, 1 300TR),
 * `reconnect`, `quit`.
 * Çıkış (JSON satırları): `{"t":"ready"}`, `{"t":"device","connected":true,"id":"AV…"}` (cihaz takıldı ya da çıktı;
 * id cihazın mali no'su), `{"t":"serial","type":3,"value":"{…}"}` (cihazdan gelen paket: 3 satış sonucu, 9 sepet
 * işlenemedi, 1 ve 10 300TR'de parçalı ödeme), `{"t":"res","id":"…","ok":true,"value":"…"}` (komutun yanıtı),
 * `{"t":"fatal","message":"…"}` (kütüphane yüklenemedi).
 */
export const KOPRU_PS1 = String.raw`# AsilPOS - Token kablolu baglanti koprusu (AsilPOS sunucusu yazar; elle degistirmeyin)
param([Parameter(Mandatory = $true)][string]$Dll, [string]$Firma = '${TOKEN_FIRMA}')
$ErrorActionPreference = 'Stop'
# Kutuphane adiyla istendiginde diskteki DLL verilir (derlenen kopru onu adiyla arar)
$yukleyici = @'
using System;
using System.Reflection;

public static class AsilposKopruYukle {
  static Assembly asm;
  public static void Hazirla(string yol) {
    asm = Assembly.LoadFrom(yol);
    AppDomain.CurrentDomain.AssemblyResolve += delegate (object s, ResolveEventArgs e) {
      if (e.Name != null && e.Name.StartsWith("IntegrationHub,", StringComparison.OrdinalIgnoreCase)) return asm;
      return null;
    };
  }
}
'@
$kaynak = @'
using System;
using System.IO;
using System.Text;

public static class AsilposKopru {
  static readonly object kilit = new object();
  static TextWriter cikis;
  static IntegrationHub.POSCommunication.SerialInCallback seri;
  static IntegrationHub.POSCommunication.DeviceStateCallback durum;

  static string J(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) {
      switch (c) {
        case '"': b.Append("\\\""); break;
        case '\\': b.Append("\\\\"); break;
        case '\n': b.Append("\\n"); break;
        case '\r': b.Append("\\r"); break;
        case '\t': b.Append("\\t"); break;
        default:
          if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
          else b.Append(c);
          break;
      }
    }
    return b.Append('"').ToString();
  }

  static void Yaz(string satir) {
    lock (kilit) {
      cikis.WriteLine(satir);
      cikis.Flush();
    }
  }

  public static void Calistir(string firma) {
    cikis = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    StreamReader giris = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    IntegrationHub.POSCommunication com;
    try {
      com = IntegrationHub.POSCommunication.getInstance(firma);
    } catch (Exception e) {
      Yaz("{\"t\":\"fatal\",\"message\":" + J(e.GetType().Name + ": " + e.Message) + "}");
      return;
    }
    seri = delegate (int tip, string deger) {
      try { Yaz("{\"t\":\"serial\",\"type\":" + tip + ",\"value\":" + J(deger) + "}"); } catch { }
    };
    durum = delegate (bool bagli, string kimlik) {
      try { Yaz("{\"t\":\"device\",\"connected\":" + (bagli ? "true" : "false") + ",\"id\":" + J(kimlik) + "}"); } catch { }
    };
    com.setDeviceStateCallback(durum);
    com.setSerialInCallback(seri);
    Yaz("{\"t\":\"ready\"}");
    string satir;
    while ((satir = giris.ReadLine()) != null) {
      string[] p = satir.Split('\t');
      if (p.Length < 2) continue;
      string kimlik = p[0];
      string komut = p[1];
      string govde = p.Length > 2 && p[2].Length > 0 ? Encoding.UTF8.GetString(Convert.FromBase64String(p[2])) : null;
      try {
        string deger;
        switch (komut) {
          case "basket": deger = com.sendBasket(govde).ToString(); break;
          case "payment": deger = com.sendPayment(govde).ToString(); break;
          case "fiscal": deger = com.getFiscalInfo(); break;
          case "index": deger = com.getActiveDeviceIndex().ToString(); break;
          case "reconnect": com.reConnect(); deger = "1"; break;
          case "quit":
            try { com.deleteCommunication(); } catch { }
            Yaz("{\"t\":\"res\",\"id\":" + J(kimlik) + ",\"ok\":true,\"value\":\"1\"}");
            return;
          default: throw new Exception("Bilinmeyen komut: " + komut);
        }
        Yaz("{\"t\":\"res\",\"id\":" + J(kimlik) + ",\"ok\":true,\"value\":" + J(deger) + "}");
      } catch (Exception e) {
        Yaz("{\"t\":\"res\",\"id\":" + J(kimlik) + ",\"ok\":false,\"message\":" + J(e.Message) + "}");
      }
    }
    try { com.deleteCommunication(); } catch { }
  }
}
'@
try {
  Add-Type -TypeDefinition $yukleyici
  [AsilposKopruYukle]::Hazirla($Dll)
  Add-Type -TypeDefinition $kaynak -ReferencedAssemblies @($Dll)
  [AsilposKopru]::Calistir($Firma)
} catch {
  $m = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
  [Console]::Out.WriteLine('{"t":"fatal","message":"' + $m + '"}')
  exit 2
}
`;
