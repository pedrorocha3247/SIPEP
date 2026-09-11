/**
 * Módulo de Conferência de Pagamentos — NOCTUS
 *
 * Roda inteiro no navegador: o PDF é lido localmente, o progresso fica no
 * localStorage e a planilha é gerada no cliente. Nenhum dado sai da máquina.
 */
import * as pdfjsLib from "../conferencia/vendor/pdf.min.mjs";
import { parseRelatorio } from "./parser.js";
import { verificarPoder } from "./poderes.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("../conferencia/vendor/pdf.worker.min.mjs", import.meta.url).href;

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
const CHAVE_OTN = "noctus.otn";
const OTN_PADRAO = 130.30;

const $ = (id) => document.getElementById(id);
const moeda = (v) =>
  (v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Valor do OTN usado pra converter o limite de poder (em OTN) para reais. */
const otnAtual = () => {
  const v = parseFloat(localStorage.getItem(CHAVE_OTN));
  return isFinite(v) && v > 0 ? v : OTN_PADRAO;
};

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

function carregar(chave, destino) {
  const v = JSON.parse(localStorage.getItem(chave));
  estado.dados = { meta: v.meta, validacao: v.validacao, solicitacoes: v.solicitacoes };
  estado.pareceres = v.pareceres || {};
  estado.itens = ordenar(v.solicitacoes);
  estado.i = Math.min(v.i || 0, estado.itens.length - 1);
  irPara("revisao");
  render();
  // "Ver resumo" abre o relatório do dia direto; a tela de conferência fica
  // montada atrás, para o botão "Continuar conferindo" cair no lugar certo.
  if (destino === "resumo") mostrarResumo();
}

/* ------------------------------------------------------------------- utilidades */
const ordenar = (ss) =>
  [...ss].sort((a, b) => {
    const ta = ORDEM.indexOf(a.tipo), tb = ORDEM.indexOf(b.tipo);
    return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) || (b.valor || 0) - (a.valor || 0);
  });

const feitos = () => estado.itens.filter((s) => estado.pareceres[s.sn]?.status).length;

/**
 * Troca de tela e ajusta o "voltar" do cabeçalho.
 *
 * O voltar é de UM passo: do resumo ou da conferência volta-se para a tela do
 * relatório (onde estão as conferências salvas) e só de lá se sai para o
 * NOCTUS. Sair do módulo inteiro no meio de uma conferência era saída demais
 * para um clique só.
 */
function irPara(tela) {
  for (const t of ["upload", "revisao", "resumo"])
    $("tela-" + t).classList.toggle("oculto", t !== tela);
  telaAtual = tela;
  const a = $("voltar-topo");
  if (a) {
    a.textContent = tela === "upload" ? "Voltar" : "Voltar ao relatório";
    a.href = tela === "upload" ? "../#/" : "#";
    a.title = tela === "upload" ? "" : "Voltar para a tela do relatório";
  }
  window.scrollTo(0, 0);
}

let telaAtual = "upload";

function ligarVoltar() {
  const a = $("voltar-topo");
  if (!a) return;
  a.onclick = (e) => {
    if (telaAtual === "upload") return;   // deixa o link levar ao NOCTUS
    e.preventDefault();
    irPara("upload");
    renderRetomar();                      // os contadores mudaram desde que saiu daqui
  };
}

/* ------------------------------------------------------------------------ upload */
/**
 * Linha do OTN, usada pra converter os limites de poder (cadastrados em OTN
 * na Relação de Competentes e Poderes) para reais. Editável porque o valor
 * muda ao longo do tempo — hoje é 130,30, mas não dá pra deixar fixo no código.
 */
