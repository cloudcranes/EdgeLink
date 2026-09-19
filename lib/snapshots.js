// 部署前配置快照：保存 / 列表 / 加载。
// 依赖：node:fs、node:path、./constants（SNAPSHOT_LIMIT）、./config（CONFIG_PATH）。
// 单进程模块级单例：SNAPSHOT_DIR 跟随 config.json 所在目录的 snapshots 子目录，
// 便于 Docker /app/data 卷持久化（与 config 同生共死）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SNAPSHOT_LIMIT } = require('./constants');
const { CONFIG_PATH } = require('./config');

const SNAPSHOT_DIR = path.join(path.dirname(CONFIG_PATH), 'snapshots');

function saveSnapshot(config, label) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
    // 秒级时间戳 + 3 字节随机后缀：避免同秒连续两次保存互相覆盖（保留 snapshot-*.json 兼容）
    const rand = crypto.randomBytes(3).toString('hex');
    const file = path.join(SNAPSHOT_DIR, `snapshot-${timestamp}-${rand}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, time: new Date().toISOString(), config }, null, 2), 'utf8');
    // 保留最近 N 份
    const snaps = fs.readdirSync(SNAPSHOT_DIR).filter((n) => n.startsWith('snapshot-')).sort();
    while (snaps.length > SNAPSHOT_LIMIT) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, snaps.shift()));
    }
    return file;
  } catch (error) {
    console.error(`快照保存失败: ${error.message}`);
    return null;
  }
}

function listSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      return [];
    }
    return fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((n) => n.startsWith('snapshot-') && n.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, name), 'utf8'));
          return {
            file: name,
            label: data.label || '部署前快照',
            time: data.time || name,
            apps: (data.config?.apps || []).length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadSnapshot(file) {
  const safeName = String(file || '');
  if (!safeName || !safeName.startsWith('snapshot-') || !safeName.endsWith('.json') || safeName.includes('..')) {
    throw new Error('无效的快照文件');
  }
  const full = path.join(SNAPSHOT_DIR, safeName);
  if (!fs.existsSync(full)) {
    throw new Error(`快照不存在: ${safeName}`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

module.exports = {
  SNAPSHOT_DIR,
  saveSnapshot,
  listSnapshots,
  loadSnapshot,
};
