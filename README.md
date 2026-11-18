# 🌧️ Radar Niterói Nowcast

Userscript que prevê quando a chuva chega a um ponto escolhido, quanto tempo dura e quanto chove, usando o radar meteorológico de Niterói (https://radar.niteroi.rj.gov.br/).

![Painel do Preditor de Chuva](docs/screenshot.png)

## Instalação

1. Instale o [Violentmonkey](https://violentmonkey.github.io/) (Edge/Chrome/Firefox) ou o Tampermonkey.
2. Abra o link de instalação direta: https://raw.githubusercontent.com/marco-jardim/radar-niteroi-nowcast/main/radar-niteroi-nowcast.user.js — a extensão oferece a instalação.
3. Abra https://radar.niteroi.rj.gov.br/.

As atualizações são automáticas, via `@updateURL` do cabeçalho do script.

> A partir da v2.2.0 o script lê pluviômetros de outros sites. Na instalação ou na atualização, a extensão pede permissão para acessar esses hosts (`@connect`: `sirene.cbmerj.rj.gov.br`, `websempre.rio.rj.gov.br` e `services8.arcgis.com`). Aceite para ativar os pluviômetros.

> Se você usou a v1, substitua ou apague o script antigo para que os dois não rodem juntos.

## O que mostra

- **Chegada**: hora e "em N min".
- **Duração** da chuva.
- **Volume provável** e **máximo plausível** (mm).
- **Pico**: mm/h e classe.
- **Chance** de chuva.
- **Deslocamento**: velocidade e direção.
- **Tendência**.
- **Confiança**, com o acerto dos últimos 30 min.
- **Calibração**: fator aplicado à chuva do radar a partir dos pluviômetros (ex.: `radar ×1,3`) ou "neutra".
- **Gráfico** de 0–2 h.
- **Pluviômetros próximos**: os 3 mais próximos (até 15 km) com mm na última hora.
- **Trajetória** desenhada no mapa (marcas a cada 30 min até o horizonte) e **pluviômetros** de todo o estado (botão `📍 Pluviômetros`).

## Recursos

- Escolha do local clicando no mapa, por GPS, ou volta para Icaraí.
- Alertas do navegador, com antecedência e chance mínima configuráveis.
- Prefixo "(🌧 25min)" no título da aba.
- Painel arrastável e minimizável.
- Configurações persistentes: horizonte de 60–180 min e limiar de 15/20/25 dBZ.
- Atualização automática a cada minuto, baixando apenas imagens novas.
- API no console:
  - `RainPredictor.setTarget(lat, lon, "Nome")`
  - `RainPredictor.run(true)`
  - `RainPredictor.getLastResult()`
  - `RainPredictor.debug()`
  - `RainPredictor.selfTest()`
  - `RainPredictor.hindcast(30)`
  - `RainPredictor.gauges()`: pluviômetros normalizados, com `radar1h`
  - `RainPredictor.calibration()`: estado da calibração
  - `RainPredictor.gaugeStatus()`: situação de cada fonte

## Pluviômetros

Pluviômetros públicos em tempo real, em todo o estado do Rio de Janeiro, aparecem no mapa (círculos coloridos pela intensidade da última hora; passe o mouse para ver os detalhes), servem para calibrar a estimativa do radar e os mais próximos do ponto aparecem no painel.

Fontes (contagens aproximadas):

- Defesa Civil Niterói: 30
- Defesa Civil RJ: ~80
- CEMADEN: ~190
- Alerta Rio: 33
- INEA: quando estiver online (hoje as estações estão paradas ou offline e são descartadas)

Os dados vêm do serviço de mapa da Defesa Civil RJ (que espelha as redes de Niterói, do estado, do CEMADEN e do INEA) e do Alerta Rio. Como esses servidores não enviam CORS, a leitura passa pela extensão (`GM_xmlhttpRequest`, com `@connect` para os hosts acima). Se a fonte de Niterói falhar, o script usa o serviço ArcGIS da Prefeitura. Leituras com mais de 90 min, estações offline e coordenadas inválidas são descartadas; estações de fontes diferentes a menos de 150 m são unificadas. Atualização a cada 5 min, independente do radar.

Calibração:

- Compara a chuva do radar acumulada em 1 h sobre cada pluviômetro (taxa Marshall–Palmer, média 3×3 células) com o que o pluviômetro mediu.
- Viés médio do conjunto (soma do pluviômetro ÷ soma do radar, entre 0,25 e 4), suavizado em escala logarítmica e que volta a 1 com meia-vida de 60 min quando não há chuva para calibrar.
- Correção local no ponto: média ponderada pelo inverso do quadrado da distância dos pluviômetros a até 25 km, puxada para o viés médio quando há poucos.

O fator só escala mm/h, volume e pico; a chance de chuva não muda. Pluviômetros a até 3 km do ponto também geram avisos quando contradizem o radar (por exemplo, chuva medida com o radar sem eco).

Limitações:

- Os pluviômetros têm latência de 10–30 min.
- Os feeds não são documentados e podem mudar sem aviso.
- Servem para calibrar e confirmar, não para prever a hora de chegada da chuva.

## Como funciona

1. Descobre os ids de radar e produto e o mapa de cores pela API pública (`/radars`, `/radars/product-types`, `/radars/{id}/products`).
2. Converte cada PNG em uma grade de dBZ com ~0,86 km por célula (média em blocos no Z linear, georreferenciamento Web Mercator) e mascara ecos estáticos (clutter).
3. Estima o movimento por block matching exaustivo em grades suavizadas, nos últimos ~30 min (pares com 10 min de intervalo), combinados em uma superfície de custo normalizada com peso maior para os pares recentes. A incerteza vem da dispersão entre os pares.
4. Extrapola de forma semi-Lagrangiana até o ponto, de 5 a 120 min, com uma vizinhança cujo raio cresce com o tempo de antecedência. Resultam probabilidade, taxa média e percentil 90.
5. Converte Z = 200·R^1,6 (Marshall–Palmer) em mm/h. Classes: < 2,5 fraca; 2,5–10 moderada; 10–50 forte; ≥ 50 muito forte.
6. Faz um hindcast automático de 30 min (CSI da advecção contra a persistência). Se a extrapolação perde, a confiança cai e a incerteza aumenta.
7. Calibra as taxas com os pluviômetros: carrega até 20 quadros recentes, soma a chuva do radar em 1 h sobre cada pluviômetro e aplica um fator às taxas da previsão (veja "Pluviômetros").

## Limitações

- A extrapolação não prevê chuva que se forma ou se dissipa no próprio lugar (convecção no fim da tarde), e a qualidade cai após ~60 min.
- O produto MAXDISPLAY-ZV é um máximo de coluna: os mm são uma ordem de grandeza, não uma medida de pluviômetro.
- A precisão é limitada ao alcance de 100 km do radar.
- Os alertas só funcionam com a aba aberta.
- Depende da API não oficial do site, que pode mudar.

## Aviso

Projeto não oficial, sem vínculo com a Prefeitura de Niterói nem com a Defesa Civil. As estimativas são informativas e não substituem os avisos oficiais. Em emergências, ligue para a Defesa Civil: 199.

## Licença

[MIT](LICENSE)
