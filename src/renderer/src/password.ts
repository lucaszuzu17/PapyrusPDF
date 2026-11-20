// Força de senha e gerador de senhas fortes (sem dependências: testável no Node).

export interface Strength { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string; bits: number }

const COMMON = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890", "password", "senha", "senha123", "senha1234",
  "qwerty", "abc123", "111111", "000000", "123123", "admin", "brasil", "teste", "iloveyou", "mudar123",
  "flamengo", "corinthians", "palmeiras", "123mudar", "abcdef", "654321", "102030", "112233",
]);
const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm", "01234567890"];

/** Estimativa simples da força: tamanho × variedade de caracteres, com descontos para padrões fáceis. */
export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", hint: "", bits: 0 };
  const lower = pw.toLowerCase();
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = [...pw].length * Math.log2(Math.max(pool, 2));
  // poucos caracteres diferentes ("aaaaaa1111")
  const unique = new Set(lower).size;
  if (unique < pw.length * 0.5) bits *= Math.max(0.35, unique / (pw.length * 0.5));
  // trechos em sequência ("abcd", "1234", "qwer")
  let seq = 0;
  for (let i = 0; i + 3 <= lower.length; i++) {
    const tri = lower.slice(i, i + 3);
    if (SEQUENCES.some((s) => s.includes(tri) || [...s].reverse().join("").includes(tri))) seq++;
  }
  bits -= seq * 4;
  // datas (nascimento, casamento…) e senhas muito usadas
  if (/^\d{1,2}[\/.-]?\d{1,2}[\/.-]?(\d{2}|\d{4})$/.test(pw)) bits = Math.min(bits, 18);
  if (COMMON.has(lower) || COMMON.has(lower.replace(/\d+$/, ""))) bits = Math.min(bits, 8);
  bits = Math.max(0, Math.round(bits));
  if (bits < 28) return { score: 0, label: "Muito fraca", hint: "Programas de quebra de senha descobrem em segundos.", bits };
  if (bits < 40) return { score: 1, label: "Fraca", hint: "Cai em pouco tempo num ataque de força bruta. Use 14 ou mais caracteres misturados.", bits };
  if (bits < 60) return { score: 2, label: "Razoável", hint: "Aguenta tentativas casuais, mas não um ataque dedicado. Aumente o tamanho.", bits };
  if (bits < 80) return { score: 3, label: "Forte", hint: "Difícil de quebrar com o AES-256 do PDF.", bits };
  return { score: 4, label: "Muito forte", hint: "Impraticável de quebrar por força bruta.", bits };
}

// sem letras e números que se confundem (l/1, O/0) e sem vírgula ou "=" (que o PDF não aceita aqui)
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Senha aleatória em 4 grupos de 4 caracteres ("Xk7p-…"): cerca de 90 bits. */
export function generatePassword(groups = 4, size = 4): string {
  const n = groups * size;
  const out: string[] = [];
  const buf = new Uint32Array(n * 2);
  crypto.getRandomValues(buf);
  // descarta valores que dariam viés na divisão
  const limit = Math.floor(0x100000000 / ALPHABET.length) * ALPHABET.length;
  for (let i = 0; out.length < n; i++) {
    if (i >= buf.length) { crypto.getRandomValues(buf); i = 0; }
    if (buf[i] < limit) out.push(ALPHABET[buf[i] % ALPHABET.length]);
  }
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) parts.push(out.slice(g * size, (g + 1) * size).join(""));
  return parts.join("-");
}
