/**
 * Módulo de Conferência de Pagamentos — NOCTUS
 *
 * Roda inteiro no navegador: o PDF é lido localmente, o progresso fica no
 * localStorage e a planilha é gerada no cliente. Nenhum dado sai da máquina.
 */
import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { parseRelatorio } from "./parser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

const ORDEM = ["TRANSFERÊNCIA", "TED", "DÉBITO EM CONTA", "PIX", "BOLETO"];
const STATUS = [
  { valor: "Aprovado",                   id: "aprovado"   },
  { valor: "Aguardando esclarecimentos", id: "aguardando" },
  { valor: "Recusado",                   id: "recusado"   },
];
/**
 * Nomes usados em versões anteriores, para não perder os pareceres já dados.
 * "Aprovado com ressalva" virou "Aprovado" — a ressalva em si segue escrita
 * no texto do parecer, que é onde ela sempre esteve.
 */
const STATUS_ANTIGOS = {
  Conforme: "Aprovado",
  Ressalva: "Aprovado",
  "Aprovado com ressalva": "Aprovado",
  Retido: "Aguardando esclarecimentos",
  "Em dúvida": "Aguardando esclarecimentos",
  Devolvido: "Recusado",
};
const idDoStatus = (v) => (STATUS.find((s) => s.valor === v) || {}).id || "";
const CHAVE = "noctus.conferencia";
const CHAVE_ANTIGA = "sipep.conferencia";

const $ = (id) => document.getElementById(id);
const moeda = (v) =>
  (v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let estado = { dados: null, itens: [], pareceres: {}, i: 0, mesclagem: null };

/* ---------------------------------------------------------------- persistência */
/**
 * A chave é a data do relatório mais a empresa. O SCK vai acrescentando
 * solicitações ao longo do dia, então o relatório da tarde é o MESMO lote da
 * manhã, com mais linhas — e não uma conferência nova. Mas cada empresa tem o
 * seu relatório, então o mesmo dia pode ter vários lotes, um por empresa.
 */
const codEmpresa = (meta) => {
  const m = String(meta?.empresaCodigo || meta?.empresa || "").match(/^\s*(\d{1,4})/);
  if (m) return m[1];
  const nome = String(meta?.empresaNome || meta?.empresa || "").trim();
  return nome ? nome.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 24) : "sem-empresa";
};
const nomeEmpresa = (meta) =>
  meta?.empresa || meta?.empresaNome || "Empresa não identificada";

const chaveLote = (d) =>
  `${CHAVE}.${(d.meta.dataInicio || "sem-data").replace(/\//g, "-")}.e${codEmpresa(d.meta)}`;

/** Campos cuja alteração invalida um parecer já dado. */
const assinatura = (s) => [s.tipo, s.valor, s.favorecido, s.cpfCnpj, s.destinacao,
                           s.poder, s.solicitante, s.competente].join("|");

/**
 * Junta o relatório recém-aberto com a conferência já gravada para aquela data.
 * O relatório novo é a verdade: ele manda na lista. Os pareceres já dados são
 * preservados, menos os de solicitações que mudaram — esses voltam a pendente,
 * porque conferir R$ 10.000 não vale como parecer para R$ 15.000.
 */
function mesclar(anterior, novo) {
  const antes = new Map((anterior.solicitacoes || []).map((s) => [s.sn, s]));
  const pareceresAntigos = anterior.pareceres || {};
  const pareceres = {};
  const novas = [], alteradas = [];

  for (const s of novo.solicitacoes) {
    const anteriorS = antes.get(s.sn);
    if (!anteriorS) { novas.push(s.sn); continue; }
    const p = pareceresAntigos[s.sn];
    if (!p) continue;
    if (p.status && assinatura(anteriorS) !== assinatura(s)) {
      // guarda o texto para ele reaproveitar, mas o status volta a pendente
      pareceres[s.sn] = { status: "", parecer: p.parecer };
      alteradas.push(s.sn);
    } else {
      pareceres[s.sn] = p;
    }
  }

  const agora = new Set(novo.solicitacoes.map((s) => s.sn));
  const sumiram = (anterior.solicitacoes || [])
    .filter((s) => !agora.has(s.sn) && pareceresAntigos[s.sn]?.status)
    .map((s) => s.sn);

  return { pareceres, novas, alteradas, sumiram };
}

