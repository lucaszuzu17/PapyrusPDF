// Assinatura digital criptográfica offline (ICP-Brasil A1 .pfx/.p12 — adbe.pkcs7.detached)
// e verificação offline de integridade e cadeia embutida no PDF.
import forge from "node-forge";
import * as mupdf from "mupdf";
import type { DigitalSignOptions, PfxCertInfo, Rect, SignatureVerifyInfo } from "./types.ts";

const SIG_PLACEHOLDER_BYTES = 16384; // 16 KB em DER (32768 chars hex) — comporta cadeias completas ICP-Brasil

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function binaryStringToBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function certCN(attrs: forge.pki.CertificateField[]): string {
  const cn = attrs.find((a) => a.shortName === "CN" || a.name === "commonName");
  const o = attrs.find((a) => a.shortName === "O" || a.name === "organizationName");
  return String(cn?.value ?? o?.value ?? "(sem nome)");
}

function parsePfxInternal(pfxBytes: Uint8Array, password: string): {
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
  key: forge.pki.PrivateKey;
  info: PfxCertInfo;
} {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.createBuffer(bytesToBinaryString(pfxBytes), "raw");
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/MAC|password|Invalid/i.test(msg)) throw new Error("Senha do certificado incorreta ou arquivo .pfx/.p12 inválido.");
    throw new Error(`Não foi possível abrir o certificado .pfx/.p12: ${msg}`);
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];

  const keyBag = keyBags.find((b) => b.key);
  if (!keyBag?.key) throw new Error("Nenhuma chave privada encontrada no certificado.");
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!certs.length) throw new Error("Nenhum certificado X.509 encontrado no arquivo.");

  // Seleciona o certificado que casa com a chave privada (por localKeyId ou módulo RSA)
  const keyLocalId = keyBag.attributes?.localKeyId?.[0];
  let signerCert = certs[0];
  if (keyLocalId) {
    const matched = certBags.find((b) => b.cert && b.attributes?.localKeyId?.[0] === keyLocalId)?.cert;
    if (matched) signerCert = matched;
  } else if ("n" in keyBag.key) {
    const kn = (keyBag.key as forge.pki.rsa.PrivateKey).n.toString(16);
    const matched = certs.find((c) => "n" in c.publicKey && (c.publicKey as forge.pki.rsa.PublicKey).n.toString(16) === kn);
    if (matched) signerCert = matched;
  }

  const now = new Date();
  const validFrom = signerCert.validity.notBefore.toISOString();
  const validTo = signerCert.validity.notAfter.toISOString();
  const info: PfxCertInfo = {
    commonName: certCN(signerCert.subject.attributes),
    issuer: certCN(signerCert.issuer.attributes),
    serial: signerCert.serialNumber,
    validFrom,
    validTo,
    expired: now > signerCert.validity.notAfter || now < signerCert.validity.notBefore,
  };
  return { cert: signerCert, chain: certs, key: keyBag.key, info };
}

/** Lê os metadados de um certificado A1 (.pfx / .p12) sem modificar nenhum PDF. */
export function inspectPfx(pfxBytes: Uint8Array, password: string): PfxCertInfo {
  return parsePfxInternal(pfxBytes, password).info;
}

function pdfDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`;
}

function winAnsiHexSimple(s: string): string {
  let hex = "";
  for (const ch of s) {
    const u = ch.codePointAt(0)!;
    const b = (u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff) ? u : 0x3f;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Assina um PDF com certificado A1 (.pfx/.p12) gerando assinatura padrão ISO 32000-1
 * (`adbe.pkcs7.detached`, SHA-256) com cadeia completa embutida e carimbo visual opcional.
 */
export function signPdfBytes(pdfBytes: Uint8Array, opts: DigitalSignOptions, password = ""): { bytes: Uint8Array; cert: PfxCertInfo } {
  const { cert, chain, key, info } = parsePfxInternal(opts.pfxBytes, opts.password);
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf").asPDF();
  if (!doc) throw new Error("PDF inválido para assinatura digital.");
  if (doc.needsPassword() && password) doc.authenticatePassword(password);

  try {
    const now = new Date();
    const sigName = `PapyrusSig_${now.getTime()}`;

    // Dicionário /Sig com marcador fixo para /ByteRange e /Contents
    const sigDict = doc.newDictionary();
    sigDict.put("Type", doc.newName("Sig"));
    sigDict.put("Filter", doc.newName("Adobe.PPKLite"));
    sigDict.put("SubFilter", doc.newName("adbe.pkcs7.detached"));
    sigDict.put("Name", doc.newString(info.commonName));
    sigDict.put("M", doc.newString(pdfDate(now)));
    if (opts.reason?.trim()) sigDict.put("Reason", doc.newString(opts.reason.trim()));
    if (opts.location?.trim()) sigDict.put("Location", doc.newString(opts.location.trim()));
    if (opts.contactInfo?.trim()) sigDict.put("ContactInfo", doc.newString(opts.contactInfo.trim()));

    const brArr = doc.newArray();
    brArr.push(0);
    brArr.push(111111111);
    brArr.push(222222222);
    brArr.push(333333333);
    sigDict.put("ByteRange", brArr);

    // Preenche com 0xAA para localizar e substituir com segurança
    const placeholder = new Uint8Array(SIG_PLACEHOLDER_BYTES);
    placeholder.fill(0xaa);
    sigDict.put("Contents", doc.newByteString(placeholder));
    const sigRef = doc.addObject(sigDict);

    // Campo Widget de assinatura (visível ou invisível)
    const pageIdx = opts.visible ? Math.max(0, Math.min(doc.countPages() - 1, opts.visible.page)) : 0;
    const pageObj = doc.findPage(pageIdx);
    const page = doc.loadPage(pageIdx) as mupdf.PDFPage;
    const inv = mupdf.Matrix.invert(page.getTransform());
    page.destroy();

    const widget = doc.newDictionary();
    widget.put("Type", doc.newName("Annot"));
    widget.put("Subtype", doc.newName("Widget"));
    widget.put("FT", doc.newName("Sig"));
    widget.put("T", doc.newString(sigName));
    widget.put("V", sigRef);
    widget.put("P", pageObj);
    widget.put("F", 132); // Print | Locked

    const rectArr = doc.newArray();
    if (opts.visible) {
      const [tx0, ty0, tx1, ty1] = mupdf.Rect.transform(opts.visible.rect, inv);
      const x0 = Math.min(tx0, tx1), y0 = Math.min(ty0, ty1);
      const x1 = Math.max(tx0, tx1), y1 = Math.max(ty0, ty1);
      const w = Math.max(120, x1 - x0), h = Math.max(40, y1 - y0);
      rectArr.push(x0); rectArr.push(y0); rectArr.push(x0 + w); rectArr.push(y0 + h);

      // Aparência visual da assinatura digital (selo vetorial nítido)
      const fReg = doc.newDictionary();
      fReg.put("Type", doc.newName("Font")); fReg.put("Subtype", doc.newName("Type1"));
      fReg.put("BaseFont", doc.newName("Helvetica")); fReg.put("Encoding", doc.newName("WinAnsiEncoding"));
      const fBold = doc.newDictionary();
      fBold.put("Type", doc.newName("Font")); fBold.put("Subtype", doc.newName("Type1"));
      fBold.put("BaseFont", doc.newName("Helvetica-Bold")); fBold.put("Encoding", doc.newName("WinAnsiEncoding"));
      const fd = doc.newDictionary();
      fd.put("F1", doc.addObject(fReg));
      fd.put("F2", doc.addObject(fBold));
      const res = doc.newDictionary();
      res.put("Font", fd);

      const dateStr = now.toLocaleString("pt-BR");
      const lines = [
        { txt: "ASSINADO DIGITALMENTE", bold: true, sz: 7.5, col: "0.08 0.32 0.16" },
        { txt: info.commonName.slice(0, 46), bold: true, sz: 9, col: "0.1 0.1 0.1" },
        { txt: `Data: ${dateStr}`, bold: false, sz: 7.5, col: "0.25 0.25 0.25" },
        ...(opts.reason?.trim() ? [{ txt: `Motivo: ${opts.reason.trim().slice(0, 44)}`, bold: false, sz: 7, col: "0.3 0.3 0.3" }] : []),
        ...(opts.location?.trim() ? [{ txt: `Local: ${opts.location.trim().slice(0, 44)}`, bold: false, sz: 7, col: "0.3 0.3 0.3" }] : []),
      ];
      let ops = `q 0.96 0.98 0.96 rg 0.12 0.45 0.22 RG 1 w 0.5 0.5 ${(w - 1).toFixed(2)} ${(h - 1).toFixed(2)} re B `;
      let ty = h - 11;
      for (const ln of lines) {
        if (ty < 4) break;
        ops += `BT ${ln.col} rg /${ln.bold ? "F2" : "F1"} ${ln.sz} Tf 1 0 0 1 6 ${ty.toFixed(2)} Tm <${winAnsiHexSimple(ln.txt)}> Tj ET `;
        ty -= ln.sz + 2.5;
      }
      ops += "Q";

      const apDict = doc.newDictionary();
      apDict.put("Type", doc.newName("XObject"));
      apDict.put("Subtype", doc.newName("Form"));
      const bbox = doc.newArray();
      bbox.push(0); bbox.push(0); bbox.push(w); bbox.push(h);
      apDict.put("BBox", bbox);
      apDict.put("Resources", res);
      const apRef = doc.addStream(ops, apDict);
      const ap = doc.newDictionary();
      ap.put("N", apRef);
      widget.put("AP", ap);
    } else {
      rectArr.push(0); rectArr.push(0); rectArr.push(0); rectArr.push(0);
    }
    widget.put("Rect", rectArr);
    const widgetRef = doc.addObject(widget);

    // Anexa o widget à página e ao /AcroForm
    let annots = pageObj.get("Annots");
    if (!annots.isArray()) { annots = doc.newArray(); pageObj.put("Annots", annots); }
    annots.push(widgetRef);

    const root = doc.getTrailer().get("Root").resolve();
    let acro = root.get("AcroForm");
    if (!acro.isDictionary()) { acro = doc.newDictionary(); root.put("AcroForm", acro); }
    let fields = acro.get("Fields");
    if (!fields.isArray()) { fields = doc.newArray(); acro.put("Fields", fields); }
    fields.push(widgetRef);
    acro.put("SigFlags", 3); // SignaturesExist | AppendOnly

    // Salva sem objstms para que /ByteRange e /Contents fiquem em texto claro no arquivo
    const buf = doc.saveToBuffer("compress");
    const raw = new Uint8Array(buf.asUint8Array());
    buf.destroy();

    // Localiza /Contents <AAAA...> (sem .toUpperCase(), pois 0xDF -> "SS" desloca índices de bytes!)
    const rawLatin = bytesToBinaryString(raw);
    const upperNeedle = `<${"AA".repeat(SIG_PLACEHOLDER_BYTES)}>`;
    const lowerNeedle = `<${"aa".repeat(SIG_PLACEHOLDER_BYTES)}>`;
    let contentsStart = rawLatin.indexOf(upperNeedle);
    if (contentsStart < 0) contentsStart = rawLatin.indexOf(lowerNeedle);
    if (contentsStart < 0) throw new Error("Falha interna ao preparar o espaço da assinatura digital.");
    const contentsEnd = contentsStart + upperNeedle.length;

    const brPattern = /\[0\s+111111111\s+222222222\s+333333333\]/;
    const brMatch = brPattern.exec(rawLatin);
    if (!brMatch) throw new Error("Falha interna ao localizar /ByteRange da assinatura.");

    const b0 = 0;
    const b1 = contentsStart;
    const b2 = contentsEnd;
    const b3 = raw.length - contentsEnd;
    const newBr = `[${b0} ${b1} ${b2} ${b3}]`;
    if (newBr.length > brMatch[0].length) throw new Error("Arquivo grande demais para o marcador /ByteRange.");
    const paddedBr = newBr.padEnd(brMatch[0].length, " ");

    // Grava o ByteRange exato no buffer
    for (let i = 0; i < paddedBr.length; i++) raw[brMatch.index + i] = paddedBr.charCodeAt(i);

    // Monta os bytes assinados (tudo fora de <Contents>)
    const part1 = raw.subarray(0, b1);
    const part2 = raw.subarray(b2, b2 + b3);
    const signedContent = new Uint8Array(part1.length + part2.length);
    signedContent.set(part1, 0);
    signedContent.set(part2, part1.length);

    // Cria PKCS#7 / CMS Detached Signature (SHA-256)
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(bytesToBinaryString(signedContent), "raw");
    for (const c of chain) p7.addCertificate(c);
    p7.addSigner({
      key: key as forge.pki.rsa.PrivateKey,
      certificate: cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: now as unknown as string },
      ],
    });
    p7.sign({ detached: true });

    const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
    const sigHex = forge.util.bytesToHex(derBytes);
    if (sigHex.length > SIG_PLACEHOLDER_BYTES * 2) {
      throw new Error(`A assinatura PKCS#7 (${sigHex.length / 2} bytes) excedeu o espaço reservado.`);
    }
    const paddedHex = sigHex.padEnd(SIG_PLACEHOLDER_BYTES * 2, "0");
    for (let i = 0; i < paddedHex.length; i++) raw[contentsStart + 1 + i] = paddedHex.charCodeAt(i);

    return { bytes: raw, cert: info };
  } finally {
    doc.destroy();
  }
}

