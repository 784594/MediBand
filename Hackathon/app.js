import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  onValue,
  push,
  query,
  ref,
  set
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const FIREBASE_CONFIG = window.MEDIBAND_FIREBASE_CONFIG;
const PATIENTS_PATH = "patients";
const TRIAGE_ORDER = ["Critical", "Urgent", "Observe", "Stable"];
const HANDHELD_STATUSES = new Set(["Critical", "Urgent"]);
const SYMPTOMS = ["Chest Pain", "Breathing Issues", "Dizziness", "Fever", "Fatigue"];

let database;
let patientsRef;
let lastKnownCriticalIds = new Set();

const byId = (id) => document.getElementById(id);
const currentView = document.body.dataset.view;

if (!FIREBASE_CONFIG) {
  renderConfigWarning();
} else {
  const app = initializeApp(FIREBASE_CONFIG);
  database = getDatabase(app);
  patientsRef = ref(database, PATIENTS_PATH);
  init();
}

function init() {
  if (currentView === "dashboard") {
    initDashboard();
    return;
  }

  if (currentView === "handheld") {
    initHandheld();
    return;
  }

  if (currentView === "kiosk") {
    initKiosk();
    return;
  }

  if (currentView === "reception") {
    initReception();
    return;
  }

  if (currentView === "patient-detail") {
    initPatientDetail();
  }
}

function initDashboard() {
  const searchInput = byId("searchInput");
  const tableBody = byId("patientTableBody");
  const totals = {
    total: byId("statTotal"),
    critical: byId("statCritical"),
    urgent: byId("statUrgent"),
    stable: byId("statStable")
  };

  let allPatients = [];

  onValue(patientsRef, (snapshot) => {
    allPatients = mapPatients(snapshot.val());
    const filteredPatients = filterPatients(allPatients, searchInput.value);
    renderDashboardRows(tableBody, filteredPatients);
    renderDashboardStats(totals, allPatients);
  });

  searchInput.addEventListener("input", () => {
    renderDashboardRows(tableBody, filterPatients(allPatients, searchInput.value));
  });
}

function initHandheld() {
  const countEl = byId("monitorCount");
  const listEl = byId("monitorList");
  const shell = byId("monitorShell");

  onValue(query(patientsRef), (snapshot) => {
    const allPatients = mapPatients(snapshot.val());
    const flaggedPatients = allPatients.filter((patient) => HANDHELD_STATUSES.has(patient.status));
    const currentCriticalIds = new Set(
      flaggedPatients.filter((patient) => patient.status === "Critical").map((patient) => patient.key)
    );

    renderMonitorList(listEl, flaggedPatients);
    countEl.textContent = String(flaggedPatients.length);

    if (hasNewCritical(currentCriticalIds)) {
      triggerCriticalAlert(shell);
    }

    lastKnownCriticalIds = currentCriticalIds;
  });
}

function initKiosk() {
  const form = byId("intakeForm");
  const symptomContainer = byId("symptomChecklist");
  const resultMessage = byId("resultMessage");

  symptomContainer.innerHTML = SYMPTOMS.map(
    (symptom) => `
      <label class="checkbox-row">
        <input type="checkbox" name="symptoms" value="${symptom}">
        <span>${symptom}</span>
      </label>
    `
  ).join("");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const name = String(formData.get("name") || "").trim();
    const patientId = String(formData.get("rfid") || "").trim();
    const symptoms = formData.getAll("symptoms");
    const bpm = Number(formData.get("bpm") || 0);
    const spo2 = Number(formData.get("spo2") || 0);
    const status = calculateTriage({ bpm, symptoms });
    const patientRecord = {
      name,
      patientId,
      bpm,
      spo2,
      status,
      riskLabel: getRiskLabel(status),
      symptoms,
      updatedAt: new Date().toISOString()
    };

    try {
      await push(patientsRef, patientRecord);
      resultMessage.textContent = `Patient ${patientId} submitted with ${status} triage.`;
      form.reset();
    } catch (error) {
      resultMessage.textContent = `Submission failed: ${error.message}`;
    }
  });
}