function salvar() {
  try {
    localStorage.setItem(chaveLote(estado.dados), JSON.stringify({
      meta: estado.dados.meta, validacao: estado.dados.validacao,
      solicitacoes: estado.dados.solicitacoes, pareceres: estado.pareceres, i: estado.i,
    }));
  } catch (e) { /* modo privado, cota cheia: a conferência continua, só não persiste */ }
}

/**
 * As conferências guardadas antes de o sistema virar NOCTUS continuam valendo:
 * migra as chaves antigas na primeira abertura, sem perder nenhum parecer.
 */
function migrarChaves() {
  try {
    for (const antiga of Object.keys(localStorage)) {
      if (!antiga.startsWith(CHAVE_ANTIGA + ".")) continue;
      const nova = CHAVE + antiga.slice(CHAVE_ANTIGA.length);
      if (!localStorage.getItem(nova)) localStorage.setItem(nova, localStorage.getItem(antiga));
      localStorage.removeItem(antiga);
    }
    // chaves antigas traziam a quantidade no fim (…02-09-2026.94): agora a data basta
    for (const chave of Object.keys(localStorage)) {
      const m = chave.match(new RegExp(`^${CHAVE}\\.(\\d{2}-\\d{2}-\\d{4})\\.\\d+$`));
      if (!m) continue;
      const destino = `${CHAVE}.${m[1]}`;
      const atual = localStorage.getItem(destino);
      if (!atual) {
        localStorage.setItem(destino, localStorage.getItem(chave));
      } else {
        // duas gravações do mesmo dia: fica a de lista maior, com os pareceres somados
        const a = JSON.parse(atual), b = JSON.parse(localStorage.getItem(chave));
        const base = (b.solicitacoes || []).length > (a.solicitacoes || []).length ? b : a;
        base.pareceres = { ...(b.pareceres || {}), ...(a.pareceres || {}) };
        localStorage.setItem(destino, JSON.stringify(base));
      }
      localStorage.removeItem(chave);
    }
    // chaves só-data (…09-09-2026): agora cada empresa tem o seu lote
    for (const chave of Object.keys(localStorage)) {
      const m = chave.match(new RegExp(`^${CHAVE}\\.(\\d{2}-\\d{2}-\\d{4})$`));
      if (!m) continue;
      const v = JSON.parse(localStorage.getItem(chave));
      const destino = `${chave}.e${codEmpresa(v.meta)}`;
      if (!localStorage.getItem(destino)) localStorage.setItem(destino, localStorage.getItem(chave));
      localStorage.removeItem(chave);
    }
    for (const chave of Object.keys(localStorage)) {
      if (!chave.startsWith(CHAVE + ".")) continue;
      const v = JSON.parse(localStorage.getItem(chave));
      let mudou = false;
      for (const p of Object.values(v.pareceres || {})) {
        if (STATUS_ANTIGOS[p.status]) { p.status = STATUS_ANTIGOS[p.status]; mudou = true; }
      }
      if (mudou) localStorage.setItem(chave, JSON.stringify(v));
    }
  } catch (e) { /* modo privado ou entrada corrompida: segue sem migrar */ }
}

function lotesSalvos() {
  const out = [];
  for (let k = 0; k < localStorage.length; k++) {
    const chave = localStorage.key(k);
    if (!chave || !chave.startsWith(CHAVE + ".")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(chave));
      out.push({ chave, meta: v.meta, data: v.meta?.dataInicio || "sem data",
                 empresa: nomeEmpresa(v.meta), total: v.solicitacoes.length,
                 feitos: Object.values(v.pareceres || {}).filter((p) => p.status).length });
    } catch (e) { /* entrada corrompida: ignora */ }
  }
  const ord = (d) => (d || "").split("/").reverse().join("-");
  return out.sort((a, b) => ord(b.data).localeCompare(ord(a.data)) ||
                            a.empresa.localeCompare(b.empresa));
}

function carregar(chave) {
  const v = JSON.parse(localStorage.getItem(chave));
  estado.dados = { meta: v.meta, validacao: v.validacao, solicitacoes: v.solicitacoes };
  estado.pareceres = v.pareceres || {};
  estado.itens = ordenar(v.solicitacoes);
  estado.i = Math.min(v.i || 0, estado.itens.length - 1);
  irPara("revisao");
  render();
}

