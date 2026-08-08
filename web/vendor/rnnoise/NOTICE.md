# RNNoise

Подавление шума нейросетью. Здесь лежит уже собранная сборка, потому что у
проекта нет шага сборки: фронтенд — обычные ES-модули, которые сервер отдаёт
как есть.

| Что | Откуда | Лицензия |
|---|---|---|
| `rnnoise.wasm`, `rnnoise_simd.wasm`, `workletProcessor.js`, `index.js` | [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) 0.3.5 | MIT (обёртка) |
| сам алгоритм | [xiph/rnnoise](https://github.com/xiph/rnnoise) | BSD-3-Clause (Xiph.Org) |

Обновить:

```sh
npm pack @sapphi-red/web-noise-suppressor@<версия>
tar xzf sapphi-red-web-noise-suppressor-*.tgz
cp package/dist/index.js               web/vendor/rnnoise/index.js
cp package/dist/rnnoise/workletProcessor.js web/vendor/rnnoise/
cp package/dist/rnnoise*.wasm          web/vendor/rnnoise/
```

Работает на 48 кГц — контекст для микрофона создаётся именно с такой частотой.