function initReception() {
  const queueEl = byId("receptionQueue");
  const updatedEl = byId("lastUpdated");
  const totals = {
    total: byId("receptionTotal"),
    critical: byId("receptionCritical"),
    urgent: byId("receptionUrgent"),
    stable: byId("receptionStable")
  };

  onValue(patientsRef, (snapshot) => {
    const patients = mapPatients(snapshot.val()).sort(sortPatients);
    renderReceptionQueue(queueEl, patients);
    renderDashboardStats(totals, patients);
    updatedEl.textContent = `Updated ${formatDateTime(new Date().toISOString())}`;
  });
}

function initPatientDetail() {
  const patientName = byId("detailPatientName");
  const patientSubline = byId("detailPatientSubline");
  const orbitValue = byId("detailBpmValue");
  const orbitStatus = byId("detailBpmStatus");
  const spo2Value = byId("detailSpo2Value");
  const riskValue = byId("detailRiskValue");
  const handheldValue = byId("detailHandheldValue");
  const updatedValue = byId("detailUpdatedValue");
  const symptomsValue = byId("detailSymptoms");
  const riskBanner = byId("detailRiskBanner");
  const riskSummary = byId("detailRiskSummary");
  const backLinks = document.querySelectorAll("[data-back-link]");
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get("id");
  const targetSource = params.get("source");

  if (targetSource) {
    backLinks.forEach((link) => {
      link.href = `${targetSource}.html`;
    });
  }

  if (!targetId) {
    patientName.textContent = "Patient not selected";
    patientSubline.textContent = "Return to the queue and open a patient record.";
    return;
  }

  onValue(patientsRef, (snapshot) => {
    const patients = mapPatients(snapshot.val());
    const patient = patients.find((entry) => entry.key === targetId);

    if (!patient) {
      patientName.textContent = "Patient record not found";
      patientSubline.textContent = `No record was found for id ${targetId}.`;
      return;
    }

    patientName.textContent = patient.name;
    patientSubline.textContent = `RFID ${patient.patientId} • ${patient.status} priority`;
    orbitValue.textContent = String(patient.bpm);
    orbitStatus.textContent = patient.status;
    spo2Value.textContent = `${patient.spo2}%`;
    riskValue.textContent = patient.riskLabel;
    handheldValue.textContent = HANDHELD_STATUSES.has(patient.status) ? "Shown on handheld" : "Desktop only";
    updatedValue.textContent = formatDateTime(patient.updatedAt);
    symptomsValue.innerHTML = renderSymptoms(patient.symptoms);
    riskSummary.textContent = buildRiskSummary(patient);
    riskBanner.className = `risk-banner ${patient.status.toLowerCase()}`;
  });
}

