/**
 * İsteğin (ödeme, tahsilat denemesinin) istemcide üretilen kimliği: yanıtı kaybolan istek yeniden gelirse sunucu
 * ikinci kez yazmaz, ilk sonucu döner. Kafe ağında sayfa http ile açılır; randomUUID yalnız güvenli bağlamda var
 */
export const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
