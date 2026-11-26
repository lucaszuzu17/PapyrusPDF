# Changelog

All notable changes to **PapyrusPDF** are documented in this file.

## [0.6.0] — 2026-11-25

### Added
- **Offline Neural OCR Engine (PaddleOCR PP-OCRv4/v5 ONNX + Advanced Cleanup)**:
  - Bundled `onnxruntime-node` with Apache-2.0 PP-OCRv4 DBNet++ text detection, PP-OCRv5 Latin SVTR text recognition (Portuguese, English, Spanish, and 29 other Latin languages simultaneously), and PP-LCNet document orientation classification (**19.4 MB total**, 100% offline).
  - **Automatic 0° / 90° / 180° / 270° page orientation**: detects sideways and upside-down scans, rotates the PDF page upright atomically inside the same `Ctrl+Z` undo step, and aligns word-level invisible text boxes using CTC time-step positions.
  - **Local uneven-shadow removal**: block-max background estimation + 2D integral-image smoothing + background division flattens heavy camera-photo shadow gradients before recognition, paired with adaptive contrast normalization and fine `±6°` projection-profile deskew.
  - Added OCR engine selector in the Ribbon (**Neural PP-OCRv5** default, **Tesseract High Accuracy**, and **Tesseract Fast**), with automatic fallback to Tesseract if ONNX models are unavailable.
- **Multi-Language Interface (English, Spanish & Portuguese + System Auto-Detection)**:
  - Automatically follows the Windows OS language (`pt*` → Portuguese, `es*` → Spanish, all others → English), with a live language switcher in the Ribbon tab bar (`System`, `Português`, `English`, `Español`).
  - Localized all UI tabs, dialogs, notifications, stamps, password strength hints, native Electron Open/Save/Quit dialogs, default OCR language, TTS voice selection, and multi-language NSIS installer (`en_US`, `pt_BR`, `es_ES`).
- **Offline Cryptographic Digital Signatures (`.pfx` / `.p12`, ICP-Brasil A1)**:
  - Sign PDFs offline with standard `adbe.pkcs7.detached` (SHA-256) PKCS#7/CMS signatures via `node-forge`, with optional reason, location, and visible seal stamp.
  - Offline signature verification (`Fill & Sign → Verify`) checking document integrity/tampering, signer CN, issuer, and certificate validity dates.
- **Interactive Form Builder & Auto-Field Detection**:
  - Create interactive AcroForm fields directly on any page (single-line text, multiline text, checkbox, dropdown combobox, and signature fields) or delete existing fields.
  - **Detect Fields** automatically turns underlined blanks (`____`), `[ ]` checkboxes, and colon-delimited labels into interactive form fields.
- **Smart Pattern Redaction (PII / LGPD)**:
  - Offline auto-detection with checksum validation for CPF, CNPJ, credit cards (Luhn), emails, phone numbers, ZIP/CEP, RG, and custom terms/regex, with optional overlay text (e.g., `LGPD`, `REDACTED`, or `{tipo}`) rendered on black redaction bars.
- **Space Audit & Advanced PDF Optimizer**:
  - Inspect exact byte breakdown by category (Images, Fonts, Content Streams, Attachments, Metadata) before optimizing.
  - Supports font subsetting, object deduplication, and selective stripping of embedded thumbnails, hidden metadata (Info/XMP), attachments, and JavaScript/auto actions.
- **Multi-Step Batch Action Wizard**:
  - Chain multiple operations in sequence across batches of PDFs (OCR, A4 standardization, PII redaction, metadata sanitization, flatten, watermark, page numbering, continuous Bates numbering, and compression) with built-in workflow presets.
- **Bates Numbering & PDF Page Labels (`/PageLabels`)**:
  - Apply sequential Bates codes (prefix, zero-padded digits, suffix, position, skip cover) across single or batch documents.
  - Configure custom `/PageLabels` schemes (e.g., lowercase Roman numerals `i, ii, iii` for front matter and Arabic `1, 2, 3` for the main body).
- **Comments Summary Export & Sidebar Filtering**:
  - Filter annotations by text or type in the Comments panel, see quoted text under highlights, and export a structured summary report to **PDF (A4)**, **Markdown (`.md`)**, or **CSV (`.csv`)**.
- **Embedded Attachments & PDF Layers (OCG)**:
  - New **Attachments** sidebar panel to list, attach, extract, and remove embedded files.
  - New **Layers** sidebar panel to toggle Optional Content Groups (OCG) live.
- **Clickable Links, Link Editor & Auto-Bookmarks**:
  - Click internal page links and external URLs directly in the viewer, draw/remove links with **Add Link**, and auto-generate a bookmark hierarchy from detected headings (**Bookmarks → Auto**).
