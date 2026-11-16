# markdown-turbo

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/banglento/markdown-turbo/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/banglento/markdown-turbo/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown parser in a single ES module. Its
`parse(markdown)` returns output byte-identical to marked 18.1.3 with
default options, while rendering considerably faster thanks to an
offset-based block scanner and a single-pass inline renderer — no
imports, no dependencies, no cross-call state.

Competition: https://make.fun/bounty/markdown-render-speed-02

## Usage

```js
import { parse } from './parse.js';
const html = parse('# Hello\n\nSome *markdown*.');
```