/* ------------------------------------------------------------------- utilidades */
const ordenar = (ss) =>
  [...ss].sort((a, b) => {
    const ta = ORDEM.indexOf(a.tipo), tb = ORDEM.indexOf(b.tipo);
    return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) || (b.valor || 0) - (a.valor || 0);
  });

const feitos = () => estado.itens.filter((s) => estado.pareceres[s.sn]?.status).length;

function irPara(tela) {
  for (const t of ["upload", "revisao", "resumo"])
    $("tela-" + t).classList.toggle("oculto", t !== tela);
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------------ upload */
function ligarUpload() {
  const solta = $("solta"), input = $("arquivo");
  solta.onclick = () => input.click();
  solta.ondragover = (e) => { e.preventDefault(); solta.classList.add("ativa"); };
  solta.ondragleave = () => solta.classList.remove("ativa");
  solta.ondrop = (e) => {
    e.preventDefault(); solta.classList.remove("ativa");
    if (e.dataTransfer.files[0]) processar(e.dataTransfer.files[0]);
  };
  input.onchange = () => input.files[0] && processar(input.files[0]);

  renderRetomar();
}

/**
 * Lista as conferências guardadas neste navegador.
 * `confirmando` é a chave do lote que está pedindo confirmação de remoção —
 * confirmação inline, e não confirm() nativo, que congela a página.
 */
function renderRetomar(confirmando) {
  const caixa = $("retomar");
  const salvos = lotesSalvos();
  if (!salvos.length) { caixa.classList.add("oculto"); caixa.innerHTML = ""; return; }
  caixa.classList.remove("oculto");

  // agrupa por dia, com as empresas daquele dia embaixo
  const dias = [];
  for (const l of salvos) {
    const ultimo = dias[dias.length - 1];
    if (ultimo && ultimo.data === l.data) ultimo.lotes.push(l);
    else dias.push({ data: l.data, lotes: [l] });
  }

  const linha = (l) => l.chave === confirmando ? `
    <div class="lote lote--confirma">
      <span>Remover a conferência de <b>${l.empresa}</b> em ${l.data}?
        <span class="sub">${l.feitos ? `Os ${l.feitos} pareceres já dados serão perdidos.`
                                     : "Nenhum parecer foi dado nela."}</span></span>
      <span class="lote__acoes">
        <button class="botao fantasma" data-acao="cancelar">Cancelar</button>
        <button class="botao perigo" data-acao="remover" data-chave="${l.chave}">Remover</button>
      </span>
    </div>` : `
    <div class="lote${l.feitos === l.total ? " lote--completa" : ""}">
      <span class="lote__id">${l.empresa}
        <span class="sub">${l.feitos} de ${l.total} conferidas</span></span>
      <span class="lote__acoes">
        <button class="botao fantasma" data-acao="retomar" data-chave="${l.chave}">Retomar</button>
        <button class="lote__x" data-acao="perguntar" data-chave="${l.chave}"
                title="Remover esta conferência" aria-label="Remover esta conferência">✕</button>
      </span>
    </div>`;

  caixa.innerHTML =
    `<p class="sub" style="margin-bottom:.6rem">Conferências em andamento neste navegador:</p>` +
    dias.map((d) => `
      <div class="dia">
        <div class="dia__cab">${d.data}
          <span class="sub">${d.lotes.length === 1 ? "1 empresa"
                                                   : d.lotes.length + " empresas"}</span></div>
        ${d.lotes.map(linha).join("")}
      </div>`).join("");

  caixa.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      const { acao, chave } = b.dataset;
      if (acao === "retomar") carregar(chave);
      else if (acao === "perguntar") renderRetomar(chave);
      else if (acao === "cancelar") renderRetomar();
      else if (acao === "remover") {
        try { localStorage.removeItem(chave); } catch (e) { /* nada a fazer */ }
        renderRetomar();
      }
    };
  });
}