function renderOtnLinha() {
  $("otn-linha").innerHTML =
    `Limites de poder calculados com OTN a <strong>R$ ${moeda(otnAtual())}</strong>
     <button type="button" class="linkbtn" id="otn-editar">alterar</button>`;
  $("otn-editar").onclick = () => {
    $("otn-linha").innerHTML =
      `Valor do OTN:
       <input type="number" step="0.01" min="0.01" id="otn-input" class="otn-input" value="${otnAtual()}">
       <button type="button" class="botao fantasma" id="otn-salvar" style="width:auto;padding:.35rem .9rem">Salvar</button>
       <button type="button" class="linkbtn" id="otn-cancelar">cancelar</button>`;
    $("otn-input").focus();
    $("otn-cancelar").onclick = renderOtnLinha;
    $("otn-salvar").onclick = () => {
      const v = parseFloat($("otn-input").value.replace(",", "."));
      if (isFinite(v) && v > 0) localStorage.setItem(CHAVE_OTN, String(v));
      renderOtnLinha();
    };
  };
}

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

/** Quais dias estão expandidos na lista de conferências salvas (data -> aberto). */
const diasAbertos = {};

/**
 * Lista as conferências guardadas neste navegador.
 * `confirmando` é a chave do lote que está pedindo confirmação de remoção —
 * confirmação inline, e não confirm() nativo, que congela a página.
 */
