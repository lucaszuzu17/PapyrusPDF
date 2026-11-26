// Leitura em voz alta (TTS) 100% offline usando as vozes locais do Windows (Web Speech API).
import { localeTag, type UiLang } from "../../shared/i18n.ts";
import { engine } from "./api.ts";

export interface TtsState {
  active: boolean;
  paused: boolean;
  page: number;
  rate: number;
}

class OfflineTts {
  private active = false;
  private paused = false;
  private page = 0;
  private pageCount = 0;
  private rate = 1;
  private lang: UiLang = "pt";
  private runId = 0;
  private listeners = new Set<(s: TtsState) => void>();
  private onPageChange: ((p: number) => void) | null = null;

  subscribe(fn: (s: TtsState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): TtsState {
    return { active: this.active, paused: this.paused, page: this.page, rate: this.rate };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  private pickLocalVoice(): SpeechSynthesisVoice | null {
    if (typeof speechSynthesis === "undefined") return null;
    const voices = speechSynthesis.getVoices();
    const local = voices.filter((v) => v.localService);
    const pool = local.length ? local : voices;
    const tag = localeTag(this.lang).replace("-", "[-_]");
    const exact = new RegExp(`^${tag}`, "i");
    const prefix = new RegExp(`^${this.lang}\\b`, "i");
    return pool.find((v) => exact.test(v.lang))
      ?? pool.find((v) => prefix.test(v.lang))
      ?? pool[0]
      ?? null;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.6, Math.min(2, rate));
    this.emit();
    if (this.active && !this.paused) {
      const p = this.page, total = this.pageCount, cb = this.onPageChange, lang = this.lang;
      this.start(p, total, cb, lang);
    }
  }

  async start(startPage: number, pageCount: number, onPageChange: ((p: number) => void) | null, lang: UiLang = "pt"): Promise<boolean> {
    if (typeof speechSynthesis === "undefined") return false;
    this.stop();
    const id = ++this.runId;
    this.active = true;
    this.paused = false;
    this.page = startPage;
    this.pageCount = pageCount;
    this.lang = lang;
    this.onPageChange = onPageChange;
    this.emit();
    this.readPage(startPage, id);
    return true;
  }

  private async readPage(p: number, id: number): Promise<void> {
    if (id !== this.runId || !this.active) return;
    if (p >= this.pageCount) { this.stop(); return; }
    this.page = p;
    this.onPageChange?.(p);
    this.emit();

    let text = "";
    try {
      const blocks = await engine.pageText(p);
      text = blocks.map((b) => b.lines.map((l) => l.text.trim()).join(" ")).join(". ").replace(/\s+/g, " ").trim();
    } catch {
      this.stop();
      return;
    }
    if (id !== this.runId || !this.active) return;
    if (!text) {
      // Página sem texto: avança para a próxima automaticamente
      this.readPage(p + 1, id);
      return;
    }

    // Divide em blocos de ~600 caracteres para evitar travamento da SpeechSynthesis em páginas longas
    const chunks = splitSentences(text, 600);
    const voice = this.pickLocalVoice();

    const speakChunk = (idx: number) => {
      if (id !== this.runId || !this.active) return;
      if (idx >= chunks.length) {
        this.readPage(p + 1, id);
        return;
      }
      const utt = new SpeechSynthesisUtterance(chunks[idx]);
      utt.lang = voice?.lang || localeTag(this.lang);
      if (voice) utt.voice = voice;
      utt.rate = this.rate;
      utt.onend = () => speakChunk(idx + 1);
      utt.onerror = () => { if (id === this.runId) this.stop(); };
      speechSynthesis.speak(utt);
    };
    speakChunk(0);
  }

  togglePause(): void {
    if (!this.active || typeof speechSynthesis === "undefined") return;
    if (this.paused) {
      speechSynthesis.resume();
      this.paused = false;
    } else {
      speechSynthesis.pause();
      this.paused = true;
    }
    this.emit();
  }

  stop(): void {
    this.runId++;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.active = false;
    this.paused = false;
    this.emit();
  }
}

function splitSentences(text: string, maxLen: number): string[] {
  const parts = text.split(/(?<=[.!?;:])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (!p) continue;
    if (!cur) cur = p;
    else if (cur.length + 1 + p.length <= maxLen) cur += " " + p;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

export const tts = new OfflineTts();