async function processar(arquivo) {
  const msg = $("upload-msg");
  if (!arquivo.name.toLowerCase().endsWith(".pdf")) {
    msg.innerHTML = `<div class="alerta erro">Envie o relatório em PDF.</div>`;
    return;
  }
  msg.innerHTML = `<div class="alerta">Lendo o relatório…</div>`;
  try {
    const dados = await parseRelatorio(new Uint8Array(await arquivo.arrayBuffer()), pdfjsLib);
    if (!dados.solicitacoes.length) {
      msg.innerHTML = `<div class="alerta erro">Nenhuma solicitação encontrada.
        O layout do relatório mudou?</div>`;
      return;
    }
    msg.innerHTML = "";
    const salvo = localStorage.getItem(chaveLote(dados));
    estado.dados = dados;
    estado.itens = ordenar(dados.solicitacoes);
    estado.i = 0;

    if (salvo) {
      const r = mesclar(JSON.parse(salvo), dados);
      estado.pareceres = r.pareceres;
      estado.mesclagem = r;
    } else {
      estado.pareceres = {};
      estado.mesclagem = null;
    }
    salvar();
    irPara("revisao");
    render();
  } catch (e) {
    msg.innerHTML = `<div class="alerta erro">Não consegui ler o relatório: ${e.message}</div>`;
  }
}

/* -------------------------------------------------------------------- conferência */
function render() {
  const { validacao } = estado.dados;
  const m = estado.mesclagem;
  $("aviso-mesclagem").innerHTML = !m || (!m.novas.length && !m.alteradas.length && !m.sumiram.length)
    ? ""
    : `<div class="alerta ok">
        <b>Relatório atualizado.</b> Seus pareceres foram mantidos.
        ${m.novas.length ? `${m.novas.length} solicitação(ões) nova(s).` : ""}
        ${m.alteradas.length ? `${m.alteradas.length} mudou/mudaram desde a última conferência
           e voltaram a pendente — o texto do parecer ficou guardado.` : ""}
        ${m.sumiram.length ? `${m.sumiram.length} que você já tinha conferido saiu/saíram do
           relatório: ${m.sumiram.join(", ")}.` : ""}
        <button class="alerta__x" id="btn-fecha-mesclagem" title="Dispensar">✕</button>
      </div>`;
  if (m) {
    const x = $("btn-fecha-mesclagem");
    if (x) x.onclick = () => { estado.mesclagem = null; $("aviso-mesclagem").innerHTML = ""; };
  }

  $("aviso-extracao").innerHTML = validacao.confere ? ""
    : `<div class="alerta erro"><b>Atenção:</b> o que extraí não bateu com os totais impressos
        (${validacao.qtdExtraida} × ${validacao.qtdRelatorio} solicitações,
        R$ ${moeda(validacao.valorExtraido)} × R$ ${moeda(validacao.valorRelatorio)}).
        Confira o PDF antes de emitir o parecer.</div>`;

  const s = estado.itens[estado.i];
  const total = estado.itens.length;
  $("rev-tipo").textContent = s.tipo;
  $("rev-contador").textContent = `solicitação ${estado.i + 1} de ${total} · ${feitos()} conferidas`;
  $("rev-barra").style.width = (feitos() / total * 100).toFixed(1) + "%";

  $("rev-alertas").innerHTML = (s.alertas || [])
    .map((a) => `<div class="alerta">${a}</div>`).join("");

  $("c-sn").textContent = s.sn;
  $("c-valor").textContent = "R$ " + moeda(s.valor);
  $("c-poder").textContent = s.poder || "—";
  $("c-solicitante").textContent = s.solicitante || "—";
  $("c-competente").textContent = s.competente || "—";
  $("c-favorecido").textContent =
    [s.favorecido, s.cpfCnpj].filter(Boolean).join("  ·  ") || "—";
  $("c-destinacao").textContent = s.destinacao || "—";

  const p = estado.pareceres[s.sn] || {};
  for (const st of STATUS) $("st-" + st.id).checked = p.status === st.valor;
  $("rev-parecer").value = p.parecer || "";
  $("btn-anterior").disabled = estado.i === 0;
  $("btn-proxima").textContent =
    estado.i + 1 < total ? "Salvar e próxima" : "Salvar e finalizar";
}

function salvarAtual() {
  const s = estado.itens[estado.i];
  const st = document.querySelector('input[name="status"]:checked');
  estado.pareceres[s.sn] = { status: st ? st.value : "", parecer: $("rev-parecer").value.trim() };
  salvar();
}

