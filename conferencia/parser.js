/**
 * Extração do relatório "Solicitações de Pagamentos por Débito em Conta Corrente" (SCK).
 *
 * Roda no navegador, em cima do pdf.js. Nenhuma dependência de servidor:
 * o PDF nunca sai da máquina de quem está conferindo.
 *
 *   const dados = await parseRelatorio(arrayBuffer, pdfjsLib);
 */

// Duas famílias de layout convivem no mesmo PDF.
// A: TRANSFERÊNCIA / TED / PIX      (cabeçalho "S.N" em x >= 31)
// B: DÉBITO EM CONTA / BOLETO       (cabeçalho "S.N" em x <  31)
const COLUNAS = {
  A: [["sn",0,52],["filial",45,88],["valor",88,133],["solicitante",133,186],
      ["competente",186,240],["poder",240,270],["cpfCnpj",270,336],
      ["favorecido",336,458],["destinacao",458,615],["complemento",615,760],
      ["poderDispendio",760,9999]],
  B: [["sn",0,50],["filial",45,85],["valor",85,123],["solicitante",123,176],
      ["competente",176,235],["poder",235,262],["cpfCnpj",262,324],
      ["favorecido",324,430],["destinacao",430,620],["complemento",620,770],
      ["poderDispendio",770,9999]],
};
const TIPOS = ["TRANSFERÊNCIA BANCÁRIA CONTA CORRENTE","TED","DÉBITO EM CONTA","PIX","BOLETO"];
const TIPO_CURTO = {"TRANSFERÊNCIA BANCÁRIA CONTA CORRENTE":"TRANSFERÊNCIA"};
const RUIDO = ["Total ==>","Página","Filial:","SOLICITAÇÕES DE","DDP -"];
const RE_TOTAL = /Total ==>\s+(\d+)\s+Solicitação\(ões\)\s+R\$\s+([\d.,]+)/;

const coluna = (fam, x) => (COLUNAS[fam].find(([, i, f]) => x >= i && x < f) || ["poderDispendio"])[0];
const num = (t) => { const v = parseFloat(String(t).replace(/\./g, "").replace(",", ".")); return isNaN(v) ? null : v; };

/** Palavras da página, com x e y no mesmo referencial do relatório (y cresce para baixo). */
async function palavrasDaPagina(pagina) {
  const conteudo = await pagina.getTextContent();
  const altura = pagina.view[3];
  const saida = [];
  for (const item of conteudo.items) {
    const texto = item.str;
    if (!texto || !texto.trim()) continue;
    const x = item.transform[4];
    const y = altura - item.transform[5];
    // um item pode trazer várias palavras; distribui pela largura para não
    // jogar tudo na coluna da primeira palavra
    const pedacos = texto.trim().split(/\s+/);
    const larguraChar = item.width / Math.max(texto.length, 1);
    let deslocamento = 0;
    for (const p of pedacos) {
      const inicio = texto.indexOf(p, deslocamento);
      saida.push({ texto: p, x: x + (inicio < 0 ? 0 : inicio) * larguraChar, y });
      deslocamento = (inicio < 0 ? deslocamento : inicio) + p.length;
    }
  }
  return saida;
}

/**
 * Agrupa palavras em linhas tolerando pequenas variações de y.
 *
 * O gerador do relatório desenha a linha de "Total ==>" em pedaços com alturas
 * levemente diferentes — o número numa altura, o valor noutra, 1 ou 2 pontos
 * de distância. Agrupando por y exato, a linha chega quebrada e o total se
 * perde; com tolerância, ela volta inteira.
 */
function agruparTolerante(palavras, tolerancia) {
  const ordenadas = [...palavras].sort((a, b) => a.y - b.y || a.x - b.x);
  const linhas = [];
  let atual = null;
  for (const p of ordenadas) {
    if (!atual || p.y - atual.y > tolerancia) {
      atual = { y: p.y, palavras: [p] };
      linhas.push(atual);
    } else {
      atual.palavras.push(p);
    }
  }
  return linhas.map((l) => l.palavras.sort((a, b) => a.x - b.x).map((p) => p.texto).join(" "));
}

function agruparLinhas(palavras) {
  const mapa = new Map();
  for (const p of palavras) {
    const y = Math.round(p.y);
    if (!mapa.has(y)) mapa.set(y, []);
    mapa.get(y).push(p);
  }
  for (const lista of mapa.values()) lista.sort((a, b) => a.x - b.x);
  return mapa;
}

