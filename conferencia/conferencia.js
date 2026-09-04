/**
 * Módulo de Conferência de Pagamentos — SIPEP
 *
 * Roda inteiro no navegador: o PDF é lido localmente, o progresso fica no
 * localStorage e a planilha é gerada no cliente. Nenhum dado sai da máquina.
 */
import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { parseRelatorio } from "./parser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

const ORDEM = ["TRANSFERÊNCIA", "TED", "DÉBITO EM CONTA", "PIX", "BOLETO"];
const STATUS = ["Conforme", "Ressalva", "Retido", "Devolvido"];
const CHAVE = "sipep.conferencia";

const $ = (id) => document.getElementById(id);
const moeda = (v) =>
  (v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let estado = { dados: null, itens: [], pareceres: {}, i: 0 };

/* ---------------------------------------------------------------- persistência */
const chaveLote = (d) =>
  `${CHAVE}.${(d.meta.dataInicio || "sem-data").replace(/\//g, "-")}.${d.validacao.qtdExtraida}`;

function salvar() {
  try {
    localStorage.setItem(chaveLote(estado.dados), JSON.stringify({
      meta: estado.dados.meta, validacao: estado.dados.validacao,
      solicitacoes: estado.dados.solicitacoes, pareceres: estado.pareceres, i: estado.i,
    }));
  } catch (e) { /* modo privado, cota cheia: a conferência continua, só não persiste */ }
}

function lotesSalvos() {
  const out = [];
  for (let k = 0; k < localStorage.length; k++) {
    const chave = localStorage.key(k);
    if (!chave || !chave.startsWith(CHAVE + ".")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(chave));
      out.push({ chave, meta: v.meta, total: v.solicitacoes.length,
                 feitos: Object.values(v.pareceres || {}).filter((p) => p.status).length });
    } catch (e) { /* entrada corrompida: ignora */ }
  }
  return out.sort((a, b) => (b.meta?.dataInicio || "").localeCompare(a.meta?.dataInicio || ""));
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

  const salvos = lotesSalvos();
  if (!salvos.length) return;
  $("retomar").classList.remove("oculto");
  $("retomar").innerHTML =
    `<p class="sub" style="margin-bottom:.6rem">Conferências em andamento neste navegador:</p>` +
    salvos.map((l) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;
                  padding:.6rem .8rem;border:1px solid var(--color-border);
                  border-radius:var(--radius-sm);margin-bottom:.5rem">
        <span>${l.meta?.dataInicio || "sem data"}
          <span class="sub">· ${l.feitos} de ${l.total} conferidas</span></span>
        <button class="botao fantasma" data-chave="${l.chave}">Retomar</button>
      </div>`).join("");
  $("retomar").querySelectorAll("button").forEach((b) => {
    b.onclick = () => carregar(b.dataset.chave);
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
    estado.pareceres = salvo ? (JSON.parse(salvo).pareceres || {}) : {};
    estado.i = 0;
    irPara("revisao");
    render();
  } catch (e) {
    msg.innerHTML = `<div class="alerta erro">Não consegui ler o relatório: ${e.message}</div>`;
  }
}

/* -------------------------------------------------------------------- conferência */
function render() {
  const { validacao, meta } = estado.dados;
  $("aviso-extracao").innerHTML = validacao.confere
    ? `<div class="alerta ok">Extração conferida: ${validacao.qtdExtraida} solicitações,
        R$ ${moeda(validacao.valorExtraido)} — bate com os totais impressos no relatório
        de ${meta.dataInicio}.</div>`
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
  $("c-cnpj").textContent = s.cpfCnpj || "—";
  $("c-solicitante").textContent = s.solicitante || "—";
  $("c-competente").textContent = s.competente || "—";
  $("c-favorecido").textContent = s.favorecido || "—";
  $("c-destinacao").textContent = s.destinacao || "—";
  $("c-banco").textContent = s.bancoDebitado || "—";
  $("l-complemento").textContent =
    s.tipo === "PIX" ? "Chave PIX"
    : (s.tipo === "BOLETO" || s.tipo === "DÉBITO EM CONTA") ? "Observação"
    : "Banco / agência / conta do favorecido";
  $("c-complemento").textContent = s.complemento || "—";

  const p = estado.pareceres[s.sn] || {};
  for (const st of STATUS) $("st-" + st).checked = p.status === st;
  $("rev-parecer").value = p.parecer || "";
  $("btn-anterior").disabled = estado.i === 0;
  $("btn-proxima").textContent =
    estado.i + 1 < total ? "Salvar e próxima →" : "Salvar e finalizar";
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
    if (e.key >= "1" && e.key <= "4" && !digitando) {
      $("st-" + STATUS[+e.key - 1]).checked = true; e.preventDefault();
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

function mostrarResumo() {
  irPara("resumo");
  $("res-data").textContent = "· " + (estado.dados.meta.dataInicio || "");

  const contagem = { Conforme: 0, Ressalva: 0, Retido: 0, Devolvido: 0, Pendente: 0 };
  for (const s of estado.itens) {
    const st = estado.pareceres[s.sn]?.status;
    contagem[st || "Pendente"]++;
  }
  const classe = { Conforme: "g", Ressalva: "a", Retido: "b", Devolvido: "v", Pendente: "" };
  $("res-pilulas").innerHTML =
    `<div class="pilula"><b>${estado.itens.length}</b><span>Solicitações</span></div>
     <div class="pilula"><b>${moeda(estado.dados.validacao.valorExtraido)}</b><span>Valor total R$</span></div>` +
    Object.entries(contagem).filter(([, n]) => n)
      .map(([k, n]) => `<div class="pilula ${classe[k]}"><b>${n}</b><span>${k}</span></div>`).join("");

  $("res-pendencia").innerHTML = contagem.Pendente
    ? `<div class="alerta">${contagem.Pendente} solicitação(ões) ainda sem status.</div>`
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
  $("res-corpo").innerHTML = estado.itens
    .filter((s) => !filtro || s.tipo === filtro)
    .map((s) => {
      const p = estado.pareceres[s.sn] || {};
      return `<tr class="${p.status ? "" : "pendente"}">
        <td>${s.sn}</td><td>${s.tipo}</td><td class="num">${moeda(s.valor)}</td>
        <td>${esc(s.favorecido)}</td>
        <td>${p.status ? `<span class="marca ${p.status}">${p.status}</span>` : "—"}</td>
        <td>${esc(p.parecer)}</td></tr>`;
    }).join("");
}

function ligarResumo() {
  $("btn-voltar").onclick = () => { irPara("revisao"); render(); };
  $("btn-imprimir").onclick = () => window.print();
  $("btn-planilha").onclick = gerarPlanilha;
  $("btn-json").onclick = () => {
    const blob = new Blob([JSON.stringify({
      meta: estado.dados.meta, validacao: estado.dados.validacao,
      solicitacoes: estado.dados.solicitacoes, pareceres: estado.pareceres,
    }, null, 1)], { type: "application/json" });
    baixar(blob, `conferencia_${(estado.dados.meta.dataInicio || "").replace(/\//g, "-")}.json`);
  };
}

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------------- planilha */
function gerarPlanilha() {
  const wb = XLSX.utils.book_new();
  for (const tipo of ORDEM) {
    const linhas = estado.itens.filter((s) => s.tipo === tipo);
    if (!linhas.length) continue;
    const aoa = [["S.N", "Valor (R$)", "Favorecido", "Destinação", "STATUS", "PARECER"]];
    for (const s of linhas) {
      const p = estado.pareceres[s.sn] || {};
      aoa.push([s.sn, s.valor, s.favorecido, s.destinacao, p.status || "", p.parecer || ""]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 10 }, { wch: 13 }, { wch: 32 }, { wch: 60 }, { wch: 14 }, { wch: 46 }];
    ws["!autofilter"] = { ref: `A1:F${aoa.length}` };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    for (let r = 1; r < aoa.length; r++) {
      const c = XLSX.utils.encode_cell({ r, c: 1 });
      if (ws[c]) ws[c].z = "#,##0.00";
    }
    XLSX.utils.book_append_sheet(wb, ws, tipo.slice(0, 31));
  }
  const ref = (estado.dados.meta.dataInicio || "").replace(/\//g, "-");
  XLSX.writeFile(wb, `Conferencia_Pagamentos_${ref}.xlsx`);
}

/* ------------------------------------------------------------------------- início */
ligarUpload();
ligarRevisao();
ligarResumo();