function avancar(passo) {
  const novo = estado.i + passo;
  if (novo < 0 || novo >= estado.itens.length) return false;
  estado.i = novo; render(); return true;
}

function ligarRevisao() {
  $("btn-proxima").onclick = () => {
    salvarAtual();
    if (!avancar(1)) mostrarResumo();
  };
  $("btn-anterior").onclick = () => { salvarAtual(); avancar(-1); };
  $("btn-pular").onclick = () => { if (!avancar(1)) mostrarResumo(); };
  $("btn-resumo").onclick = () => { salvarAtual(); mostrarResumo(); };

  document.addEventListener("keydown", (e) => {
    if ($("tela-revisao").classList.contains("oculto")) return;
    const digitando = e.target.tagName === "TEXTAREA";
    if (+e.key >= 1 && +e.key <= STATUS.length && !digitando) {
      $("st-" + STATUS[+e.key - 1].id).checked = true; e.preventDefault();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      $("btn-proxima").click(); e.preventDefault();
    } else if (e.key === "ArrowRight" && !digitando) {
      salvarAtual(); avancar(1); e.preventDefault();
    } else if (e.key === "ArrowLeft" && !digitando) {
      salvarAtual(); avancar(-1); e.preventDefault();
    }
  });
}

/* ------------------------------------------------------------------------- resumo */
let filtro = null;
let ultimoAberto = null;   // cartão de onde o conferidor foi aberto

function mostrarResumo() {
  irPara("resumo");
  $("res-data").textContent =
    "· " + (estado.dados.meta.dataInicio || "") +
    (estado.dados.meta.empresa ? " · " + estado.dados.meta.empresa : "");

  const contagem = Object.fromEntries(STATUS.map((s) => [s.valor, 0]));
  contagem["Sem conferir"] = 0;
  for (const s of estado.itens) {
    const st = estado.pareceres[s.sn]?.status;
    contagem[st in contagem ? st : "Sem conferir"]++;
  }
  const classe = { Aprovado: "g", "Aguardando esclarecimentos": "b",
                   Recusado: "v", "Sem conferir": "n" };
  $("res-totais").innerHTML =
    `<div><span>Solicitações</span><b>${estado.itens.length}</b></div>
     <div><span>Valor total</span><b>R$ ${moeda(estado.dados.validacao.valorExtraido)}</b></div>`;
  $("res-status").innerHTML = Object.entries(contagem).filter(([, n]) => n)
    .map(([k, n]) => `<div class="status-card status-card--${classe[k]}">
        <b>${n}</b><span>${k}</span></div>`).join("");

  $("res-pendencia").innerHTML = contagem["Sem conferir"]
    ? `<div class="alerta">${contagem["Sem conferir"]} solicitação(ões) ainda sem status.</div>`
    : `<div class="alerta ok">Todas as solicitações conferidas.</div>`;

  $("res-filtros").innerHTML =
    [`<span class="chip ${filtro ? "" : "on"}" data-t="">Todas</span>`]
      .concat(ORDEM.filter((t) => estado.itens.some((s) => s.tipo === t))
        .map((t) => `<span class="chip ${filtro === t ? "on" : ""}" data-t="${t}">${t}</span>`))
      .join("");
  $("res-filtros").querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => { filtro = c.dataset.t || null; mostrarResumo(); };
  });

  const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const visiveis = estado.itens.filter((s) => !filtro || s.tipo === filtro);
  $("res-qtd").textContent =
    `· ${visiveis.length}${filtro ? " em " + filtro : ""}`;
  $("res-corpo").innerHTML = visiveis
    .map((s) => {
      const p = estado.pareceres[s.sn] || {};
      return `<div class="parecer${p.status ? "" : " parecer--pendente"}"
                   data-sn="${esc(s.sn)}" role="button" tabindex="0"
                   title="Abrir esta solicitação para conferir">
        <div class="parecer__topo">
          <span class="parecer__sn">${s.sn}</span>
          <span class="parecer__valor">R$ ${moeda(s.valor)}</span>
          ${p.status
            ? `<span class="marca marca--${idDoStatus(p.status)}">${p.status}</span>`
            : `<span class="marca marca--nenhum">Sem conferir</span>`}
          <span class="parecer__abrir">Abrir</span>
        </div>
        <div class="parecer__fav">${esc(s.favorecido)}</div>
        <div class="parecer__dest">${esc(s.destinacao)}</div>
        ${p.parecer ? `<div class="parecer__texto">${esc(p.parecer)}</div>` : ""}
      </div>`;
    }).join("");

  if (ultimoAberto) {
    const alvo = $("res-corpo").querySelector(`[data-sn="${CSS.escape(ultimoAberto)}"]`);
    if (alvo && !$("res-lista").hidden) alvo.scrollIntoView({ block: "center" });
  }
}

