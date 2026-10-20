// Works on private HTTP origins too: getRandomValues is available there,
// whereas randomUUID and SubtleCrypto require a secure context.
export function randomUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotr = (n: number, s: number) => (n >>> s) | (n << (32-s));
export async function fingerprint(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  if (crypto.subtle) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), b => b.toString(16).padStart(2,'0')).join('');
  }
  // SHA-256 fallback; keep the same storage keys when switching HTTP/HTTPS.
  const data = new Uint8Array(Math.ceil((input.length + 9)/64)*64);
  data.set(input); data[input.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(data.length-8, Math.floor(input.length / 0x20000000));
  view.setUint32(data.length-4, input.length * 8);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset=0; offset<data.length; offset+=64) {
    for (let i=0;i<16;i++) w[i]=view.getUint32(offset+i*4);
    for (let i=16;i<64;i++) {
      const x=w[i-15], y=w[i-2];
      w[i]=w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>>3))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>>10));
    }
    let [a,b,c,d,e,f,g,j]=h;
    for (let i=0;i<64;i++) {
      const t1=(j+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
      const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,j].forEach((n,i)=>{h[i]+=n;});
  }
  return Array.from(h,n=>n.toString(16).padStart(8,'0')).join('');
}

// Persist each distinct outstanding payload independently. Never store its text.
// The receipt is removed only by the request which actually owns it.
export async function withDurableIntent<T>(namespace: string, payload: unknown, send: (id: string) => Promise<T>, legacyId?: () => string | null): Promise<T> {
  const key = `${namespace}:${await fingerprint(JSON.stringify(payload))}`;
  const acquire = () => {
    const previous = localStorage.getItem(key) || legacyId?.();
    if (previous && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(previous)) throw new Error('The saved request identifier is invalid. Review the existing task before retrying.');
    const id = previous || randomUUID();
    localStorage.setItem(key,id);
    if (localStorage.getItem(key)!==id) throw new Error('Could not save the request identifier. No request was sent.');
    return id;
  };
  const id = navigator.locks ? await navigator.locks.request(key,acquire) : acquire();
  const result = await send(id);
  try { if (localStorage.getItem(key)===id) localStorage.removeItem(key); } catch { /* The acknowledged receipt remains safe to retry. */ }
  return result;
}
