// EdgeLink UI 概念预览 demo 服务（独立端口，不打扰主面板 8787）
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 8790;

app.use(express.static(path.join(__dirname, 'demo')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd')));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EdgeLink UI demo on http://127.0.0.1:${PORT}`);
  });
}