/** Abre no conferidor a solicitação do cartão clicado. */
function abrirSolicitacao(sn) {
  const i = estado.itens.findIndex((s) => s.sn === sn);
  if (i < 0) return;
  ultimoAberto = sn;
  estado.i = i;
  irPara("revisao");
  render();
}

function ligarResumo() {
  // clique em qualquer ponto do cartão abre a solicitação, mas sem atrapalhar
  // quem estiver só selecionando texto para copiar
  $("res-corpo").onclick = (e) => {
    if (String(window.getSelection())) return;
    const cartao = e.target.closest(".parecer");
    if (cartao) abrirSolicitacao(cartao.dataset.sn);
  };
  $("res-corpo").onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cartao = e.target.closest(".parecer");
    if (cartao) { e.preventDefault(); abrirSolicitacao(cartao.dataset.sn); }
  };
  $("btn-voltar").onclick = () => { irPara("revisao"); render(); };
  $("btn-imprimir").onclick = () => window.print();
  $("btn-planilha").onclick = gerarPlanilha;
  $("btn-lista").onclick = () => {
    const lista = $("res-lista");
    lista.hidden = !lista.hidden;
    $("btn-lista").textContent = lista.hidden ? "Mostrar" : "Ocultar";
    $("btn-lista").setAttribute("aria-expanded", String(!lista.hidden));
  };
}

/* ---------------------------------------------------------------------- planilha */
const AZUL = "FF1F3864";        // cabeçalho
const CINZA_LINHA = "FFD9D9D9"; // divisórias
const COR_STATUS = {
  "Aprovado": "FF15803D",
  "Aguardando esclarecimentos": "FF1D4ED8",
  "Recusado": "FFB91C1C",
};

/**
 * A biblioteca de planilha (~950KB) só é carregada quando alguém clica em gerar.
 * Tenta a cópia local primeiro — se ela não estiver no servidor, cai no CDN.
 */
async function carregarExcelJS() {
  if (window.ExcelJS) return;
  const origens = [
    "./vendor/exceljs.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
  ];
  for (const src of origens) {
    try {
      await new Promise((ok, falha) => {
        const s = document.createElement("script");
        s.src = src; s.onload = ok; s.onerror = () => falha(new Error(src));
        document.head.appendChild(s);
      });
      if (window.ExcelJS) return;
    } catch (e) { /* tenta a próxima origem */ }
  }
  throw new Error("não consegui carregar a biblioteca de planilha");
}

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mostra um erro no lugar do bloco de pendência, sem alert() nativo. */
function alertaNoResumo(texto) {
  $("res-pendencia").innerHTML = `<div class="alerta erro">${texto}</div>`;
}

const statusDe = (sn) => estado.pareceres[sn]?.status || "";
const statusNaPlanilha = (sn) => statusDe(sn) || "Sem conferir";
const parecerDe = (sn) => estado.pareceres[sn]?.parecer || "";

/** Largura de coluna pelo maior conteúdo, com piso e teto. */
function largura(valores, minimo, maximo) {
  const maior = valores.reduce((m, v) => Math.max(m, String(v ?? "").length), 0);
  return Math.min(Math.max(minimo, maior + 2), maximo);
}

function estilizarCabecalho(linha) {
  linha.height = 24;
  linha.eachCell((c) => {
    c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    c.alignment = { vertical: "middle", horizontal: "left" };
    c.border = { bottom: { style: "thin", color: { argb: AZUL } } };
  });
}

