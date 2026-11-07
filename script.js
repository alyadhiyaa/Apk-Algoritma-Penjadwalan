'use strict';

const STORAGE_KEY = 'cpu-scheduler-processes-v1';
const SAMPLE_PROCESSES = [
  { pid: 'P1', arrival: 0, burst: 7, priority: 2, order: 0 },
  { pid: 'P2', arrival: 2, burst: 4, priority: 1, order: 1 },
  { pid: 'P3', arrival: 4, burst: 1, priority: 3, order: 2 },
  { pid: 'P4', arrival: 5, burst: 4, priority: 2, order: 3 }
];
const PROCESS_COLORS = ['#3975d7', '#8060c9', '#159b83', '#d28a35', '#d45d78', '#537f9d', '#8c9b42', '#9a65a5'];
let processes = loadProcesses();
let editingPid = null;
let latestResults = { priority: null, srtf: null };
let toastTimer;

function loadProcesses() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(p => p && typeof p.pid === 'string' && Number.isInteger(p.arrival) && Number.isInteger(p.burst) && Number.isInteger(p.priority) && p.burst > 0)
      .map((p, index) => ({ ...p, order: Number.isInteger(p.order) ? p.order : index }));
  } catch (error) {
    console.warn('Data tersimpan tidak dapat dibaca:', error);
    return [];
  }
}
function persistProcesses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(processes));
}
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function formatNumber(value) {
  return Number(value).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function renderProcessRows(targetId, includeActions = false) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!processes.length) {
    target.innerHTML = `<tr><td class="empty-row" colspan="${includeActions ? 5 : 4}">Belum ada data proses. Tambahkan proses atau gunakan data contoh.</td></tr>`;
    return;
  }
  target.innerHTML = processes.map(process => `
    <tr>
      <td><span class="pid-pill">${escapeHTML(process.pid)}</span></td>
      <td>${process.arrival}</td><td>${process.burst}</td><td>${process.priority}</td>
      ${includeActions ? `<td><div class="row-actions"><button class="mini-action" data-edit="${escapeHTML(process.pid)}" title="Edit ${escapeHTML(process.pid)}" aria-label="Edit ${escapeHTML(process.pid)}"><i data-lucide="pencil"></i></button><button class="mini-action delete" data-delete="${escapeHTML(process.pid)}" title="Hapus ${escapeHTML(process.pid)}" aria-label="Hapus ${escapeHTML(process.pid)}"><i data-lucide="trash-2"></i></button></div></td>` : ''}
    </tr>`).join('');
  refreshIcons();
}
function renderProcessData() {
  renderProcessRows('process-table', true);
  renderProcessRows('dashboard-process-table');
  renderProcessRows('srtf-process-table');
  document.getElementById('stat-processes').textContent = processes.length;
  document.getElementById('process-count-label').textContent = `${processes.length} proses ditambahkan`;
}