function renderDashboardRows(tableBody, patients) {
  if (!patients.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4">No patient records match the current filter.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = patients
    .sort(sortPatients)
    .map(
      (patient) => `
        <tr class="clickable-row" data-patient-key="${patient.key}">
          <td>
            <a class="patient-link" href="${buildPatientHref(patient.key, "dashboard")}">
              <div class="patient-name">${patient.name}</div>
              <div class="queue-id">RFID ${patient.patientId}</div>
            </a>
          </td>
          <td>${patient.bpm}</td>
          <td>${statusBadge(patient.status)}</td>
          <td>
            <div class="override-controls">
              <select data-patient-key="${patient.key}" class="override-select" aria-label="Manual Override">
                ${TRIAGE_ORDER.map(
                  (status) => `<option value="${status}" ${status === patient.status ? "selected" : ""}>${status}</option>`
                ).join("")}
              </select>
              <button type="button" class="button secondary override-button" data-patient-key="${patient.key}">
                Override
              </button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");

  tableBody.querySelectorAll(".override-button").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const { patientKey } = event.currentTarget.dataset;
      const selectedStatus = tableBody.querySelector(`.override-select[data-patient-key="${patientKey}"]`);
      const newStatus = selectedStatus?.value;
      if (!newStatus) {
        return;
      }
      const rowRef = ref(database, `${PATIENTS_PATH}/${patientKey}/status`);
      await set(rowRef, newStatus);
    });
  });

  tableBody.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => {
      window.location.href = buildPatientHref(row.dataset.patientKey, "dashboard");
    });
  });
}

function renderDashboardStats(targets, patients) {
  const total = patients.length;
  const critical = patients.filter((patient) => patient.status === "Critical").length;
  const urgent = patients.filter((patient) => patient.status === "Urgent").length;
  const stable = patients.filter((patient) => patient.status === "Stable").length;

  targets.total.textContent = String(total);
  targets.critical.textContent = String(critical);
  targets.urgent.textContent = String(urgent);
  targets.stable.textContent = String(stable);
}

function renderMonitorList(listEl, patients) {
  if (!patients.length) {
    listEl.innerHTML = `
      <div class="patient-card">
        <h3>No serious or high-priority cases in queue</h3>
        <p class="subtitle">The handheld monitor will automatically refresh when a critical or urgent patient arrives.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = patients
    .sort(sortPatients)
    .map(
      (patient) => `
        <article class="patient-card ${patient.status.toLowerCase()} clickable-row" data-patient-key="${patient.key}">
          <div class="monitor-header">
            <div>
              <p class="eyebrow">RFID ${patient.patientId}</p>
              <h3>${patient.status} Priority</h3>
            </div>
            ${statusBadge(patient.status)}
          </div>
          <p>BPM: <strong>${patient.bpm}</strong></p>
          <div class="patient-meta">
            <span>Symptoms: ${patient.symptoms.join(", ") || "None reported"}</span>
            <span>Updated: ${formatTime(patient.updatedAt)}</span>
          </div>
        </article>
      `
    )
    .join("");

  listEl.querySelectorAll(".clickable-row").forEach((card) => {
    card.addEventListener("click", () => {
      window.location.href = buildPatientHref(card.dataset.patientKey, "handheld");
    });
  });
}

function renderReceptionQueue(queueEl, patients) {
  if (!patients.length) {
    queueEl.innerHTML = `
      <div class="patient-card">
        <h3>No active patients</h3>
        <p class="subtitle">New kiosk intakes and live updates will appear here for reception staff.</p>
      </div>
    `;
    return;
  }

  queueEl.innerHTML = patients
    .map(
      (patient, index) => `
        <article class="queue-item" data-patient-key="${patient.key}">
          <div class="queue-rank">${index + 1}</div>
          <div class="queue-copy">
            <div class="patient-name">${patient.name}</div>
            <div class="queue-id">RFID ${patient.patientId}</div>
          </div>
          <div>${statusBadge(patient.status)}</div>
          <div class="queue-vitals">
            <div class="queue-bpm">${patient.bpm}</div>
            <div class="queue-id">BPM</div>
          </div>
        </article>
      `
    )
    .join("");

  queueEl.querySelectorAll(".queue-item").forEach((item) => {
    item.addEventListener("click", () => {
      window.location.href = buildPatientHref(item.dataset.patientKey, "index");
    });
  });
}

function renderConfigWarning() {
  document.body.innerHTML = `
    <main class="app-shell">
      <section class="card critical-shell">
        <p class="eyebrow">Configuration Required</p>
        <h1>Firebase settings missing</h1>
        <p class="subtitle">
          Create a local <code>config.js</code> from <code>config.example.js</code> and assign
          <code>window.MEDIBAND_FIREBASE_CONFIG</code> before loading <code>app.js</code>.
        </p>
      </section>
    </main>
  `;
}

function filterPatients(patients, searchTerm) {
  const normalized = (searchTerm || "").trim().toLowerCase();
  if (!normalized) {
    return patients;
  }

  return patients.filter((patient) => patient.patientId.toLowerCase().includes(normalized));
}

function mapPatients(rawPatients) {
  if (!rawPatients) {
    return [];
  }

  return Object.entries(rawPatients).map(([key, patient]) => ({
    key,
    name: String(patient.name || "").trim() || `Patient ${String(patient.patientId ?? key)}`,
    patientId: String(patient.patientId ?? key),
    bpm: Number(patient.bpm ?? 0),
    spo2: Number(patient.spo2 ?? deriveSpo2(patient.status)),
    status: patient.status ?? "Observe",
    riskLabel: patient.riskLabel ?? getRiskLabel(patient.status ?? "Observe"),
    symptoms: Array.isArray(patient.symptoms) ? patient.symptoms : [],
    updatedAt: patient.updatedAt ?? null
  }));
}

function calculateTriage({ bpm, symptoms }) {
  if (bpm > 110 || symptoms.includes("Chest Pain") || symptoms.includes("Breathing Issues")) {
    return "Critical";
  }

  if (bpm > 95 || symptoms.includes("Dizziness")) {
    return "Urgent";
  }

  if (symptoms.length > 0) {
    return "Observe";
  }

  return "Stable";
}

function sortPatients(a, b) {
  const severity = TRIAGE_ORDER.indexOf(a.status) - TRIAGE_ORDER.indexOf(b.status);
  if (severity !== 0) {
    return severity;
  }

  return a.patientId.localeCompare(b.patientId, undefined, { numeric: true });
}

function statusBadge(status) {
  const toneClass = `status-${status.toLowerCase()}`;
  return `
    <span class="status-badge ${toneClass}">
      <span class="pill"></span>
      ${status}
    </span>
  `;
}

function hasNewCritical(currentCriticalIds) {
  if (lastKnownCriticalIds.size === 0 && currentCriticalIds.size === 0) {
    return false;
  }

  for (const id of currentCriticalIds) {
    if (!lastKnownCriticalIds.has(id)) {
      return true;
    }
  }

  return false;
}

function triggerCriticalAlert(shell) {
  shell.classList.remove("critical-shell");
  void shell.offsetWidth;
  shell.classList.add("critical-shell");
  playAlertTone();
}

function playAlertTone() {
  const AudioContextRef = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextRef) {
    return;
  }

  const audioContext = new AudioContextRef();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
  gainNode.gain.setValueAtTime(0.001, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.32);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.32);
  oscillator.onended = () => audioContext.close();
}

