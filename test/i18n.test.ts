// Testes de internacionalização (pt, en, es + detecção automática do idioma do sistema).
// node --test test/i18n.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DICTS, defaultOcrLang, formatBytes, formatDecimal, localeTag, resolveLang, translate,
  type I18nKey, type UiLang,
} from "../src/shared/i18n.ts";
import { passwordStrength } from "../src/renderer/src/password.ts";

test("resolveLang segue o idioma do sistema em modo auto e respeita seleção manual", () => {
  assert.equal(resolveLang("auto", "pt-BR"), "pt");
  assert.equal(resolveLang("auto", "pt-PT"), "pt");
  assert.equal(resolveLang("auto", "es-ES"), "es");
  assert.equal(resolveLang("auto", "es-MX"), "es");
  assert.equal(resolveLang("auto", "es-419"), "es");
  assert.equal(resolveLang("auto", "en-US"), "en");
  assert.equal(resolveLang("auto", "en-GB"), "en");
  assert.equal(resolveLang("auto", "fr-FR"), "en"); // fallback padrão → inglês
  assert.equal(resolveLang("auto", ""), "en");
  assert.equal(resolveLang(undefined, "es-AR"), "es");

  // override manual ignora idioma do sistema
  assert.equal(resolveLang("en", "pt-BR"), "en");
  assert.equal(resolveLang("es", "en-US"), "es");
  assert.equal(resolveLang("pt", "es-ES"), "pt");
});

test("localeTag, defaultOcrLang e formatação numérica respeitam o idioma", () => {
  assert.equal(localeTag("pt"), "pt-BR");
  assert.equal(localeTag("en"), "en-US");
  assert.equal(localeTag("es"), "es-ES");

  assert.equal(defaultOcrLang("pt"), "por");
  assert.equal(defaultOcrLang("en"), "eng");
  assert.equal(defaultOcrLang("es"), "spa");

  assert.equal(formatDecimal(1.5, 2, "pt"), "1,50");
  assert.equal(formatDecimal(1.5, 2, "es"), "1,50");
  assert.equal(formatDecimal(1.5, 2, "en"), "1.50");

  assert.equal(formatBytes(2 * 1048576, "en"), "2.0 MB");
  assert.equal(formatBytes(2 * 1048576, "pt"), "2,0 MB");
});

test("dicionários pt, en e es possuem exatamente as mesmas chaves, não vazias, e interpolação funciona", () => {
  const ptKeys = Object.keys(DICTS.pt).sort();
  for (const lang of ["pt", "en", "es"] as UiLang[]) {
    const keys = Object.keys(DICTS[lang]).sort();
    assert.deepEqual(keys, ptKeys, `chaves divergentes em ${lang}`);
    for (const k of ptKeys as I18nKey[]) {
      const val = DICTS[lang][k];
      assert.ok(typeof val === "string" && val.trim().length > 0, `chave vazia: ${lang}.${k}`);
    }
  }

  // interpolação substitui variáveis e preserva marcadores literais de PDF ({p}, {n}, etc.)
  assert.equal(translate("en", "app.scannedSome", { n: 3 }), "3 page(s) appear to be scanned.");
  assert.equal(translate("es", "app.scannedSome", { n: 3 }), "3 página(s) parecen escaneadas.");
  assert.equal(translate("pt", "app.scannedSome", { n: 3 }), "3 página(s) parecem escaneadas.");
  assert.match(translate("en", "feat.hfTokens"), /\{p\}.*\{total\}/);
});

test("passwordStrength traduz rótulos e dicas para pt, en e es", () => {
  assert.equal(passwordStrength("123456", "pt").label, "Muito fraca");
  assert.equal(passwordStrength("123456", "en").label, "Very weak");
  assert.equal(passwordStrength("123456", "es").label, "Muy débil");
});