function resetForm() {
  editingPid = null;
  document.getElementById('process-form').reset();
  document.getElementById('form-title').textContent = 'Tambah proses';
  document.getElementById('save-process').innerHTML = '<i data-lucide="plus"></i> Tambah proses';
  document.getElementById('cancel-edit').classList.add('hidden');
  refreshIcons();
}
function beginEdit(pid) {
  const process = processes.find(item => item.pid === pid);
  if (!process) return;
  editingPid = pid;
  document.getElementById('pid').value = process.pid;
  document.getElementById('arrival').value = process.arrival;
  document.getElementById('burst').value = process.burst;
  document.getElementById('priority-value').value = process.priority;
  document.getElementById('form-title').textContent = `Edit proses ${pid}`;
  document.getElementById('save-process').innerHTML = '<i data-lucide="save"></i> Simpan perubahan';
  document.getElementById('cancel-edit').classList.remove('hidden');
  refreshIcons();
  document.getElementById('pid').focus();
  document.getElementById('process-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function invalidateResults() {
  latestResults = { priority: null, srtf: null };
  document.getElementById('priority-results').innerHTML = emptyState('chart-no-axes-column-increasing', 'Hasil perlu dihitung ulang', 'Data proses berubah. Jalankan kembali simulasi Priority.');
  document.getElementById('srtf-results').innerHTML = emptyState('chart-gantt', 'Hasil perlu dihitung ulang', 'Data proses berubah. Jalankan kembali simulasi SRTF.');
  document.getElementById('comparison-results').innerHTML = emptyState('chart-no-axes-combined', 'Hasil perlu dihitung ulang', 'Jalankan kembali kedua algoritma untuk membandingkan hasil.');
}
function emptyState(icon, title, description) {
  return `<div class="empty-state"><i data-lucide="${icon}"></i><strong>${title}</strong><span>${description}</span></div>`;
}

// Priority Scheduling: non-preemptive; tie-breaker is arrival time, then input order.
function calculatePriority(input) {
  const pending = input.map(process => ({ ...process }));
  const completed = new Set();
  const metrics = {};
  const segments = [];
  let time = 0;
  let finished = 0;

  while (finished < pending.length) {
    const ready = pending
      .filter(process => !completed.has(process.pid) && process.arrival <= time)
      .sort((a, b) => a.priority - b.priority || a.arrival - b.arrival || a.order - b.order);

    if (ready.length === 0) {
      const nextArrival = Math.min(...pending.filter(p => !completed.has(p.pid)).map(p => p.arrival));
      if (nextArrival > time) addSegment(segments, 'IDLE', time, nextArrival);
      time = nextArrival;
      continue;
    }

    const chosen = ready[0];
    const start = time;
    const end = start + chosen.burst;
    addSegment(segments, chosen.pid, start, end);
    metrics[chosen.pid] = { firstStart: start, completion: end };
    completed.add(chosen.pid);
    finished += 1;
    time = end;
  }
  return buildResult(input, segments, metrics, 'Priority Scheduling');
}

// SRTF: preemptive simulation with integer time units and deterministic tie-breakers.
function calculateSRTF(input) {
  const remaining = new Map(input.map(process => [process.pid, process.burst]));
  const metrics = {};
  const segments = [];
  let time = 0;
  let finished = 0;

  while (finished < input.length) {
    const ready = input
      .filter(process => process.arrival <= time && remaining.get(process.pid) > 0)
      .sort((a, b) => remaining.get(a.pid) - remaining.get(b.pid) || a.arrival - b.arrival || a.order - b.order);

    if (ready.length === 0) {
      const futureArrivals = input.filter(process => remaining.get(process.pid) > 0 && process.arrival > time).map(process => process.arrival);
      const nextArrival = Math.min(...futureArrivals);
      addSegment(segments, 'IDLE', time, nextArrival);
      time = nextArrival;
      continue;
    }

    const chosen = ready[0];
    if (!metrics[chosen.pid]) metrics[chosen.pid] = { firstStart: time, completion: null };
    addSegment(segments, chosen.pid, time, time + 1);
    remaining.set(chosen.pid, remaining.get(chosen.pid) - 1);
    time += 1;
    if (remaining.get(chosen.pid) === 0) {
      metrics[chosen.pid].completion = time;
      finished += 1;
    }
  }
  return buildResult(input, segments, metrics, 'Shortest Remaining Time First');
}

function addSegment(segments, pid, start, end) {
  if (end <= start) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.pid === pid && previous.end === start) previous.end = end;
  else segments.push({ pid, start, end });
}
function buildResult(input, segments, rawMetrics, name) {
  const rows = input.map(process => {
    const data = rawMetrics[process.pid];
    const completion = data.completion;
    const turnaround = completion - process.arrival;
    const waiting = turnaround - process.burst;
    const response = data.firstStart - process.arrival;
    return { ...process, completion, turnaround, waiting, response, firstStart: data.firstStart };
  });
  const average = key => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const makespan = segments.length ? segments[segments.length - 1].end : 0;
  const busyTime = input.reduce((sum, process) => sum + process.burst, 0);
  const idleTime = segments.filter(segment => segment.pid === 'IDLE').reduce((sum, segment) => sum + segment.end - segment.start, 0);
  return {
    name, rows, segments,
    averageTurnaround: average('turnaround'),
    averageWaiting: average('waiting'),
    averageResponse: average('response'),
    makespan, busyTime, idleTime,
    sequence: segments.filter((segment, index) => segment.pid !== 'IDLE' && (index === 0 || segments[index - 1].pid !== segment.pid)).map(segment => segment.pid)
  };
}