function formatTime(isoString) {
  if (!isoString) {
    return "Pending";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

function formatDateTime(isoString) {
  if (!isoString) {
    return "Pending";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

function renderSymptoms(symptoms) {
  if (!symptoms.length) {
    return '<span class="symptom-chip">No symptoms reported</span>';
  }

  return symptoms.map((symptom) => `<span class="symptom-chip">${symptom}</span>`).join("");
}

function deriveSpo2(status) {
  if (status === "Critical") {
    return 88;
  }
  if (status === "Urgent") {
    return 93;
  }
  if (status === "Observe") {
    return 96;
  }
  return 99;
}

function getRiskLabel(status) {
  if (status === "Critical") {
    return "High Risk";
  }
  if (status === "Urgent") {
    return "Serious Risk";
  }
  if (status === "Observe") {
    return "Monitoring Required";
  }
  return "Low Risk";
}

function buildRiskSummary(patient) {
  if (patient.status === "Critical") {
    return `Immediate escalation recommended. BPM ${patient.bpm} and O2 ${patient.spo2}% indicate a high-acuity patient needing rapid intervention.`;
  }
  if (patient.status === "Urgent") {
    return "Serious monitoring recommended. This patient remains visible on the handheld feed because their vitals still warrant a quick-response team.";
  }
  if (patient.status === "Observe") {
    return "Patient is not in the handheld priority feed, but symptoms still justify observation and staff follow-up.";
  }
  return "Patient is currently stable and best suited for desktop-side monitoring with routine reassessment.";
}

function buildPatientHref(patientKey, source) {
  return `patient.html?id=${encodeURIComponent(patientKey)}&source=${encodeURIComponent(source)}`;
}

window.MediBand = {
  calculateTriage,
  pushPatient: (record) => push(patientsRef, record)
};