/**
 * Verifica offline todas as assinaturas digitais PKCS#7/CMS presentes no PDF:
 * valida integridade do /ByteRange, digest SHA-256/SHA-1/SHA-384/SHA-512 e assinatura RSA do certificado embutido.
 */
export function verifyPdfSignatures(pdfBytes: Uint8Array, password = ""): SignatureVerifyInfo[] {
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf").asPDF();
  if (!doc) return [];
  if (doc.needsPassword() && password) doc.authenticatePassword(password);

  const out: SignatureVerifyInfo[] = [];
  const seenSigObj = new Set<number>();

  try {
    const inspectSig = (fieldName: string, sigObj: mupdf.PDFObject) => {
      const resolved = sigObj.isIndirect() ? sigObj.resolve() : sigObj;
      if (!resolved.isDictionary()) return;
      const num = sigObj.isIndirect() ? sigObj.asIndirect() : -1;
      if (num > 0 && seenSigObj.has(num)) return;
      if (num > 0) seenSigObj.add(num);

      const brObj = resolved.get("ByteRange");
      const ctObj = resolved.get("Contents");
      if (!brObj.isArray() || brObj.length < 4 || ctObj.isNull()) return;

      const b0 = brObj.get(0).asNumber();
      const b1 = brObj.get(1).asNumber();
      const b2 = brObj.get(2).asNumber();
      const b3 = brObj.get(3).asNumber();
      const subFilter = resolved.get("SubFilter").isName() ? resolved.get("SubFilter").asName() : "";
      const reason = resolved.get("Reason").isString() ? resolved.get("Reason").asString() : "";
      const location = resolved.get("Location").isString() ? resolved.get("Location").asString() : "";
      const mDate = resolved.get("M").isString() ? resolved.get("M").asString() : "";

      const coversWholeDocument = b0 === 0 && b2 + b3 === pdfBytes.length && b1 > 0 && b2 > b1;
      const rangeValid = b0 >= 0 && b1 >= 0 && b2 >= b0 + b1 && b3 >= 0 && b2 + b3 <= pdfBytes.length;

      let signerName = resolved.get("Name").isString() ? resolved.get("Name").asString() : "(desconhecido)";
      let issuer = "";
      let serial = "";
      let validFrom = "";
      let validTo = "";
      let signingTime = mDate;
      let integrityValid = false;
      let status: SignatureVerifyInfo["status"] = "invalid";
      let note = "";

      try {
        const rawDer = trimDerPadding(ctObj.asByteString());
        const bin = bytesToBinaryString(rawDer);
        const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bin, "raw"), false);
        const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
          rawCapture?: {
            digestAlgorithm?: string;
            authenticatedAttributes?: forge.asn1.Asn1[];
            signature?: string;
          };
          certificates?: forge.pki.Certificate[];
        };

        const certs = p7.certificates ?? [];
        const rawCap = p7.rawCapture;
        if (certs.length) {
          // Identifica certificado do signatário (leaf: não é emissor de outro na cadeia, ou o primeiro)
          const issuerSet = new Set(certs.map((c) => certCN(c.issuer.attributes)));
          const leaf = certs.find((c) => !issuerSet.has(certCN(c.subject.attributes))) ?? certs[0];
          signerName = certCN(leaf.subject.attributes);
          issuer = certCN(leaf.issuer.attributes);
          serial = leaf.serialNumber;
          validFrom = leaf.validity.notBefore.toISOString();
          validTo = leaf.validity.notAfter.toISOString();

          if (rangeValid && rawCap) {
            const part1 = pdfBytes.subarray(b0, b0 + b1);
            const part2 = pdfBytes.subarray(b2, b2 + b3);
            const signedBytes = new Uint8Array(part1.length + part2.length);
            signedBytes.set(part1, 0);
            signedBytes.set(part2, part1.length);

            // Detecta algoritmo de hash
            const oid = rawCap.digestAlgorithm ? forge.asn1.derToOid(rawCap.digestAlgorithm) : forge.pki.oids.sha256;
            const mdName = oid === forge.pki.oids.sha1 ? "sha1"
              : oid === forge.pki.oids.sha384 ? "sha384"
                : oid === forge.pki.oids.sha512 ? "sha512" : "sha256";
            const md = (forge.md as any)[mdName].create();
            md.update(bytesToBinaryString(signedBytes), "raw");
            const computedDigest = md.digest().getBytes();

            // Compara com messageDigest nos authenticatedAttributes (ou direto se não houver atributos)
            const authAttrs = rawCap.authenticatedAttributes;
            let digestOk = false;
            let sigOk = false;

            if (authAttrs && authAttrs.length) {
              for (const attr of authAttrs) {
                const attrOid = forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0].value as string);
                const vals = (attr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[];
                if (attrOid === forge.pki.oids.messageDigest && vals?.[0]) {
                  digestOk = (vals[0].value as string) === computedDigest;
                } else if (attrOid === forge.pki.oids.signingTime && vals?.[0]) {
                  signingTime = String(vals[0].value);
                }
              }
              // Verifica assinatura RSA sobre SET OF authenticatedAttributes
              if (digestOk && rawCap.signature && "verify" in leaf.publicKey) {
                const setAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrs);
                const attrDer = forge.asn1.toDer(setAsn1).getBytes();
                const md2 = (forge.md as any)[mdName].create();
                md2.update(attrDer, "raw");
                try {
                  sigOk = (leaf.publicKey as forge.pki.rsa.PublicKey).verify(md2.digest().getBytes(), rawCap.signature);
                } catch { sigOk = false; }
              }
            } else if (rawCap.signature && "verify" in leaf.publicKey) {
              digestOk = true;
              try {
                sigOk = (leaf.publicKey as forge.pki.rsa.PublicKey).verify(computedDigest, rawCap.signature);
              } catch { sigOk = false; }
            }

            integrityValid = digestOk && sigOk;
            if (!digestOk) {
              status = "tampered";
              note = "O documento foi alterado após a assinatura (hash não confere).";
            } else if (!sigOk) {
              status = "invalid";
              note = "Assinatura criptográfica inválida para o certificado embutido.";
            } else {
              status = "valid";
              note = coversWholeDocument
                ? "Integridade criptográfica válida (verificação offline — cadeia/revogação OCSP não consultadas)."
                : "Integridade válida no trecho assinado, mas há alterações posteriores fora do ByteRange.";
            }
          }
        }
      } catch (e) {
        status = "invalid";
        note = `Erro ao decodificar PKCS#7: ${e instanceof Error ? e.message : String(e)}`;
      }

      out.push({
        fieldName, signerName, issuer, serial, validFrom, validTo, signingTime,
        reason, location, subFilter, integrityValid, coversWholeDocument, status, note,
      });
    };

    const root = doc.getTrailer().get("Root").resolve();
    const acro = root.get("AcroForm");
    if (acro.isDictionary()) {
      const fields = acro.get("Fields");
      if (fields.isArray()) {
        fields.forEach((f) => {
          const fd = f.isIndirect() ? f.resolve() : f;
          if (!fd.isDictionary()) return;
          const ft = fd.get("FT").isName() ? fd.get("FT").asName() : "";
          const v = fd.get("V");
          if (ft === "Sig" && !v.isNull()) {
            const name = fd.get("T").isString() ? fd.get("T").asString() : "Assinatura";
            inspectSig(name, v);
          }
        });
      }
    }
    // Fallback: verifica widgets de assinatura nas páginas
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const annots = doc.findPage(i).get("Annots");
      if (!annots.isArray()) continue;
      annots.forEach((a) => {
        const ad = a.isIndirect() ? a.resolve() : a;
        if (!ad.isDictionary()) return;
        if (ad.get("FT").isName() && ad.get("FT").asName() === "Sig" && !ad.get("V").isNull()) {
          const name = ad.get("T").isString() ? ad.get("T").asString() : `Assinatura p.${i + 1}`;
          inspectSig(name, ad.get("V"));
        }
      });
    }
  } finally {
    doc.destroy();
  }
  return out;
}

/** Recorta o preenchimento de zeros após o objeto DER raiz (padrão em /Contents de assinaturas PDF). */
function trimDerPadding(raw: Uint8Array): Uint8Array {
  if (raw.length < 2 || raw[0] !== 0x30) return raw;
  const b1 = raw[1];
  if (b1 < 0x80) return raw.subarray(0, Math.min(raw.length, 2 + b1));
  const numLenBytes = b1 & 0x7f;
  if (numLenBytes === 0 || numLenBytes > 4 || 2 + numLenBytes > raw.length) return raw;
  let len = 0;
  for (let i = 0; i < numLenBytes; i++) len = (len << 8) | raw[2 + i];
  const total = 2 + numLenBytes + len;
  return total > 0 && total <= raw.length ? raw.subarray(0, total) : raw;
}

/** Gera um certificado A1 autoassinado de teste em formato PKCS#12 (.pfx) — útil para testes automatizados. */
export function generateTestPfx(commonName: string, password: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: commonName }, { name: "organizationName", value: "PapyrusPDF Teste" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return binaryStringToBytes(forge.asn1.toDer(p12Asn1).getBytes());
}