function renderMetrics(result) {
  return `<div class="metric-grid">
    <div class="metric-card"><span>Rata-rata Turnaround Time</span><strong>${formatNumber(result.averageTurnaround)}</strong><small>Rata-rata TAT</small></div>
    <div class="metric-card"><span>Rata-rata Waiting Time</span><strong>${formatNumber(result.averageWaiting)}</strong><small>Rata-rata WT</small></div>
    <div class="metric-card"><span>Rata-rata Response Time</span><strong>${formatNumber(result.averageResponse)}</strong><small>Rata-rata RT</small></div>
    <div class="metric-card"><span>Total waktu (makespan)</span><strong>${formatNumber(result.makespan)}</strong><small>Unit waktu dari titik 0</small></div>
  </div>`;
}
function renderResultTable(result) {
  const rows = result.rows.map(row => `<tr><td><span class="pid-pill">${escapeHTML(row.pid)}</span></td><td class="number-cell">${row.arrival}</td><td class="number-cell">${row.burst}</td><td class="number-cell">${row.priority}</td><td class="number-cell">${row.completion}</td><td class="number-cell">${row.turnaround}</td><td class="number-cell">${row.waiting}</td><td class="number-cell">${row.response}</td></tr>`).join('');
  return `<div class="result-panel"><div class="result-panel-heading"><h3>Tabel hasil perhitungan</h3><p>Seluruh nilai waktu ditampilkan dalam satuan waktu yang sama dengan input.</p></div><div class="table-wrap"><table class="result-table"><thead><tr><th>PID</th><th>AT</th><th>BT</th><th>Priority</th><th>CT</th><th>TAT</th><th>WT</th><th>RT</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function colorForPid(pid, processList = processes) {
  const index = processList.findIndex(process => process.pid === pid);
  return PROCESS_COLORS[(index < 0 ? 0 : index) % PROCESS_COLORS.length];
}
function renderGantt(result) {
  const segments = result.segments;
  const blocks = segments.map(segment => {
    const duration = segment.end - segment.start;
    const idle = segment.pid === 'IDLE';
    const color = idle ? '#9aa4b2' : colorForPid(segment.pid);
    return `<div class="gantt-segment ${idle ? 'idle-segment' : ''}" style="--duration:${duration};background:${color}" title="${escapeHTML(segment.pid)}: ${segment.start}–${segment.end}"><strong>${escapeHTML(segment.pid)}</strong><small>${duration} unit</small></div>`;
  }).join('');
  const times = segments.map(segment => `<span class="gantt-time" style="--duration:${segment.end - segment.start}">${segment.start}–${segment.end}</span>`).join('');
  return `<div class="result-panel"><div class="result-panel-heading"><h3>Gantt Chart</h3><p>Urutan dan durasi eksekusi CPU${result.name.includes('SRTF') ? ', termasuk setiap segmen preemption' : ''}.</p></div><div class="gantt-content"><div class="table-wrap"><div class="gantt-track">${blocks}</div><div class="gantt-times">${times}</div></div><p class="gantt-note">CPU Idle menunjukkan rentang waktu ketika belum ada proses yang siap dieksekusi.</p></div></div>`;
}
function renderResult(result, targetId) {
  const target = document.getElementById(targetId);
  target.innerHTML = `${renderMetrics(result)}${renderGantt(result)}${renderResultTable(result)}<div class="result-panel"><div class="result-panel-heading"><h3>Ringkasan eksekusi</h3></div><div class="sequence-line"><strong>Urutan proses:</strong> ${result.sequence.map(escapeHTML).join(' → ')}<br><strong>Total CPU busy time:</strong> ${result.busyTime} unit &nbsp;·&nbsp; <strong>CPU idle:</strong> ${result.idleTime} unit</div></div>`;
  refreshIcons();
}
function requireProcesses() {
  if (!processes.length) {
    showToast('Tambahkan minimal satu proses terlebih dahulu.');
    return false;
  }
  return true;
}
function runPriority() {
  if (!requireProcesses()) return;
  latestResults.priority = calculatePriority(processes);
  renderResult(latestResults.priority, 'priority-results');
  showToast('Perhitungan Priority berhasil.');
}
function runSRTF() {
  if (!requireProcesses()) return;
  latestResults.srtf = calculateSRTF(processes);
  renderResult(latestResults.srtf, 'srtf-results');
  showToast('Perhitungan SRTF berhasil.');
}
function renderComparison() {
  const target = document.getElementById('comparison-results');
  if (!requireProcesses()) return;
  const priority = latestResults.priority || calculatePriority(processes);
  const srtf = latestResults.srtf || calculateSRTF(processes);
  latestResults = { priority, srtf };
  const metrics = [
    ['Rata-rata Waiting Time', 'averageWaiting'],
    ['Rata-rata Turnaround Time', 'averageTurnaround'],
    ['Rata-rata Response Time', 'averageResponse']
  ];
  const tableRows = metrics.map(([label, key]) => `<tr><td>${label}</td><td>${formatNumber(priority[key])}</td><td>${formatNumber(srtf[key])}</td><td><strong>${Math.abs(priority[key] - srtf[key]) < 0.000001 ? 'Sama' : (priority[key] < srtf[key] ? 'Priority' : 'SRTF')}</strong></td></tr>`).join('');
  const maxValue = Math.max(...metrics.flatMap(([, key]) => [priority[key], srtf[key]]), 1);
  const bars = metrics.map(([label, key]) => `<div class="bar-group"><div><span>${label}</span><strong>${formatNumber(priority[key])} / ${formatNumber(srtf[key])}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${priority[key] / maxValue * 100}%;background:#3975d7"></div></div><div class="bar-track"><div class="bar-fill" style="width:${srtf[key] / maxValue * 100}%;background:#8060c9"></div></div></div>`).join('');
  target.innerHTML = `<div class="comparison-grid"><article class="comparison-card"><h3>Priority Scheduling</h3>${renderMiniMetrics(priority)}</article><article class="comparison-card"><h3>SRTF Scheduling</h3>${renderMiniMetrics(srtf)}</article></div>
    <div class="result-panel"><div class="result-panel-heading"><h3>Tabel perbandingan metrik</h3><p>Nilai yang lebih kecil menunjukkan waktu rata-rata yang lebih rendah untuk metrik terkait.</p></div><div class="table-wrap"><table class="comparison-table"><thead><tr><th>Metrik</th><th>Priority</th><th>SRTF</th><th>Nilai lebih kecil</th></tr></thead><tbody>${tableRows}</tbody></table></div></div>
    <div class="result-panel" style="margin-top:14px"><div class="result-panel-heading"><h3>Grafik perbandingan rata-rata</h3><p>Panjang batang menunjukkan besar nilai. Biru = Priority, ungu = SRTF.</p></div><div class="bar-chart">${bars}<div class="chart-legend"><span><i style="background:#3975d7"></i>Priority Scheduling</span><span><i style="background:#8060c9"></i>SRTF</span></div></div></div>
    <div class="comparison-grid" style="margin-top:14px"><article class="result-panel"><div class="result-panel-heading"><h3>Urutan Priority</h3></div><div class="sequence-line">${priority.sequence.map(escapeHTML).join(' → ')}</div></article><article class="result-panel"><div class="result-panel-heading"><h3>Urutan SRTF</h3></div><div class="sequence-line">${srtf.sequence.map(escapeHTML).join(' → ')}</div></article></div>`;
}
function renderMiniMetrics(result) {
  return `<div class="mini-metrics"><p>Avg. Waiting Time <strong>${formatNumber(result.averageWaiting)}</strong></p><p>Avg. Turnaround Time <strong>${formatNumber(result.averageTurnaround)}</strong></p><p>Avg. Response Time <strong>${formatNumber(result.averageResponse)}</strong></p></div>`;
}

