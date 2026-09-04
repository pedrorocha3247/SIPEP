# Módulo: Conferência de Pagamentos

Conferência do relatório **"Solicitações de Pagamentos por Débito em Conta
Corrente"** (SCK): sobe o PDF, o módulo extrai as solicitações, você analisa uma
a uma e no fim gera a planilha com os pareceres.

Publicado em `/SIPEP/conferencia/`.

## Como funciona

1. **Upload** — arrasta o PDF (ou clica). O arquivo é lido pelo próprio
   navegador; nada vai para servidor nenhum.
2. **Extração** — o parser lê as 5 seções (Transferência, TED, Débito em Conta,
   PIX, Boleto) e **confere o que extraiu contra os totais impressos no rodapé
   do próprio PDF**. Se não bater, a tela avisa antes de você começar.
3. **Análise uma a uma** — uma solicitação por tela: status
   (Conforme / Ressalva / Retido / Devolvido) e o parecer.
   Atalhos: `1`–`4` escolhem o status, `Ctrl+Enter` salva e avança,
   `←` `→` navegam.
4. **Relatório** — o resumo mostra a contagem por status e gera o `.xlsx`
   (uma aba por tipo) ou o `.json` com tudo.

O progresso fica no `localStorage` do navegador. Dá pra fechar a aba e retomar
depois — a tela inicial lista as conferências em andamento.

## Arquivos

```
conferencia/
  index.html          telas (upload / análise / resumo)
  conferencia.css     estilo — reusa os tokens do design system do SIPEP
  conferencia.js      interface e geração da planilha
  parser.js           PDF -> dados estruturados  (sem dependência de UI)
  vendor/             pdf.js e SheetJS locais
```

`parser.js` não conhece o DOM: recebe o PDF e devolve os dados. É essa separação
que permite portar o módulo para dentro do app React sem reescrever a extração —
basta importar `parseRelatorio` e trocar a camada de tela.

```js
import { parseRelatorio } from "./parser.js";
const dados = await parseRelatorio(arrayBuffer, pdfjsLib);
dados.validacao;    // { qtdExtraida, valorExtraido, qtdRelatorio, valorRelatorio, confere }
dados.solicitacoes; // [{ sn, tipo, valor, favorecido, destinacao, alertas, ... }]
```

As bibliotecas estão em `vendor/` de propósito, em vez de vir de CDN: o módulo
funciona offline e não quebra se a rede da empresa bloquear CDN externo.

## Alertas automáticos

O parser marca — não julga, só sinaliza pra você olhar:

- Solicitante e Competente são a mesma pessoa;
- número do documento cadastrado divergente da NF citada no histórico;
- Poder não informado;
- mesmo documento + mesmo CNPJ em duas solicitações do lote.

Várias notas fiscais do mesmo favorecido **não** geram alerta — é o padrão
normal da operação.

## Se o layout do relatório mudar

O PDF traz duas famílias de layout no mesmo arquivo: TED/PIX/Transferência usam
uma, Débito em Conta/Boleto usam outra, deslocada ~9 pontos à esquerda. A família
é detectada pela posição do cabeçalho `S.N`. Cada solicitação é ancorada na linha
que contém `MATRIZ` e vai até a âncora seguinte — é assim que os textos que
quebram em várias linhas (favorecido, destinação) são remontados.

Mudou o layout? O ajuste é nas faixas de `COLUNAS`, no topo do `parser.js`. A
validação contra os totais impressos avisa na hora se algo saiu do lugar.