/** Aba de solicitações. `comTipo` inclui a coluna Tipo (usada só na aba TODAS). */
function abaSolicitacoes(wb, nome, itens, comTipo) {
  const ws = wb.addWorksheet(nome, {
    views: [{ showGridLines: false, state: "frozen", ySplit: 1 }],
  });
  const colunas = [
    { header: "S.N", key: "sn" },
    ...(comTipo ? [{ header: "Tipo", key: "tipo" }] : []),
    { header: "Valor (R$)", key: "valor" },
    { header: "Favorecido", key: "favorecido" },
    { header: "Destinação", key: "destinacao" },
    { header: "Status", key: "status" },
    { header: "Parecer", key: "parecer" },
  ];
  ws.columns = colunas;

  for (const s of itens) {
    ws.addRow({
      sn: s.sn, tipo: s.tipo, valor: s.valor,
      favorecido: s.favorecido, destinacao: s.destinacao,
      status: statusNaPlanilha(s.sn), parecer: parecerDe(s.sn),
    });
  }

  // largura pelo conteúdo; as colunas longas quebram linha e o Excel ajusta a altura
  const w = (k, min, max) => largura(itens.map((s) => ({
    sn: s.sn, tipo: s.tipo, valor: moeda(s.valor), favorecido: s.favorecido,
    destinacao: s.destinacao, status: statusNaPlanilha(s.sn), parecer: parecerDe(s.sn),
  }[k])).concat(colunas.find((c) => c.key === k).header), min, max);

  ws.getColumn("sn").width = w("sn", 10, 14);
  if (comTipo) ws.getColumn("tipo").width = w("tipo", 14, 22);
  ws.getColumn("valor").width = 14;
  ws.getColumn("favorecido").width = w("favorecido", 22, 42);
  ws.getColumn("destinacao").width = 58;
  ws.getColumn("status").width = 27;
  ws.getColumn("parecer").width = 46;

  estilizarCabecalho(ws.getRow(1));

  ws.eachRow((linha, n) => {
    if (n === 1) return;
    linha.eachCell((c) => {
      c.font = { name: "Calibri", size: 11 };
      c.alignment = { vertical: "top", wrapText: false };
      c.border = { bottom: { style: "hair", color: { argb: CINZA_LINHA } } };
    });
    linha.getCell("valor").numFmt = "#,##0.00";
    linha.getCell("valor").alignment = { vertical: "top", horizontal: "right" };
    for (const k of ["favorecido", "destinacao", "parecer"]) {
      linha.getCell(k).alignment = { vertical: "top", wrapText: true };
    }
    const st = linha.getCell("status");
    st.font = { name: "Calibri", size: 11, bold: !!COR_STATUS[st.value],
                color: { argb: COR_STATUS[st.value] || "FF808080" } };
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colunas.length } };
  return ws;
}