function navigate(page) {
  const validPages = ['dashboard', 'priority', 'srtf', 'comparison', 'guide'];
  if (!validPages.includes(page)) return;
  document.querySelectorAll('.page').forEach(section => section.classList.toggle('active', section.id === `page-${page}`));
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.page === page));
  const activeLink = document.querySelector(`.nav-link[data-page="${page}"] span`);
  document.getElementById('breadcrumb-current').textContent = activeLink ? activeLink.textContent : 'Dashboard';
  document.getElementById('sidebar').classList.remove('open');
  if (page === 'comparison' && processes.length) renderComparison();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function attachEvents() {
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    navigate(button.dataset.page);
  }));
  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
  document.getElementById('menu-toggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

  document.getElementById('process-form').addEventListener('submit', event => {
    event.preventDefault();
    const pid = document.getElementById('pid').value.trim();
    const arrival = Number(document.getElementById('arrival').value);
    const burst = Number(document.getElementById('burst').value);
    const priority = Number(document.getElementById('priority-value').value);
    if (!pid || !Number.isInteger(arrival) || arrival < 0 || !Number.isInteger(burst) || burst <= 0 || !Number.isInteger(priority) || priority < 0) {
      showToast('Periksa kembali input. Gunakan angka bulat dan nilai sesuai ketentuan.');
      return;
    }
    const duplicate = processes.some(process => process.pid.toLowerCase() === pid.toLowerCase() && process.pid !== editingPid);
    if (duplicate) {
      showToast('Process ID sudah digunakan. Masukkan PID yang berbeda.');
      document.getElementById('pid').focus();
      return;
    }
    if (editingPid) {
      const old = processes.find(process => process.pid === editingPid);
      processes = processes.map(process => process.pid === editingPid ? { pid, arrival, burst, priority, order: old.order } : process);
      showToast(`Data ${pid} berhasil diperbarui.`);
    } else {
      const nextOrder = processes.reduce((max, process) => Math.max(max, process.order), -1) + 1;
      processes.push({ pid, arrival, burst, priority, order: nextOrder });
      showToast(`Proses ${pid} berhasil ditambahkan.`);
    }
    persistProcesses();
    renderProcessData();
    invalidateResults();
    resetForm();
  });

  document.getElementById('process-table').addEventListener('click', event => {
    const editButton = event.target.closest('[data-edit]');
    const deleteButton = event.target.closest('[data-delete]');
    if (editButton) beginEdit(editButton.dataset.edit);
    if (deleteButton) {
      const pid = deleteButton.dataset.delete;
      processes = processes.filter(process => process.pid !== pid);
      persistProcesses();
      renderProcessData();
      invalidateResults();
      if (editingPid === pid) resetForm();
      showToast(`Proses ${pid} telah dihapus.`);
    }
  });
  document.getElementById('cancel-edit').addEventListener('click', resetForm);
  document.getElementById('load-sample').addEventListener('click', () => {
    processes = SAMPLE_PROCESSES.map(process => ({ ...process }));
    persistProcesses(); renderProcessData(); invalidateResults(); resetForm();
    showToast('Data contoh berhasil dimuat.');
  });
  document.getElementById('clear-processes').addEventListener('click', () => {
    if (!processes.length) { showToast('Belum ada data untuk dihapus.'); return; }
    if (!window.confirm('Hapus seluruh data proses?')) return;
    processes = []; persistProcesses(); renderProcessData(); invalidateResults(); resetForm();
    showToast('Seluruh data proses telah dihapus.');
  });
  document.getElementById('run-priority').addEventListener('click', runPriority);
  document.getElementById('run-srtf').addEventListener('click', runSRTF);
  document.getElementById('run-comparison').addEventListener('click', renderComparison);
}

document.addEventListener('DOMContentLoaded', () => {
  renderProcessData();
  attachEvents();
  refreshIcons();
});