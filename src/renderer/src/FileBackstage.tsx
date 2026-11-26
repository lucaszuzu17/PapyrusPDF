// Menu Backstage "Arquivo" estilo Foxit — 100% offline, nas cores do ícone PapyrusPDF (#1E242B, #F6ECDC, #D4A24C, #C93B2B).
import { useEffect, useState } from "react";
import { formatDecimal, localeTag, type LangPref } from "../../shared/i18n.ts";
import { PT_TO_MM } from "../../shared/print-types.ts";
import { PapyrusLogo, PdfFileBadge } from "./BrandMark.tsx";
import * as feat from "./features.ts";
import { Icon } from "./icons.tsx";
import { useApp, type ThemePref } from "./state.tsx";

type Section = "open" | "create" | "properties" | "export" | "appearance";
type RecentItem = Awaited<ReturnType<typeof window.papiro.recentList>>[number];

export function FileBackstage() {
  const app = useApp();
  const [section, setSection] = useState<Section>("open");
  const [recent, setRecent] = useState<RecentItem[]>([]);

  useEffect(() => {
    if (!app.fileMenuOpen) return;
    window.papiro.recentList().then(setRecent).catch(() => {});
  }, [app.fileMenuOpen]);

  useEffect(() => {
    if (!app.fileMenuOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") app.setFileMenuOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [app]);

  if (!app.fileMenuOpen) return null;

  const close = () => app.setFileMenuOpen(false);
  const runAndClose = (fn: () => unknown) => { close(); fn(); };
  const doc = app.doc;
  const p0 = doc?.info.pages[0];
  const cm = (pt: number) => formatDecimal((pt * PT_TO_MM) / 10, 1, app.lang);
  const sysLangLabel = app.systemLang.toUpperCase();

  return (
    <div className="backstage" role="dialog" aria-modal="true" aria-label={app.t("tab.file")}>
      {/* Rail lateral estilo Foxit */}
      <aside className="bs-rail">
        <div className="bs-head">
          <button type="button" className="bs-back" onClick={close} title={app.t("file.back")}>
            <Icon name="back" size={18} />
          </button>
          <PapyrusLogo size={24} />
          <span>PapyrusPDF</span>
        </div>

        <nav className="bs-nav">
          <button type="button" className={section === "open" ? "bs-item on" : "bs-item"} onClick={() => setSection("open")}>
            <Icon name="open" size={16} /> {app.t("file.open")}
          </button>
          <button type="button" className={section === "create" ? "bs-item on" : "bs-item"} onClick={() => setSection("create")}>
            <Icon name="plus" size={16} /> {app.t("file.create")}
          </button>
          <button type="button" className={section === "properties" ? "bs-item on" : "bs-item"} disabled={!doc} onClick={() => setSection("properties")}>
            <Icon name="info" size={16} /> {app.t("file.properties")}
          </button>

          <div className="bs-sep" />

          <button type="button" className="bs-item" disabled={!doc} onClick={() => runAndClose(() => app.save(false))}>
            <Icon name="save" size={16} /> {app.t("file.save")}
          </button>
          <button type="button" className="bs-item" disabled={!doc} onClick={() => runAndClose(() => app.save(true))}>
            <Icon name="saveAs" size={16} /> {app.t("file.saveAs")}
          </button>
          <button type="button" className="bs-item" disabled={!doc} onClick={() => runAndClose(() => app.printDoc())}>
            <Icon name="print" size={16} /> {app.t("file.print")}
          </button>

          <div className="bs-sep" />

          <button type="button" className={section === "export" ? "bs-item on" : "bs-item"} disabled={!doc} onClick={() => setSection("export")}>
            <Icon name="extract" size={16} /> {app.t("file.export")}
          </button>
          <button type="button" className="bs-item" disabled={!doc} onClick={() => runAndClose(() => feat.compress(app))}>
            <Icon name="compress" size={16} /> {app.t("file.optimizer")}
          </button>
          <button type="button" className="bs-item" onClick={() => runAndClose(() => feat.batchProcess(app))}>
            <Icon name="batch" size={16} /> {app.t("file.actionWizard")}
          </button>
          <button type="button" className="bs-item" disabled={!doc} onClick={() => runAndClose(() => { if (doc) app.closeTab(doc.id); })}>
            <Icon name="close" size={16} /> {app.t("file.close")}
          </button>

          <div className="bs-sep" />

          <button type="button" className={section === "appearance" ? "bs-item on" : "bs-item"} onClick={() => setSection("appearance")}>
            <Icon name="sun" size={16} /> {app.t("file.appearance")}
          </button>
        </nav>
      </aside>

      {/* Conteúdo à direita */}
      <div className="bs-content">
        {section === "open" && (
          <div className="bs-open-grid">
            <div className="bs-subnav">
              <h2>{app.t("file.open")}</h2>
              <div className="bs-subitem on"><Icon name="clock" size={16} /> {app.t("file.recentDocs")}</div>
              <button type="button" className="bs-subitem" onClick={() => runAndClose(() => app.openFile())}>
                <Icon name="folder" size={16} /> {app.t("file.computer")}
              </button>
              <button type="button" className="primary bs-browse-btn" onClick={() => runAndClose(() => app.openFile())}>
                {app.t("file.browseComputer")}
              </button>
            </div>
            <div className="bs-recents">
              <h3>{app.t("file.recentDocs")}</h3>
              <span className="bs-sublabel">{app.t("file.local")}</span>
              {recent.length === 0 ? (
                <p className="empty">{app.t("file.noRecent")}</p>
              ) : (
                <ul className="bs-rlist">
                  {recent.map((r) => (
                    <li key={r.path}>
                      <button type="button" className="bs-ritem" onClick={() => runAndClose(() => app.openFile(r.path))}>
                        <PdfFileBadge size={26} />
                        <div className="bs-rmeta">
                          <b>{r.name}</b>
                          <small>{r.path}</small>
                        </div>
                        <span className="bs-rdate">{new Date(r.when).toLocaleDateString(localeTag(app.lang))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {section === "create" && (
          <div className="bs-pane">
            <h2>{app.t("file.createTitle")}</h2>
            <div className="bs-cards">
              <button type="button" className="bs-card" onClick={() => runAndClose(() => app.newFromImages())}>
                <span className="bs-cicon gold"><Icon name="image" size={24} /></span>
                <div>
                  <b>{app.t("file.createFromImg")}</b>
                  <p>{app.t("file.createFromImgDesc")}</p>
                </div>
              </button>
              <button type="button" className="bs-card" onClick={() => runAndClose(() => app.mergeFiles())}>
                <span className="bs-cicon red"><Icon name="merge" size={24} /></span>
                <div>
                  <b>{app.t("file.createMerge")}</b>
                  <p>{app.t("file.createMergeDesc")}</p>
                </div>
              </button>
              <button type="button" className="bs-card" onClick={() => runAndClose(() => feat.fromHtmlOrMarkdown(app))}>
                <span className="bs-cicon ink"><Icon name="htmlPdf" size={24} /></span>
                <div>
                  <b>{app.t("file.createFromHtml")}</b>
                  <p>{app.t("file.createFromHtmlDesc")}</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {section === "export" && doc && (
          <div className="bs-pane">
            <h2>{app.t("file.exportTitle")}</h2>
            <div className="bs-cards">
              <button type="button" className="bs-card" onClick={() => runAndClose(() => feat.toWord(app))}>
                <span className="bs-cicon ink"><Icon name="toWord" size={24} /></span>
                <div>
                  <b>{app.t("cmd.toWord")} (.docx)</b>
                  <p>{app.t("file.exportWordDesc")}</p>
                </div>
              </button>
              <button type="button" className="bs-card" onClick={() => runAndClose(() => feat.toCsv(app))}>
                <span className="bs-cicon gold"><Icon name="csv" size={24} /></span>
                <div>
                  <b>{app.t("cmd.toCsv")} (.csv)</b>
                  <p>{app.t("file.exportCsvDesc")}</p>
                </div>
              </button>
              <button type="button" className="bs-card" onClick={() => runAndClose(() => feat.toText(app))}>
                <span className="bs-cicon ink"><Icon name="toText" size={24} /></span>
                <div>
                  <b>{app.t("cmd.toText")} (.txt)</b>
                  <p>{app.t("file.exportTextDesc")}</p>
                </div>
              </button>
              <button type="button" className="bs-card" onClick={() => runAndClose(() => feat.exportImages(app))}>
                <span className="bs-cicon red"><Icon name="imageOut" size={24} /></span>
                <div>
                  <b>{app.t("cmd.toImg")} (PNG/JPG)</b>
                  <p>{app.t("file.exportImgDesc")}</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {section === "properties" && doc && (
          <div className="bs-pane">
            <h2>{app.t("file.propsTitle")}</h2>
            <dl className="bs-props">
              <dt>{app.t("file.propsName")}</dt><dd>{doc.name}</dd>
              <dt>{app.t("file.propsPath")}</dt><dd>{doc.path ?? app.t("file.propsUnsaved")}</dd>
              <dt>{app.t("file.propsPages")}</dt><dd>{doc.info.pageCount}</dd>
              {p0 && <><dt>{app.t("file.propsPageSize")}</dt><dd>{cm(p0.width)} × {cm(p0.height)} cm</dd></>}
              <dt>{app.t("file.propsSecurity")}</dt>
              <dd>{doc.info.encrypted ? app.t("file.propsEncrypted") : app.t("file.propsUnencrypted")}</dd>
            </dl>
            <button type="button" className="primary" onClick={() => runAndClose(() => feat.compress(app))}>
              {app.t("file.propsAuditBtn")}
            </button>
          </div>
        )}

        {section === "appearance" && (
          <div className="bs-pane">
            <h2>{app.t("file.appearanceTitle")}</h2>
            <p className="bs-lead">{app.t("file.appearanceSub")}</p>
            <div className="bs-themes">
              {(
                [
                  ["auto", "theme.auto", "theme.autoDesc"],
                  ["light", "theme.light", "theme.lightDesc"],
                  ["dark", "theme.dark", "theme.darkDesc"],
                ] as [ThemePref, Parameters<typeof app.t>[0], Parameters<typeof app.t>[0]][]
              ).map(([val, titleKey, descKey]) => (
                <button
                  key={val}
                  type="button"
                  className={app.theme === val ? "bs-theme-card on" : "bs-theme-card"}
                  onClick={() => app.setTheme(val)}
                >
                  <span className={`bs-swatch-preview ${val}`}>
                    <i className="sw-bar" />
                    <i className="sw-red" />
                    <i className="sw-gold" />
                  </span>
                  <b>{app.t(titleKey)}</b>
                  <small>{app.t(descKey)}</small>
                </button>
              ))}
            </div>
            <div className="bs-lang-row">
              <label htmlFor="bs-lang">{app.t("file.languageLabel")}</label>
              <select id="bs-lang" value={app.uiLangPref} onChange={(e) => app.setUiLang(e.target.value as LangPref)}>
                <option value="auto">{app.t("lang.auto", { lang: sysLangLabel })}</option>
                <option value="pt">{app.t("lang.pt")}</option>
                <option value="en">{app.t("lang.en")}</option>
                <option value="es">{app.t("lang.es")}</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