export async function parseRelatorio(arrayBuffer, pdfjsLib) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const meta = { empresa: null, empresaCodigo: null, empresaNome: null, dataInicio: null, dataFim: null, emitidoEm: null, paginas: pdf.numPages };
  const solicitacoes = [];
  const blocos = [];
  let blocoAtual = [];
  let banco = null, tipo = null, familia = "A";

  for (let n = 1; n <= pdf.numPages; n++) {
    const pagina = await pdf.getPage(n);
    const palavras = await palavrasDaPagina(pagina);

    // passe tolerante: fecha blocos por banco e lê os totais impressos
    for (const L of agruparTolerante(palavras, 3)) {
      const texto = L.trim();
      if (texto.startsWith("BANCO ") && (texto.includes("Ag.") || texto.includes("C/C"))) {
        if (blocoAtual.length) blocos.push(blocoAtual);
        blocoAtual = [];
        continue;
      }
      const mt = texto.match(RE_TOTAL);
      if (mt) blocoAtual.push([parseInt(mt[1], 10), num(mt[2])]);
    }

    const linhas = agruparLinhas(palavras);
    const ys = [...linhas.keys()].sort((a, b) => a - b);
    const texto = new Map(ys.map((y) => [y, linhas.get(y).map((p) => p.texto).join(" ")]));

    const ignorar = new Set();
    const paradas = [];   // linhas de total/cabeçalho: nenhum registro atravessa
    const ancoras = [];
    for (const y of ys) {
      const L = (texto.get(y) || "").trim();

      // caixa da empresa: "15 - MOMENTUM EMPREENDIMENTOS IMOBILIARIOS LTDA.",
      // sempre antes da faixa de datas. O código tem no máximo 4 dígitos, o que
      // separa essa linha das solicitações (S.N tem 7).
      if (!meta.empresa && !meta.dataInicio) {
        const me = L.match(/^(\d{1,4})\s*-\s*([A-Za-zÀ-ÿ][^\n]*)$/);
        if (me) { meta.empresa = L; meta.empresaCodigo = me[1]; meta.empresaNome = me[2].trim(); }
      }
      if (!meta.dataInicio) {
        const m = L.match(/CORRENTE - (\d{2}\/\d{2}\/\d{4}) a (\d{2}\/\d{2}\/\d{4})/);
        if (m) { meta.dataInicio = m[1]; meta.dataFim = m[2]; }
      }
      if (!meta.emitidoEm && /^\d{2}:\d{2}:\d{2}$/.test(L)) meta.emitidoEm = L;

      if (L.startsWith("BANCO ") && (L.includes("Ag.") || L.includes("C/C"))) {
        banco = L; ignorar.add(y);
        continue;
      }
      if (TIPOS.includes(L)) { tipo = TIPO_CURTO[L] || L; ignorar.add(y); continue; }
      // o valor numérico do total é lido no passe tolerante, abaixo
      // fragmentos de linha de total que caem em outro bucket de y
      if (/Total ==>|Solicitação\(ões\)/.test(L) || /^R\$\s*[\d.,]+$/.test(L)) { ignorar.add(y); paradas.push(y); continue; }
      if (RUIDO.some((p) => L.startsWith(p))) { ignorar.add(y); continue; }
      // a caixa da empresa se repete no alto de cada página
      if (meta.empresa && L === meta.empresa) { ignorar.add(y); continue; }
      if (/^S\.N\b/.test(L)) {
        ignorar.add(y);
        const sn = linhas.get(y).find((p) => p.texto === "S.N");
        familia = sn && sn.x >= 31 ? "A" : "B";
        for (const yy of ys) if (yy >= y - 25 && yy <= y + 14) ignorar.add(yy);
        continue;
      }
      // Âncora da solicitação: o S.N, na primeira coluna. Antes a âncora era a
      // palavra "MATRIZ" na coluna FILIAL — servia só para a empresa 15. Em
      // relatórios de outras empresas a filial vem com outro nome (SLIM, por
      // exemplo) e nenhuma solicitação era extraída.
      const fimSN = COLUNAS[familia][0][2];
      if (linhas.get(y).some((p) => /^\d{6,8}$/.test(p.texto) && p.x < fimSN))
        ancoras.push({ y, banco, tipo, familia });
    }

    ancoras.forEach((a, i) => {
      const ini = a.y - 6;
      let fim = i + 1 < ancoras.length ? ancoras[i + 1].y - 6 : Infinity;
      const parada = paradas.filter((p) => p > a.y).sort((u, v) => u - v)[0];
      if (parada !== undefined) fim = Math.min(fim, parada - 2);
      const buf = {};
      for (const y of ys) {
        if (y < ini || y >= fim || ignorar.has(y)) continue;
        for (const p of linhas.get(y)) {
          const c = coluna(a.familia, p.x);
          (buf[c] = buf[c] || []).push({ y, x: p.x, t: p.texto });
        }
      }
      const reg = { bancoDebitado: a.banco, tipo: a.tipo };
      for (const [nome] of COLUNAS[a.familia]) {
        const partes = (buf[nome] || []).sort((u, v) => u.y - v.y || u.x - v.x);
        reg[nome] = partes.map((p) => p.t).join(" ").trim();
      }
      if (/^\d{6,8}$/.test(reg.sn)) { reg.valor = num(reg.valor); solicitacoes.push(reg); }
    });
  }
  if (blocoAtual.length) blocos.push(blocoAtual);

  for (const s of solicitacoes) s.alertas = alertas(s);
  marcarRepetidos(solicitacoes);

  // confere o extraído contra os totais impressos no rodapé de cada seção
  let qtdRel = 0, valorRel = 0;
  const totaisLidos = blocos.reduce((a, b) => a + b.length, 0);
  for (let b of blocos) {
    if (b.length > 1) {
      const q = b.slice(0, -1).reduce((a, x) => a + x[0], 0);
      const v = b.slice(0, -1).reduce((a, x) => a + x[1], 0);
      if (b[b.length - 1][0] === q && Math.abs(b[b.length - 1][1] - v) < 0.01) b = b.slice(0, -1);
    }
    qtdRel += b.reduce((a, x) => a + x[0], 0);
    valorRel += b.reduce((a, x) => a + x[1], 0);
  }
  const valorExtraido = Math.round(solicitacoes.reduce((a, s) => a + (s.valor || 0), 0) * 100) / 100;
  valorRel = Math.round(valorRel * 100) / 100;

  return {
    meta, solicitacoes,
    validacao: {
      qtdExtraida: solicitacoes.length, valorExtraido,
      qtdRelatorio: qtdRel, valorRelatorio: valorRel,
      totaisLidos, blocos: blocos.length,
      confere: solicitacoes.length === qtdRel && Math.abs(valorExtraido - valorRel) < 0.01,
    },
  };
}

