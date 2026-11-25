# Changelog

Todas as mudanças relevantes do **PapyrusPDF** são registradas neste arquivo.

## [0.5.2] — 2026-11-25

### Adicionado
- **Área de edição de texto redimensionável (esticar para frente)**:
  - Nova alça lateral direita (`⬌`) e alça de canto inferior direito na caixa de edição de texto: arraste para esticar ou encolher a largura em tempo real, fazendo o texto fluir para frente sem quebrar linha nem sobrepor o conteúdo abaixo; duplo clique na borda direita expande até o espaço livre / margem da página.
  - **Expansão automática em campos de linha única**: ao digitar um texto maior num campo de uma linha (como Nome Empresarial), a área cresce automaticamente para a direita enquanto houver espaço livre antes do próximo campo ou da margem.
  - A largura esticada é salva no PDF (`maxWidth`), mantendo a remoção restrita apenas à área original do texto.

## [0.5.1] — 2026-11-25

### Corrigido
- **Edição, seleção, busca e exportação em PDFs com fontes vetoriais Type 3 sem `/ToUnicode`** (comuns em PDFs PDF/A gerados por iText, Ghostscript e portais governamentais como o Comprovante de CNPJ):
  - Recuperação automática e offline do mapeamento de caracteres (`código → Unicode`) e detecção de negrito via OCR sobre folha limpa, com votação por glifo e cache por assinatura (sem marcar o documento como modificado).
  - Reparo automático de `/FontBBox` invertido ou degenerado (como `[0 0 1 -1]`), alinhando as caixas de seleção e edição exatamente sobre o texto visual sem alterar a renderização.
  - Remoção de espaçadores `/.notdef` invisíveis que mesclavam campos distintos em blocos gigantes e sobrepostos.
- **Agrupamento e seleção de blocos de texto**: separa corretamente colunas paralelas sem sobreposição horizontal, quebras verticais grandes e mudanças de tamanho/negrito entre rótulo e valor; ao clicar em *Editar texto*, seleciona o menor bloco sob o cursor.

### Testes
- Novo teste de regressão em `test/text-editing.test.ts` cobrindo fonte Type 3 com `/FontBBox` invertido, espaçadores vazios, recuperação de texto, busca e edição (55 testes no total).

## [0.5.0] — 2026-11-24

### Adicionado
- **Barra de formatação flutuante** na edição de texto (tamanho, negrito, itálico, alinhamento, cor e aviso de transbordo) e ferramenta **Inserir texto** em qualquer ponto da página.
- **Localizar e substituir** texto no documento inteiro ou na página atual (com um único `Ctrl+Z`).
- **Inserir imagem** diretamente sobre páginas existentes.
- **Recortar margens** e **padronizar tamanho das páginas** (A4 / Carta).
- **Achatar PDF** (fixar anotações, assinaturas, carimbos e campos no conteúdo) e **limpar metadados** ocultos (Info e XMP).
- **Editor de marcadores (sumário)** interativo.
- **Exportar tabelas para CSV** (compatível com Excel pt-BR).
- **Comparar PDFs** lado a lado com resumo de texto e mapa visual de diferenças.
- **Régua de medição** com escala configurável e **processamento em lote** (comprimir, marca d'água, numeração, limpar metadados, achatar e OCR).
- **Modo leitura** (normal, sépia e noturno).

### Corrigido
- Edição de texto com fontes subconjunto Type0 (evita quadradinhos `.notdef`), fallback Unicode para símbolos fora de WinAnsi (evita `?`), normalização NFD/PUA/ligaduras, redação por linha e salvamento atômico seguro.

## [0.4.0] — 2026-11-20

### Adicionado
- **Abas**: um documento por aba, lembrando página, zoom e busca (`Ctrl+Tab`, `Ctrl+W`).
- **Edição de texto na fonte original** embutida no PDF, com reserva na fonte equivalente instalada no Windows.
- **Converter** para Word (`.docx`), texto (`.txt`) e imagens (PNG/JPEG).
- **OCR** em português, inglês e espanhol (ou combinados).
- **Duas páginas lado a lado** e **tela cheia** (`F11`).
- **Remover marca d'água** (Word, Acrobat, Foxit e PapyrusPDF).
- **Proteger**: medidor e gerador de senha forte, cópia marcada com o nome do destinatário e cópia com páginas em imagem.
- Corretor ortográfico do Electron desligado para operar 100% offline.

## [0.3.0] — 2026-11-15

### Adicionado
- Primeira versão pública do **PapyrusPDF** para Windows: leitura, impressão, anotações, carimbos, formulários, assinatura, organização de páginas, edição de texto, proteção por senha, compressão e OCR offline em português.
