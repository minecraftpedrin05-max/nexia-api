const crypto = require("crypto");
const { readData, writeData } = require("./database");

const DAILY_LIMIT_MS = 5 * 60 * 60 * 1000; // 5 horas de geração por dia, por chave

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function generateKey(label) {
  const key = "nexia-" + crypto.randomBytes(20).toString("hex");
  const data = readData();
  data.keys[key] = {
    label: label || "",
    createdAt: new Date().toISOString(),
    usedMsToday: 0,
    lastResetDay: todayStr(),
    totalUsedMs: 0,
    totalRequests: 0,
  };
  writeData(data);
  return key;
}

function getKeyRecord(key) {
  const data = readData();
  const rec = data.keys[key];
  if (!rec) return null;
  // reseta o contador diário se virou o dia
  const today = todayStr();
  if (rec.lastResetDay !== today) {
    rec.lastResetDay = today;
    rec.usedMsToday = 0;
    writeData(data);
  }
  return rec;
}

function remainingMs(key) {
  const rec = getKeyRecord(key);
  if (!rec) return 0;
  return Math.max(0, DAILY_LIMIT_MS - rec.usedMsToday);
}

function registerUsage(key, ms) {
  const data = readData();
  const rec = data.keys[key];
  if (!rec) return;
  const today = todayStr();
  if (rec.lastResetDay !== today) {
    rec.lastResetDay = today;
    rec.usedMsToday = 0;
  }
  rec.usedMsToday += ms;
  rec.totalUsedMs = (rec.totalUsedMs || 0) + ms;
  rec.totalRequests = (rec.totalRequests || 0) + 1;
  writeData(data);
}

function listKeys() {
  const data = readData();
  return Object.entries(data.keys).map(([key, rec]) => ({ key, ...rec }));
}

function revokeKey(key) {
  const data = readData();
  if (!data.keys[key]) return false;
  delete data.keys[key];
  writeData(data);
  return true;
}

module.exports = { DAILY_LIMIT_MS, generateKey, getKeyRecord, remainingMs, registerUsage, listKeys, revokeKey };
