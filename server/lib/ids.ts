import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

let lastTime = 0;
let lastRandom: number[] = [];

/**
 * Zamana göre sıralanabilen 26 karakterlik kimlik (ULID). Senkronda yerel kayıtlar buluttaki kayıtlarla
 * çakışmasın diye bütün işlem kayıtları (adisyon, kalem, ödeme…) bununla kimliklenir.
 */
export function ulid(now = Date.now()): string {
  let time = now;
  let random: number[];
  if (time === lastTime) {
    random = lastRandom.slice();
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i] < 31) {
        random[i]++;
        break;
      }
      random[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    random = Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
  }
  lastTime = time;
  lastRandom = random;

  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + random.map((n) => ALPHABET[n]).join('');
}