- **Offline HTML & Markdown → PDF Converter**:
  - Convert local `.html` and `.md` files to PDF using Electron's embedded Chromium engine with all external network requests (`http`/`https`/`ws`) strictly blocked.
- **Vector SVG Printing**:
  - Prints pages as crisp vector SVG (with automatic landscape rotation and PNG fallback for massive raster scans).
- **Offline Read Aloud (TTS)**:
  - Reads document text aloud page-by-page using local Windows voices (Web Speech API) with speed control and pause/resume.
- **Undo Across Saves & Crash Auto-Recovery**:
  - `Ctrl+Z` / `Ctrl+Y` now survive `Save` via bounded in-memory snapshots.
  - Periodic 45-second offline auto-save drafts prompt to restore unsaved documents after an unexpected shutdown.

### Tests
- Expanded unit test suite from 55 to **74 tests** covering Tier 1, Tier 2, i18n (`pt`/`en`/`es`), and Neural PP-OCRv5 + Option B OCR (`test/tier1.test.ts`, `test/tier2.test.ts`, `test/i18n.test.ts`, `test/ocr-neural.test.ts`).

---

## [0.5.2] — 2026-11-25

### Added
- **Resizable text editing box (expand horizontally)**:
  - Added right-edge (`⬌`) and bottom-right resize handles to the text edit box to reflow text without wrapping over content below; double-clicking the right edge expands to available free space or page margin.
  - **Auto-expansion for single-line fields**: typing longer text in a single-line field automatically expands the width rightward until the next field or margin.
  - Persists expanded `maxWidth` in the PDF while keeping erasure strictly limited to the original text area.

---

## [0.5.1] — 2026-11-25

### Fixed
- **Text editing, selection, search, and export for Type 3 vector fonts without `/ToUnicode`** (common in PDF/A files generated by iText, Ghostscript, and government portals):
  - Offline automatic recovery of character mapping (`code → Unicode`) and bold detection via clean-sheet glyph OCR with voting and signature caching.
  - Automatic repair of inverted or degenerate `/FontBBox` entries (such as `[0 0 1 -1]`), aligning selection and editing boxes directly over visual text.
  - Stripped invisible `/.notdef` spacers that merged separate columns into overlapping blocks.
- **Text block grouping & selection**: cleanly separates side-by-side columns, large vertical gaps, and font-size/bold transitions; clicking *Edit Text* selects the smallest block under the cursor.

### Tests
- Added regression test in `test/text-editing.test.ts` covering Type 3 fonts with inverted `/FontBBox`, empty spacers, text recovery, search, and editing (55 tests total).

---

## [0.5.0] — 2026-11-24

### Added
- **Floating formatting toolbar** for text editing (size, bold, italic, alignment, color, and overflow warning) and **Add Text** tool anywhere on a page.
- **Find & Replace** across the entire document or current page (single `Ctrl+Z` undo).
- **Add Image** directly onto existing pages.
- **Crop margins** and **Standardize page sizes** (A4 / Letter).
- **Flatten PDF** (burn annotations, signatures, stamps, and form fields into page content) and **Sanitize metadata** (strip hidden Info and XMP data).
- Interactive **Bookmarks (Outline) editor**.
- **Export tables to CSV** (Excel-ready).
- **Compare PDFs** side-by-side with line-level text diff and visual diff map.
- **Measurement ruler** with configurable architectural/engineering scale and **Batch processing** (compress, watermark, page numbers, sanitize, flatten, and OCR).
- **Reading mode** (Normal, Sepia, and Night).

### Fixed
- Text editing with Type0 subset fonts (avoids `.notdef` boxes), Unicode fallback for characters outside WinAnsi (avoids `?`), NFD/PUA/ligature normalization, line-accurate redaction, and atomic file writes.

---

## [0.4.0] — 2026-11-20

### Added
- **Tabbed interface**: one document per tab, remembering page, zoom, and search (`Ctrl+Tab`, `Ctrl+W`).
- **Original-font text editing** reusing the PDF's embedded font, with Windows system font fallback.
- **Convert** PDF to Word (`.docx`), plain text (`.txt`), and images (PNG/JPEG).
- **OCR** in Portuguese, English, and Spanish (or combined).
- **Two-page spread view** and **Full Screen** (`F11`).
- **Remove Watermark** (Word, Acrobat, Foxit, and PapyrusPDF watermarks).
- **Protect**: password strength meter, strong password generator, recipient-watermarked copies, and rasterized image-only copies.
- Disabled Electron's online spellchecker dictionary download to guarantee 100% offline operation.

---

## [0.3.0] — 2026-11-15

### Added
- First public Windows release of **PapyrusPDF**: reading, printing, annotations, stamps, forms, visual signing, page organization, text editing, password protection, compression, and offline OCR.