const docCadastrado = (t) => (t.match(/Notas Fiscais:\s*(\d+)/) || [])[1] || null;
const nfsCitadas = (t) => [...new Set([...t.matchAll(/\bNF\.?\s*n?[ºo]?\s*(\d+)/g)].map((m) => m[1]))];

/** Só o que é objetivo e verificável. O julgamento é do conferente. */
function alertas(s) {
  const out = [];
  if (s.solicitante.trim() && s.solicitante.trim() === s.competente.trim())
    out.push("Solicitante e Competente são a mesma pessoa");
  const doc = docCadastrado(s.destinacao), nfs = nfsCitadas(s.destinacao);
  if (doc && nfs.length && nfs.every((v) => parseInt(v, 10) !== parseInt(doc, 10)))
    out.push(`Documento cadastrado (${doc}) diverge da NF citada (${nfs.join("/")})`);
  if (!s.poder.trim()) out.push("Poder não informado");
  return out;
}

/** Mesmo documento + mesmo CNPJ em S.N diferentes = duplicidade real. */
function marcarRepetidos(solicitacoes) {
  const idx = new Map();
  for (const s of solicitacoes) {
    const doc = docCadastrado(s.destinacao);
    if (!doc) continue;
    const k = `${s.cpfCnpj}|${doc}`;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(s.sn);
  }
  for (const s of solicitacoes) {
    const doc = docCadastrado(s.destinacao);
    if (doc && (idx.get(`${s.cpfCnpj}|${doc}`) || new Set()).size > 1)
      s.alertas.push("Documento já pago em outra solicitação do lote");
  }
}