function renderRetomar(confirmando) {
  const caixa = $("retomar");
  const salvos = lotesSalvos();
  renderRodapeGeral();
  if (!salvos.length) { caixa.classList.add("oculto"); caixa.innerHTML = ""; return; }
  caixa.classList.remove("oculto");

  // agrupa por dia, com as empresas daquele dia embaixo
  const dias = [];
  for (const l of salvos) {
    const ultimo = dias[dias.length - 1];
    if (ultimo && ultimo.data === l.data) ultimo.lotes.push(l);
    else dias.push({ data: l.data, lotes: [l] });
  }

  // o dia mais recente abre; os anteriores ficam recolhidos, senão a lista
  // cresce indefinidamente. A escolha do conferente vale enquanto a aba viver.
  dias.forEach((d, i) => {
    if (!(d.data in diasAbertos)) diasAbertos[d.data] = i === 0;
    // o dia que está pedindo confirmação de remoção não pode estar escondido
    if (confirmando && d.lotes.some((l) => l.chave === confirmando)) diasAbertos[d.data] = true;
  });

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
        <button class="botao fantasma" data-acao="resumo" data-chave="${l.chave}"
                title="Abrir o relatório de pareceres deste dia">Ver resumo</button>
        <button class="botao fantasma" data-acao="retomar" data-chave="${l.chave}">Retomar</button>
        <button class="lote__x" data-acao="perguntar" data-chave="${l.chave}"
                title="Remover esta conferência" aria-label="Remover esta conferência">✕</button>
      </span>
    </div>`;

  caixa.innerHTML =
    `<p class="sub" style="margin-bottom:.6rem">Conferências em andamento neste navegador:</p>` +
    dias.map((d) => {
      const aberto = diasAbertos[d.data];
      const pend = d.lotes.filter((l) => l.feitos < l.total).length;
      return `
      <div class="dia">
        <button class="dia__cab" data-acao="alternar-dia" data-dia="${d.data}"
                aria-expanded="${aberto}">
          <span class="dia__seta">${aberto ? "▾" : "▸"}</span>${d.data}
          <span class="sub">${d.lotes.length === 1 ? "1 empresa"
                                                   : d.lotes.length + " empresas"}${
            aberto ? "" : pend ? ` · ${pend} em aberto` : " · tudo conferido"}</span>
        </button>
        ${aberto ? d.lotes.map(linha).join("") : ""}
      </div>`;
    }).join("");

  caixa.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      const { acao, chave } = b.dataset;
      if (acao === "alternar-dia") {
        diasAbertos[b.dataset.dia] = !diasAbertos[b.dataset.dia];
        renderRetomar(confirmando);
        return;
      }
      if (acao === "retomar") carregar(chave);
      else if (acao === "resumo") carregar(chave, "resumo");
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
    const otn = otnAtual();
    for (const s of dados.solicitacoes) {
      const apontamento = verificarPoder(dados.meta.empresaCodigo, s.competente, s.poder, s.valor, otn);
      if (apontamento) s.alertas.push(apontamento);
    }
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
const APONTADAS = "@apontadas";   // valor de filtro que não colide com nome de forma de pagamento
const temApontamento = (s) => (s.alertas || []).length > 0;
const apontamentosDe = (s) => (s.alertas || []).join(" · ");

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

  const apontadas = estado.itens.filter(temApontamento).length;
  $("res-filtros").innerHTML =
    [`<span class="chip ${filtro ? "" : "on"}" data-t="">Todas</span>`]
      .concat(ORDEM.filter((t) => estado.itens.some((s) => s.tipo === t))
        .map((t) => `<span class="chip ${filtro === t ? "on" : ""}" data-t="${t}">${t}</span>`))
      .concat(apontadas ? [`<span class="chip chip--apontada ${filtro === APONTADAS ? "on" : ""}"
        data-t="${APONTADAS}" title="Solicitações que o sistema marcou"
        >${apontadas} com apontamento</span>`] : [])
      .join("");
  $("res-filtros").querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => { filtro = c.dataset.t || null; mostrarResumo(); };
  });

  const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const visiveis = estado.itens.filter((s) =>
    filtro === APONTADAS ? temApontamento(s) : (!filtro || s.tipo === filtro));
  $("res-qtd").textContent = `· ${visiveis.length}` +
    (filtro === APONTADAS ? " com apontamento" : filtro ? " em " + filtro : "");
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
        ${temApontamento(s)
          ? `<div class="parecer__apontamento">${esc(apontamentosDe(s))}</div>` : ""}
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
const AMBAR = "FF9C6500";       // apontamento automático
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
    "../conferencia/vendor/exceljs.min.js",
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
    { header: "Apontamentos", key: "apontamentos" },
    { header: "Status", key: "status" },
    { header: "Parecer", key: "parecer" },
  ];
  ws.columns = colunas;

  for (const s of itens) {
    ws.addRow({
      sn: s.sn, tipo: s.tipo, valor: s.valor,
      favorecido: s.favorecido, destinacao: s.destinacao,
      apontamentos: apontamentosDe(s),
      status: statusNaPlanilha(s.sn), parecer: parecerDe(s.sn),
    });
  }

  // largura pelo conteúdo; as colunas longas quebram linha e o Excel ajusta a altura
  const w = (k, min, max) => largura(itens.map((s) => ({
    sn: s.sn, tipo: s.tipo, valor: moeda(s.valor), favorecido: s.favorecido,
    destinacao: s.destinacao, apontamentos: apontamentosDe(s),
    status: statusNaPlanilha(s.sn), parecer: parecerDe(s.sn),
  }[k])).concat(colunas.find((c) => c.key === k).header), min, max);

  ws.getColumn("sn").width = w("sn", 10, 14);
  if (comTipo) ws.getColumn("tipo").width = w("tipo", 14, 22);
  ws.getColumn("valor").width = 14;
  ws.getColumn("favorecido").width = w("favorecido", 22, 42);
  ws.getColumn("destinacao").width = 58;
  ws.getColumn("apontamentos").width = 38;
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
    for (const k of ["favorecido", "destinacao", "apontamentos", "parecer"]) {
      linha.getCell(k).alignment = { vertical: "top", wrapText: true };
    }
    // o apontamento é do sistema, não do conferente: fica marcado, não escondido
    const ap = linha.getCell("apontamentos");
    if (ap.value) ap.font = { name: "Calibri", size: 11, bold: true, color: { argb: AMBAR } };
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

  // quantas solicitações o próprio sistema marcou — evidência de que a
  // verificação automática rodou, e quanto ela achou
  const comApontamento = estado.itens.filter((s) => (s.alertas || []).length).length;
  ws.getCell("A4").value = comApontamento
    ? `${comApontamento} solicitação(ões) com apontamento automático — ver coluna "Apontamentos"`
    : "Nenhum apontamento automático neste lote";
  ws.getCell("A4").font = comApontamento
    ? { name: "Calibri", size: 11, bold: true, color: { argb: AMBAR } }
    : { name: "Calibri", size: 10, color: { argb: "FF808080" } };

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

/* ------------------------------------------------- planilha de todas as conferências */

/**
 * Lê do navegador todas as conferências guardadas, já achatadas em linhas.
 *
 * A planilha do dia responde "o que eu conferi neste relatório". Esta responde
 * "o que passou por mim no período" — é ela que permite cruzar fornecedor,
 * valor e nota entre dias diferentes, coisa que a conferência de um lote só,
 * por definição, não enxerga.
 */
function consolidarLotes() {
  const lotes = [];
  for (let k = 0; k < localStorage.length; k++) {
    const chave = localStorage.key(k);
    if (!chave || !chave.startsWith(CHAVE + ".")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(chave));
      if (!Array.isArray(v.solicitacoes)) continue;
      lotes.push({
        data: v.meta?.dataInicio || "sem data",
        empresa: nomeEmpresa(v.meta),
        solicitacoes: v.solicitacoes,
        pareceres: v.pareceres || {},
      });
    } catch (e) { /* entrada corrompida: fica de fora */ }
  }
  const ord = (d) => (d || "").split("/").reverse().join("-");
  lotes.sort((a, b) => ord(a.data).localeCompare(ord(b.data)) ||
                       a.empresa.localeCompare(b.empresa));

  const linhas = [];
  for (const l of lotes) {
    for (const s of ordenar(l.solicitacoes)) {
      const p = l.pareceres[s.sn] || {};
      linhas.push({
        data: l.data, empresa: l.empresa, sn: s.sn, tipo: s.tipo, valor: s.valor,
        favorecido: s.favorecido, destinacao: s.destinacao,
        apontamentos: apontamentosDe(s),
        status: p.status || "Sem conferir", parecer: p.parecer || "",
      });
    }
  }
  return { lotes, linhas };
}

const COLUNAS_GERAL = [
  { header: "Data", key: "data", width: 12 },
  { header: "Empresa", key: "empresa", width: 34 },
  { header: "S.N", key: "sn", width: 12 },
  { header: "Forma de pagamento", key: "tipo", width: 20 },
  { header: "Valor (R$)", key: "valor", width: 14 },
  { header: "Favorecido", key: "favorecido", width: 38 },
  { header: "Destinação", key: "destinacao", width: 54 },
  { header: "Apontamentos", key: "apontamentos", width: 38 },
  { header: "Status", key: "status", width: 24 },
  { header: "Parecer", key: "parecer", width: 44 },
];

function abaGeral(wb, nome, linhas) {
  const ws = wb.addWorksheet(nome, {
    views: [{ showGridLines: false, state: "frozen", ySplit: 1 }],
  });
  ws.columns = COLUNAS_GERAL.map(({ header, key, width }) => ({ header, key, width }));
  for (const l of linhas) ws.addRow(l);
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
    for (const k of ["empresa", "favorecido", "destinacao", "apontamentos", "parecer"]) {
      linha.getCell(k).alignment = { vertical: "top", wrapText: true };
    }
    const ap = linha.getCell("apontamentos");
    if (ap.value) ap.font = { name: "Calibri", size: 11, bold: true, color: { argb: AMBAR } };
    const st = linha.getCell("status");
    st.font = { name: "Calibri", size: 11, bold: !!COR_STATUS[st.value],
                color: { argb: COR_STATUS[st.value] || "FF808080" } };
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUNAS_GERAL.length } };
  return ws;
}

function abaResumoGeral(wb, lotes, linhas) {
  const ws = wb.addWorksheet("RESUMO GERAL", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 12 }, { width: 40 }, { width: 10 }, { width: 16 },
                { width: 12 }, { width: 14 }, { width: 16 }];

  const titulo = (l, texto, tamanho) => {
    const c = ws.getCell(`A${l}`);
    c.value = texto;
    c.font = { name: "Calibri", size: tamanho, bold: true, color: { argb: AZUL } };
  };
  const cabecalho = (l, textos) => {
    const linha = ws.getRow(l);
    textos.forEach((t, i) => (linha.getCell(i + 1).value = t));
    linha.height = 22;
    for (let i = 1; i <= textos.length; i++) {
      const c = linha.getCell(i);
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      c.alignment = { vertical: "middle", horizontal: i <= 2 ? "left" : "center", wrapText: true };
    }
  };

  const datas = [...new Set(lotes.map((l) => l.data))];
  const valorTotal = linhas.reduce((a, l) => a + (l.valor || 0), 0);
  const apontadas = linhas.filter((l) => l.apontamentos).length;
  const semConferir = linhas.filter((l) => l.status === "Sem conferir").length;

  titulo(1, "CONFERÊNCIA DE PAGAMENTOS — CONSOLIDADO", 16);
  ws.getCell("A2").value =
    `${lotes.length} conferência(s) · ${datas.length} dia(s) · ${linhas.length} solicitações · ` +
    `R$ ${moeda(valorTotal)}`;
  ws.getCell("A2").font = { name: "Calibri", size: 11, color: { argb: "FF595959" } };
  ws.getCell("A3").value = datas.length
    ? `Período: ${datas[0]} a ${datas[datas.length - 1]} · gerado em ${new Date().toLocaleString("pt-BR")}`
    : "";
  ws.getCell("A3").font = { name: "Calibri", size: 10, color: { argb: "FF808080" } };
  ws.getCell("A4").value = apontadas
    ? `${apontadas} solicitação(ões) com apontamento automático — ver aba APONTAMENTOS`
    : "Nenhum apontamento automático no período";
  ws.getCell("A4").font = apontadas
    ? { name: "Calibri", size: 11, bold: true, color: { argb: AMBAR } }
    : { name: "Calibri", size: 10, color: { argb: "FF808080" } };
  ws.getCell("A5").value = semConferir
    ? `Atenção: ${semConferir} solicitação(ões) ainda sem parecer neste consolidado`
    : "Todas as solicitações do período estão conferidas";
  ws.getCell("A5").font = semConferir
    ? { name: "Calibri", size: 11, bold: true, color: { argb: "FFB91C1C" } }
    : { name: "Calibri", size: 10, color: { argb: "FF15803D" } };

  titulo(7, "POR DIA E EMPRESA", 12);
  cabecalho(8, ["Data", "Empresa", "Qtde", "Valor (R$)", "Conferidas", "Sem conferir", "Apontamentos"]);
  let l = 9;
  for (const lote of lotes) {
    const doLote = linhas.filter((x) => x.data === lote.data && x.empresa === lote.empresa);
    const linha = ws.getRow(l);
    linha.getCell(1).value = lote.data;
    linha.getCell(2).value = lote.empresa;
    linha.getCell(3).value = doLote.length;
    linha.getCell(4).value = doLote.reduce((a, x) => a + (x.valor || 0), 0);
    linha.getCell(5).value = doLote.filter((x) => x.status !== "Sem conferir").length;
    linha.getCell(6).value = doLote.filter((x) => x.status === "Sem conferir").length;
    linha.getCell(7).value = doLote.filter((x) => x.apontamentos).length;
    l++;
  }
  const total = ws.getRow(l);
  total.getCell(1).value = "TOTAL";
  for (const col of ["C", "D", "E", "F", "G"]) {
    total.getCell(col).value = { formula: `SUM(${col}9:${col}${l - 1})` };
  }
  const fimLotes = l;

  const inicioStatus = l + 3;
  titulo(inicioStatus - 1, "POR STATUS NO PERÍODO", 12);
  cabecalho(inicioStatus, ["Status", "", "Qtde", "Valor (R$)", "% do valor"]);
  l = inicioStatus + 1;
  const base = valorTotal || 1;
  for (const nome of [...STATUS.map((x) => x.valor), "Sem conferir"]) {
    const doStatus = linhas.filter((x) => x.status === nome);
    if (!doStatus.length) continue;
    const soma = doStatus.reduce((a, x) => a + (x.valor || 0), 0);
    const linha = ws.getRow(l);
    linha.getCell(1).value = nome;
    linha.getCell(3).value = doStatus.length;
    linha.getCell(4).value = soma;
    linha.getCell(5).value = soma / base;
    if (COR_STATUS[nome]) {
      linha.getCell(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: COR_STATUS[nome] } };
    }
    l++;
  }

  for (let n = 9; n < l; n++) {
    const linha = ws.getRow(n);
    linha.eachCell((c, i) => {
      if (!c.font) c.font = { name: "Calibri", size: 11 };
      c.border = { bottom: { style: "hair", color: { argb: CINZA_LINHA } } };
      if (i >= 3) c.alignment = { horizontal: "center" };
      if (i === 4) { c.numFmt = "#,##0.00"; c.alignment = { horizontal: "right" }; }
    });
    if (n >= inicioStatus + 1) linha.getCell(5).numFmt = "0.0%";
  }
  const lt = ws.getRow(fimLotes);
  lt.eachCell((c) => {
    c.font = { name: "Calibri", size: 11, bold: true };
    c.border = { top: { style: "thin", color: { argb: AZUL } } };
  });
  lt.getCell(4).numFmt = "#,##0.00";
  return ws;
}

/** Atualiza a linha do rodapé da tela do relatório. */
function renderRodapeGeral() {
  const caixa = $("rodape-upload");
  if (!caixa) return;
  const { lotes } = consolidarLotes();
  caixa.classList.toggle("oculto", !lotes.length);
}

async function gerarPlanilhaGeral() {
  const btn = $("btn-planilha-geral");
  const rotulo = btn.textContent;
  const aviso = (t, erro) => {
    $("upload-msg").innerHTML = `<div class="alerta${erro ? " erro" : ""}">${t}
      <button class="alerta__x" id="btn-fecha-planilha-geral" title="Dispensar">✕</button></div>`;
    $("btn-fecha-planilha-geral").onclick = () => { $("upload-msg").innerHTML = ""; };
  };
  btn.disabled = true; btn.textContent = "Gerando…";
  try {
    const { lotes, linhas } = consolidarLotes();
    if (!linhas.length) throw new Error("não há conferência guardada neste navegador");
    await carregarExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "NOCTUS — Conferência de Pagamentos";
    wb.created = new Date();

    abaResumoGeral(wb, lotes, linhas);
    abaGeral(wb, "TODAS", linhas);
    const apontadas = linhas.filter((l) => l.apontamentos);
    if (apontadas.length) abaGeral(wb, "APONTAMENTOS", apontadas);

    const buffer = await wb.xlsx.writeBuffer();
    const datas = [...new Set(lotes.map((l) => l.data))].map((d) => d.replace(/\//g, "-"));
    const ref = datas.length > 1 ? `${datas[0]}_a_${datas[datas.length - 1]}` : datas[0];
    baixar(new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }), `Conferencias_Consolidado_${ref}.xlsx`);
    aviso("Planilha consolidada gerada.", false);
  } catch (e) {
    aviso(`Não consegui gerar a planilha consolidada: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = rotulo;
  }
}

/* ------------------------------------------------------------------------- início */
migrarChaves();
ligarVoltar();
renderOtnLinha();
ligarUpload();
$("btn-planilha-geral").onclick = gerarPlanilhaGeral;
ligarRevisao();
ligarResumo();