function abaResumo(wb) {
  const ws = wb.addWorksheet("RESUMO", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 30 }, { width: 10 }, { width: 18 }, { width: 12 },
                { width: 28 }, { width: 12 }, { width: 14 }];

  const titulo = (linha, texto, tamanho) => {
    const c = ws.getCell(`A${linha}`);
    c.value = texto;
    c.font = { name: "Calibri", size: tamanho, bold: true, color: { argb: AZUL } };
  };
  const cabecalho = (linha, textos) => {
    const l = ws.getRow(linha);
    textos.forEach((t, i) => (l.getCell(i + 1).value = t));
    l.height = 22;
    for (let i = 1; i <= textos.length; i++) {
      const c = l.getCell(i);
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      c.alignment = { vertical: "middle", horizontal: i === 1 ? "left" : "center", wrapText: true };
    }
  };

  titulo(1, "CONFERÊNCIA DE PAGAMENTOS", 16);
  ws.getCell("A2").value =
    `Relatório de ${estado.dados.meta.dataInicio || "—"} · ${estado.itens.length} solicitações · ` +
    `R$ ${moeda(estado.dados.validacao.valorExtraido)}`;
  ws.getCell("A2").font = { name: "Calibri", size: 11, color: { argb: "FF595959" } };
  ws.getCell("A3").value = estado.dados.meta.empresa || "";
  ws.getCell("A3").font = { name: "Calibri", size: 10, color: { argb: "FF808080" } };

  // ---- por forma de pagamento
  titulo(5, "POR FORMA DE PAGAMENTO", 12);
  const nomes = STATUS.map((s) => s.valor);
  cabecalho(6, ["Forma de pagamento", "Qtde", "Valor (R$)", ...nomes, "Sem conferir"]);

  let linha = 7;
  const tipos = ORDEM.filter((t) => estado.itens.some((s) => s.tipo === t));
  for (const t of tipos) {
    const doTipo = estado.itens.filter((s) => s.tipo === t);
    const conta = (v) => doTipo.filter((s) => (statusDe(s.sn) || "Sem conferir") === v).length;
    const l = ws.getRow(linha);
    l.getCell(1).value = t;
    l.getCell(2).value = doTipo.length;
    l.getCell(3).value = doTipo.reduce((a, s) => a + (s.valor || 0), 0);
    nomes.forEach((n, i) => (l.getCell(4 + i).value = conta(n)));
    l.getCell(4 + nomes.length).value = conta("Sem conferir");
    linha++;
  }

  const total = ws.getRow(linha);
  total.getCell(1).value = "TOTAL";
  total.getCell(2).value = { formula: `SUM(B7:B${linha - 1})` };
  total.getCell(3).value = { formula: `SUM(C7:C${linha - 1})` };
  for (let i = 0; i <= nomes.length; i++) {
    const col = String.fromCharCode(68 + i); // D em diante
    total.getCell(4 + i).value = { formula: `SUM(${col}7:${col}${linha - 1})` };
  }
  const fimTipos = linha;

  // ---- por status
  const inicioStatus = linha + 3;
  titulo(inicioStatus - 1, "POR STATUS", 12);
  cabecalho(inicioStatus, ["Status", "Qtde", "Valor (R$)", "% do valor"]);
  linha = inicioStatus + 1;
  const valorTotal = estado.itens.reduce((a, s) => a + (s.valor || 0), 0) || 1;
  for (const nome of [...nomes, "Sem conferir"]) {
    const doStatus = estado.itens.filter((s) => (statusDe(s.sn) || "Sem conferir") === nome);
    if (!doStatus.length) continue;
    const soma = doStatus.reduce((a, s) => a + (s.valor || 0), 0);
    const l = ws.getRow(linha);
    l.getCell(1).value = nome;
    l.getCell(2).value = doStatus.length;
    l.getCell(3).value = soma;
    l.getCell(4).value = soma / valorTotal;
    if (COR_STATUS[nome]) {
      l.getCell(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: COR_STATUS[nome] } };
    }
    linha++;
  }

  // formatação das duas tabelas
  for (let n = 7; n < linha; n++) {
    const l = ws.getRow(n);
    l.eachCell((c, i) => {
      if (!c.font) c.font = { name: "Calibri", size: 11 };
      c.border = { bottom: { style: "hair", color: { argb: CINZA_LINHA } } };
      if (i >= 2) c.alignment = { horizontal: "center" };
      if (i === 3) { c.numFmt = "#,##0.00"; c.alignment = { horizontal: "right" }; }
    });
    if (n >= inicioStatus + 1) l.getCell(4).numFmt = "0.0%";
  }
  const lt = ws.getRow(fimTipos);
  lt.eachCell((c) => {
    c.font = { name: "Calibri", size: 11, bold: true };
    c.border = { top: { style: "thin", color: { argb: AZUL } } };
  });
  lt.getCell(3).numFmt = "#,##0.00";

  return ws;
}

async function gerarPlanilha() {
  const btn = $("btn-planilha");
  const rotulo = btn.textContent;
  btn.disabled = true; btn.textContent = "Gerando…";
  try {
    await carregarExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "NOCTUS — Conferência de Pagamentos";
    wb.created = new Date();

    abaResumo(wb);
    abaSolicitacoes(wb, "TODAS", estado.itens, true);
    for (const tipo of ORDEM) {
      const linhas = estado.itens.filter((s) => s.tipo === tipo);
      if (linhas.length) abaSolicitacoes(wb, tipo.slice(0, 31), linhas, false);
    }

    const buffer = await wb.xlsx.writeBuffer();
    const ref = (estado.dados.meta.dataInicio || "").replace(/\//g, "-");
    baixar(new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }), `Conferencia_Pagamentos_${ref}.xlsx`);
  } catch (e) {
    alertaNoResumo(`Não consegui gerar a planilha: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = rotulo;
  }
}

/* ------------------------------------------------------------------------- início */
migrarChaves();
ligarUpload();
ligarRevisao();
ligarResumo();
