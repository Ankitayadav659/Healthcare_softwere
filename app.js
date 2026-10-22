const today = new Date();
const dateKey = (date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const todayKey = dateKey(today);
const money = (amount) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(amount) || 0);
const formatDate = (value) => value ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`)) : "—";
const initials = (name) => name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function defaultClinic() {
  return {
    name: "Dr. Pallavi Chogale Physiotherapy Clinic",
    brandName: "Pallavi Physio",
    doctor: "Dr. Pallavi Chogale",
    providerTitle: "Physiotherapist",
    specialty: "Physiotherapy",
    serviceLabel: "Session",
    serviceLabelPlural: "Sessions",
    serviceDescription: "Physiotherapy session",
    brandColor: "purple",
    address: "",
    phone: "",
    email: "",
    gstin: "",
  };
}

let state = { patients: [], visits: [], clinic: defaultClinic() };
let activeView = "dashboard";
let patientQuery = "";
let selectedCalendarDate = todayKey;
let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
let selectedPatientId = "";
let invoiceVisitId = "";
let invoicePaymentId = "";
let csrfToken = "";
let stateRevision = 0;
let persistenceQueue = Promise.resolve();
let idleLockTimer;
let authSetupMode = false;

async function apiRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Server request failed (${response.status}).`);
  return { response, result };
}

function showAuthDialog(setup, username = "") {
  authSetupMode = setup;
  const form = document.getElementById("auth-form");
  form.reset();
  form.elements.username.value = username;
  form.elements.confirmPassword.required = setup;
  document.getElementById("password-confirm-field").hidden = !setup;
  form.elements.password.autocomplete = setup ? "new-password" : "current-password";
  document.getElementById("auth-title").textContent = setup ? "Secure clinic setup" : "Sign in to your clinic";
  document.getElementById("auth-description").textContent = setup
    ? "Create the clinic owner account. The password cannot be recovered if lost."
    : "Enter your clinic account details to unlock patient and payment records.";
  document.getElementById("password-help").textContent = setup
    ? "Use a unique passphrase with at least 14 characters."
    : "Your account is protected by the clinic computer's Windows user profile.";
  document.getElementById("auth-submit").textContent = setup ? "Create protected database" : "Unlock clinic records";
  document.getElementById("auth-error").textContent = "";
  const submit = document.getElementById("auth-submit");
  submit.disabled = false;
  const dialog = document.getElementById("auth-dialog");
  if (!dialog.open) dialog.showModal();
}

async function loadState() {
  try {
    const { result: session } = await apiRequest("/api/session");
    if (!session.configured || !session.authenticated) {
      showAuthDialog(!session.configured, session.username);
      return;
    }
    csrfToken = session.csrf;
    const { result: saved } = await apiRequest("/api/state");
    state = saved.state;
    stateRevision = saved.revision;
    document.getElementById("auth-dialog").close();
    document.getElementById("lock-app").hidden = false;
    render();
    startIdleLock();
  } catch (error) {
    console.error("Clinic backend could not be reached.", error);
    showAuthDialog(false);
    document.getElementById("auth-title").textContent = "Clinic server unavailable";
    document.getElementById("auth-description").textContent = "Start the clinic backend using Start Clinic.bat, then reload this page. No browser-only fallback is used.";
    document.getElementById("auth-submit").disabled = true;
    document.getElementById("auth-error").textContent = error.message;
  }
}

function saveState() {
  const snapshot = JSON.stringify(state);
  const operation = persistenceQueue.then(async () => {
    const { result } = await apiRequest("/api/state", {
      method: "PUT",
      body: JSON.stringify({ revision: stateRevision, state: JSON.parse(snapshot) }),
    });
    stateRevision = result.revision;
    if (result.warning) showToast(result.warning, true);
    return true;
  });
  persistenceQueue = operation.catch((error) => {
    console.error("Clinic data could not be saved.", error);
    showToast(error.message || "Clinic records could not be saved. Check the backend before continuing.", true);
    return false;
  });
  return persistenceQueue;
}

function startIdleLock() {
  window.clearTimeout(idleLockTimer);
  idleLockTimer = window.setTimeout(lockApp, 15 * 60 * 1000);
}

async function lockApp() {
  if (!csrfToken) return;
  try {
    await apiRequest("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    console.error("Clinic sign-out could not be confirmed.", error);
  }
  window.clearTimeout(idleLockTimer);
  state = { patients: [], visits: [], clinic: {} };
  csrfToken = "";
  stateRevision = 0;
  document.querySelectorAll("dialog:not(#auth-dialog)").forEach((dialog) => dialog.close());
  document.querySelectorAll("dialog:not(#auth-dialog) form").forEach((form) => form.reset());
  document.getElementById("page-content").replaceChildren();
  document.getElementById("invoice-content").replaceChildren();
  document.getElementById("lock-app").hidden = true;
  showAuthDialog(false);
}

async function downloadEncryptedBackup() {
  try {
    const { response } = await apiRequest("/api/backup", { method: "GET", headers: { "X-CSRF-Token": csrfToken } });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pallavi-physio-encrypted-backup-${todayKey}.db`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("Encrypted Windows-account backup downloaded. Keep it somewhere private.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function showToast(message, isError = false) {
  const region = document.getElementById("toast-region");
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " error" : ""}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4000);
}

function patientFor(visit) {
  return state.patients.find((patient) => patient.id === visit.patientId);
}

function clinicSettings() {
  return { ...defaultClinic(), ...(state.clinic || {}) };
}

function serviceLabel(plural = false) {
  const clinic = clinicSettings();
  return plural ? clinic.serviceLabelPlural : clinic.serviceLabel;
}

function attendedVisits(patientId) {
  return state.visits.filter((visit) => visit.patientId === patientId && ["Arrived", "Completed"].includes(visit.status));
}

function paymentState(visit) {
  const paid = Number(visit.amountPaid ?? (visit.payment === "paid" ? visit.fee : 0));
  if (paid >= Number(visit.fee)) return "Paid";
  if (paid > 0) return "Part paid";
  return "Pending";
}

function balanceFor(visit) {
  return Math.max(0, Number(visit.fee) - Number(visit.amountPaid ?? (visit.payment === "paid" ? visit.fee : 0)));
}

function makeInvoiceNumber() {
  const stamp = todayKey.replace(/-/g, "");
  const count = state.visits.reduce((sum, visit) => sum + (visit.payments || []).length, 0) + 1;
  const prefix = clinicSettings().brandName.split(/\s+/).map((part) => part[0]).join("").slice(0, 6).toUpperCase() || "CLINIC";
  return `${prefix}-${stamp}-${String(count).padStart(3, "0")}`;
}

function shareOnWhatsApp(phone, message) {
  const enteredDigits = String(phone || "").replace(/\D/g, "");
  if (enteredDigits.length < 10) {
    showToast("Add a valid WhatsApp number with country code to this patient's record first.", true);
    return;
  }
  const digits = enteredDigits.length === 10 ? `91${enteredDigits}` : enteredDigits;
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function tomorrowKey() {
  return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
}

function avatar(name, index = 0) {
  return `<span class="mini-avatar${index % 3 ? ` color-${index % 3}` : ""}">${escapeHtml(initials(name))}</span>`;
}

function patientCell(patient, index = 0) {
  return `<button class="patient-open" type="button" data-action="patient-detail" data-id="${escapeHtml(patient.id)}"><span class="patient-cell">${avatar(patient.name, index)}<span>${escapeHtml(patient.name)}<small class="patient-meta">${escapeHtml(patient.id.toUpperCase())} · ${attendedVisits(patient.id).length} ${escapeHtml(serviceLabel(true).toLowerCase())}</small></span></span></button>`;
}

function statusBadge(status) {
  const css = status.toLowerCase().replace(/\s+/g, "-");
  return `<span class="status status-${escapeHtml(css)}">${escapeHtml(status)}</span>`;
}

function visitsForToday() {
  return state.visits.filter((visit) => visit.date === todayKey);
}

function renderDashboard() {
  const clinic = clinicSettings();
  const todaysVisits = visitsForToday();
  const collected = todaysVisits.reduce((sum, visit) => sum + Number(visit.amountPaid || 0), 0);
  const outstanding = todaysVisits.reduce((sum, visit) => sum + balanceFor(visit), 0);
  const tomorrowVisits = state.visits.filter((visit) => visit.date === tomorrowKey());
  const appointmentRows = todaysVisits.slice().sort((a, b) => a.time.localeCompare(b.time)).slice(0, 5);
  const hour = today.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `
    <div class="page-heading"><div><h1>${greeting}, ${escapeHtml(clinic.doctor)} <span aria-hidden="true">✳</span></h1><p>Your ${escapeHtml(clinic.specialty.toLowerCase())} clinic schedule and collections at a glance.</p></div><div class="heading-actions"><button class="button button-quiet" data-action="new-patient">＋ Add patient</button><button class="button button-primary" data-action="new-visit">＋ Book ${escapeHtml(serviceLabel())}</button></div></div>
    <div class="stats-grid">
      <article class="stat-card"><div class="stat-top">Today's appointments <span class="stat-icon">♧</span></div><div class="stat-value">${todaysVisits.length}</div><div class="stat-foot"><span class="positive">${todaysVisits.filter((visit) => ["Arrived", "Completed"].includes(visit.status)).length} arrived</span> · ${todaysVisits.filter((visit) => visit.status === "No-show").length} no-show</div></article>
      <article class="stat-card"><div class="stat-top">Tomorrow's schedule <span class="stat-icon">▦</span></div><div class="stat-value">${tomorrowVisits.length}</div><div class="stat-foot">${tomorrowVisits.filter((visit) => visit.status === "Scheduled").length} patients expected</div></article>
      <article class="stat-card"><div class="stat-top">Collected today <span class="stat-icon">₹</span></div><div class="stat-value">${money(collected)}</div><div class="stat-foot">Session income</div></article>
      <article class="stat-card"><div class="stat-top">Pending balance <span class="stat-icon">◷</span></div><div class="stat-value">${money(outstanding)}</div><div class="stat-foot">${todaysVisits.filter((visit) => balanceFor(visit) > 0).length} payment${todaysVisits.filter((visit) => balanceFor(visit) > 0).length === 1 ? "" : "s"} due today</div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-heading"><div><h2>Today's ${escapeHtml(clinic.specialty.toLowerCase())} ${escapeHtml(serviceLabel(true).toLowerCase())}</h2><p>Mark arrivals, complete visits and follow up on missed appointments</p></div><span class="date-pill">${formatDate(todayKey)}</span></div>
        ${appointmentRows.length ? `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Time</th><th>Department</th><th>Fee</th><th>Status</th></tr></thead><tbody>${appointmentRows.map((visit, index) => { const patient = patientFor(visit); return patient ? `<tr><td>${patientCell(patient, index)}</td><td>${escapeHtml(visit.time)}</td><td>${escapeHtml(visit.department)}</td><td>${money(visit.fee)}</td><td>${statusBadge(visit.status)}</td></tr>` : ""; }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No ${escapeHtml(serviceLabel(true).toLowerCase())} scheduled</strong>Start by creating a new ${escapeHtml(serviceLabel().toLowerCase())}.</div>`}
      </section>
      <section class="panel"><div class="panel-heading"><div><h2>Queue overview</h2><p>Patients currently scheduled today</p></div><button class="panel-link" data-view="visits">View queue →</button></div>
        <div class="queue-list">${appointmentRows.slice(0, 4).map((visit, index) => { const patient = patientFor(visit); return patient ? `<div class="queue-row">${avatar(patient.name, index)}<div class="queue-info"><strong>${escapeHtml(patient.name)}</strong><small>${escapeHtml(visit.department)}</small></div><span class="queue-token">${escapeHtml(visit.time)}</span></div>` : ""; }).join("") || `<div class="empty-state">The queue is clear for now.</div>`}</div>
      </section>
    </div>
    <section class="panel"><div class="panel-heading"><div><h2>Quick actions</h2><p>Common tasks to keep your clinic moving</p></div></div><div class="quick-actions">
      <button class="quick-action" data-action="new-patient"><span>＋</span><span>Register patient<small>Create a patient profile</small></span></button>
      <button class="quick-action" data-action="new-visit"><span>◷</span><span>Book a ${escapeHtml(serviceLabel().toLowerCase())}<small>Add an appointment</small></span></button>
      <button class="quick-action" data-view="billing"><span>₹</span><span>Payments & invoices<small>Review pending balances</small></span></button>
    </div></section>`;
}

function renderPatients() {
  const patients = state.patients.filter((patient) => `${patient.name} ${patient.phone} ${patient.id}`.toLowerCase().includes(patientQuery.toLowerCase()));
  return `<div class="page-heading"><div><h1>Patients</h1><p>Patient directory and contact details.</p></div><div class="heading-actions"><button class="button button-primary" data-action="new-patient">＋ Add patient</button></div></div>
    <section class="panel"><div class="toolbar"><label class="search-box"><span>⌕</span><input id="patient-search" type="search" placeholder="Search by name, ID or phone" value="${escapeHtml(patientQuery)}"></label><select class="filter-select" id="gender-filter" aria-label="Filter by gender"><option value="">All genders</option>${["Female", "Male", "Non-binary", "Other"].map((gender) => `<option>${gender}</option>`).join("")}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Phone</th><th>Date of birth</th><th>Gender</th><th>Visits</th><th>Registered</th><th></th></tr></thead><tbody id="patient-table-body">${renderPatientRows(patients)}</tbody></table></div></section>
    <p class="privacy-note">Only collect information your clinic needs. Records are encrypted for this Windows account and are not synchronized to other devices.</p>`;
}

function renderPatientRows(patients) {
  return patients.length ? patients.map((patient, index) => `<tr><td>${patientCell(patient, index)}</td><td>${escapeHtml(patient.phone || "—")}</td><td>${formatDate(patient.dob)}</td><td>${escapeHtml(patient.gender || "—")}</td><td>${attendedVisits(patient.id).length}</td><td>${formatDate(patient.createdAt)}</td><td><button class="row-action" data-action="patient-visit" data-id="${escapeHtml(patient.id)}">Book session</button></td></tr>`).join("") : `<tr><td colspan="7"><div class="empty-state"><strong>No patients found</strong>Try another search or add a patient.</div></td></tr>`;
}

function renderVisits() {
  const clinic = clinicSettings();
  const visits = state.visits.slice().sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time));
  return `<div class="page-heading"><div><h1>${escapeHtml(serviceLabel())} history</h1><p>Attendance, treatment plan and payment status for each ${escapeHtml(clinic.specialty.toLowerCase())} ${escapeHtml(serviceLabel().toLowerCase())}.</p></div><div class="heading-actions"><button class="button button-primary" data-action="new-visit">＋ Book ${escapeHtml(serviceLabel())}</button></div></div>
    <section class="panel"><div class="toolbar"><label class="search-box"><span>⌕</span><input id="visit-search" type="search" placeholder="Search patient or treatment"></label><select class="filter-select" id="visit-date-filter" aria-label="Filter visits by date"><option value="all">All dates</option><option value="today">Today</option></select></div>
    <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Date & time</th><th>Treatment</th><th>${escapeHtml(serviceLabel())} fee</th><th>Payment</th><th>Attendance</th><th>Actions</th></tr></thead><tbody id="visit-table-body">${renderVisitRows(visits)}</tbody></table></div></section>`;
}

function appointmentActions(visit) {
  const share = `<button class="row-action" data-action="share-appointment" data-id="${escapeHtml(visit.id)}">WhatsApp</button>`;
  if (["No-show", "Cancelled", "Completed"].includes(visit.status)) return `<div class="appointment-actions">${share}<button class="row-action" data-action="reschedule" data-id="${escapeHtml(visit.id)}">Rebook</button></div>`;
  return `<div class="appointment-actions">${visit.status === "Scheduled" ? `<button class="row-action" data-action="arrive" data-id="${escapeHtml(visit.id)}">Arrived</button><button class="row-action" data-action="no-show" data-id="${escapeHtml(visit.id)}">No-show</button>` : `<button class="row-action" data-action="complete" data-id="${escapeHtml(visit.id)}">Complete</button>`}<button class="row-action" data-action="reschedule" data-id="${escapeHtml(visit.id)}">Reschedule</button>${share}</div>`;
}

function renderAppointments() {
  const monthLabel = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(calendarMonth);
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const cellCount = Math.ceil((mondayOffset + new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate()) / 7) * 7;
  const calendarCells = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - mondayOffset + 1);
    const key = dateKey(date);
    const count = state.visits.filter((visit) => visit.date === key).length;
    const classes = ["calendar-day"];
    if (date.getMonth() !== calendarMonth.getMonth()) classes.push("outside-month");
    if (key === todayKey) classes.push("today");
    if (key === selectedCalendarDate) classes.push("selected");
    return `<button type="button" class="${classes.join(" ")}" data-action="calendar-date" data-date="${key}" aria-pressed="${key === selectedCalendarDate}"><span>${date.getDate()}</span>${count ? `<small>${count} appt${count === 1 ? "" : "s"}</small>` : ""}</button>`;
  }).join("");
  const selectedVisits = state.visits.filter((visit) => visit.date === selectedCalendarDate).sort((a, b) => a.time.localeCompare(b.time));
  const reminders = state.visits.filter((visit) => visit.followUpDate && !visit.followUpCompleted).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
  return `<div class="page-heading"><div><h1>Appointments</h1><p>Plan the clinic schedule and keep track of follow-up dates.</p></div><div class="heading-actions"><button class="button button-quiet" data-action="calendar-today">Today</button><button class="button button-quiet" data-action="calendar-tomorrow">Tomorrow (${state.visits.filter((visit) => visit.date === tomorrowKey()).length})</button><button class="button button-primary" data-action="appointment-new">＋ New appointment</button></div></div>
    <div class="appointments-grid">
      <section class="panel calendar-panel"><div class="panel-heading"><div><h2>Appointment calendar</h2><p>Select a day to see its schedule</p></div><div class="calendar-controls"><button type="button" class="calendar-nav" data-action="calendar-previous" aria-label="Previous month">‹</button><strong>${monthLabel}</strong><button type="button" class="calendar-nav" data-action="calendar-next" aria-label="Next month">›</button></div></div>
        <div class="calendar-grid calendar-weekdays">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="calendar-grid">${calendarCells}</div>
        <div class="calendar-legend"><span><i class="legend-today"></i>Today</span><span><i class="legend-appointment"></i>Has appointments</span></div>
      </section>
      <section class="panel day-schedule"><div class="panel-heading"><div><h2>Schedule for ${formatDate(selectedCalendarDate)}</h2><p>${selectedVisits.length} appointment${selectedVisits.length === 1 ? "" : "s"} · ${selectedVisits.filter((visit) => ["Arrived", "Completed"].includes(visit.status)).length} arrived</p></div><button class="panel-link" data-action="appointment-new">＋ Add</button></div>
        ${selectedVisits.length ? `<div class="schedule-list">${selectedVisits.map((visit, index) => { const patient = patientFor(visit); return patient ? `<article class="schedule-item"><span class="schedule-time">${escapeHtml(visit.time)}</span>${avatar(patient.name, index)}<div class="queue-info"><button class="patient-name-link" type="button" data-action="patient-detail" data-id="${escapeHtml(patient.id)}">${escapeHtml(patient.name)}</button><small>${escapeHtml(visit.department)} · ${escapeHtml(visit.clinician)}</small>${visit.reason ? `<small>${escapeHtml(visit.reason)}</small>` : ""}${visit.noShowReason ? `<small class="no-show-reason">Missed: ${escapeHtml(visit.noShowReason)}</small>` : ""}<small>Sessions attended: ${attendedVisits(patient.id).length} · Balance: ${money(balanceFor(visit))}</small></div><div class="schedule-side">${statusBadge(visit.status)}${appointmentActions(visit)}</div></article>` : ""; }).join("")}</div>` : `<div class="empty-state"><strong>No appointments on this day</strong>Select another date or schedule an appointment.</div>`}
      </section>
    </div>
    <section class="panel reminders-panel"><div class="panel-heading"><div><h2>Follow-up reminders</h2><p>Upcoming and overdue follow-ups recorded during a visit</p></div><span class="reminder-count">${reminders.length} pending</span></div>
      ${reminders.length ? `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Follow-up date</th><th>Original visit</th><th>Treatment</th><th>Reminder</th><th>Actions</th></tr></thead><tbody>${reminders.map((visit, index) => { const patient = patientFor(visit); const label = visit.followUpDate < todayKey ? "Overdue" : visit.followUpDate === todayKey ? "Due today" : "Upcoming"; return patient ? `<tr><td>${patientCell(patient, index)}</td><td>${formatDate(visit.followUpDate)}</td><td>${formatDate(visit.date)}</td><td>${escapeHtml(visit.department)}</td><td>${statusBadge(label)}</td><td><button class="row-action" data-action="share-follow-up" data-id="${escapeHtml(visit.id)}">WhatsApp</button><button class="row-action" data-action="follow-up-done" data-id="${escapeHtml(visit.id)}">Mark done</button></td></tr>` : ""; }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No pending follow-ups</strong>Add a follow-up date when recording a visit.</div>`}
      <p class="privacy-note">Reminders are shown in this app only. The clinic server does not send SMS, email or push notifications.</p>
    </section>`;
}

function renderVisitRows(visits) {
  return visits.length ? visits.map((visit, index) => { const patient = patientFor(visit); return patient ? `<tr><td>${patientCell(patient, index)}</td><td>${formatDate(visit.date)}<small class="patient-meta">${escapeHtml(visit.time)}</small></td><td>${escapeHtml(visit.department)}</td><td>${money(visit.fee)}${visit.discountAmount ? `<small class="patient-meta">Discount ${money(visit.discountAmount)}</small>` : ""}</td><td>${statusBadge(paymentState(visit))}</td><td>${statusBadge(visit.status)}</td><td>${appointmentActions(visit)}</td></tr>` : ""; }).join("") : `<tr><td colspan="7"><div class="empty-state"><strong>No ${escapeHtml(serviceLabel().toLowerCase())}s found</strong>Book a ${escapeHtml(clinicSettings().specialty.toLowerCase())} ${escapeHtml(serviceLabel().toLowerCase())} to get started.</div></td></tr>`;
}

function renderBilling() {
  const visits = state.visits.slice().sort((a, b) => b.date.localeCompare(a.date));
  const todayVisits = visitsForToday();
  const collected = todayVisits.reduce((sum, visit) => sum + Number(visit.amountPaid || 0), 0);
  const totalOutstanding = visits.reduce((sum, visit) => sum + balanceFor(visit), 0);
  const pendingVisits = visits.filter((visit) => balanceFor(visit) > 0);
  const weeklyDue = pendingVisits.filter((visit) => visit.billingType === "Weekly").reduce((sum, visit) => sum + balanceFor(visit), 0);
  return `<div class="page-heading"><div><h1>Payments & invoices</h1><p>Session packages, weekly/monthly plans and pending balances.</p></div><div class="heading-actions"><button class="button button-quiet" data-action="export">Download protected backup</button></div></div>
    <div class="billing-summary"><div class="billing-box"><small>Received today</small><strong>${money(collected)}</strong></div><div class="billing-box due-box"><small>Total pending balance</small><strong>${money(totalOutstanding)}</strong></div><div class="billing-box due-box"><small>Weekly plan due</small><strong>${money(weeklyDue)}</strong></div></div>
    <section class="panel"><div class="panel-heading"><div><h2>Outstanding session payments</h2><p>Red indicates payment is still due. Record full or part payment to issue a receipt.</p></div><span class="reminder-count">${pendingVisits.length} pending</span></div>
    <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Session date</th><th>Plan</th><th>Fee after discount</th><th>Received</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead><tbody>${pendingVisits.length ? pendingVisits.map((visit, index) => { const patient = patientFor(visit); const overdue = visit.date < todayKey; return patient ? `<tr class="${overdue ? "payment-overdue" : ""}"><td>${patientCell(patient, index)}</td><td>${formatDate(visit.date)}</td><td>${escapeHtml(visit.billingType || "Per session")}</td><td>${money(visit.fee)}${visit.discountAmount ? `<small class="patient-meta">Saved ${money(visit.discountAmount)}</small>` : ""}</td><td>${money(visit.amountPaid)}</td><td class="balance-cell">${money(balanceFor(visit))}</td><td>${statusBadge(overdue ? "Overdue" : paymentState(visit))}</td><td><button class="row-action" data-action="record-payment" data-id="${escapeHtml(visit.id)}">Record payment</button></td></tr>` : ""; }).join("") : `<tr><td colspan="8"><div class="empty-state"><strong>All session balances are clear</strong>New unpaid sessions will appear here.</div></td></tr>`}</tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><div><h2>Recent invoices & payments</h2><p>Open a receipt to print or share it with the patient's WhatsApp number.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Date</th><th>Plan</th><th>Amount</th><th>Method</th><th>Invoice</th></tr></thead><tbody>${visits.flatMap((visit) => (visit.payments || []).map((payment) => ({ visit, payment }))).sort((a, b) => b.payment.date.localeCompare(a.payment.date)).map(({ visit, payment }, index) => { const patient = patientFor(visit); return patient ? `<tr><td>${patientCell(patient, index)}</td><td>${formatDate(payment.date)}</td><td>${escapeHtml(visit.billingType || "Per session")}</td><td>${money(payment.amount)}</td><td>${escapeHtml(payment.method)}</td><td><button class="row-action" data-action="open-invoice" data-visit-id="${escapeHtml(visit.id)}" data-payment-id="${escapeHtml(payment.id)}">${escapeHtml(payment.invoiceNumber)}</button></td></tr>` : ""; }).join("") || `<tr><td colspan="6"><div class="empty-state"><strong>No receipts yet</strong>Record a payment to create an invoice.</div></td></tr>`}</tbody></table></div></section>`;
}

function renderReports() {
  const counts = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
    const key = dateKey(date);
    return { label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date), count: state.visits.filter((visit) => visit.date === key).length, current: key === todayKey };
  });
  const maxVisits = Math.max(...counts.map((day) => day.count), 1);
  const genders = ["Female", "Male", "Non-binary", "Other", "Prefer not to say"];
  const distribution = genders.map((gender) => ({ gender, count: state.patients.filter((patient) => (patient.gender || "Prefer not to say") === gender).length }));
  const maxPatients = Math.max(state.patients.length, 1);
  const gross = visitsForToday().reduce((sum, visit) => sum + Number(visit.fee), 0);
  return `<div class="page-heading"><div><h1>Reports</h1><p>A quick view of clinic activity and patient demographics.</p></div><div class="heading-actions"><button class="button button-quiet" data-action="export">Download protected backup</button></div></div>
    <div class="billing-summary"><div class="billing-box"><small>Visits today</small><strong>${visitsForToday().length}</strong></div><div class="billing-box"><small>Gross fees today</small><strong>${money(gross)}</strong></div><div class="billing-box"><small>Registered patients</small><strong>${state.patients.length}</strong></div></div>
    <div class="report-grid"><section class="panel report-card"><div class="panel-heading"><div><h2>Visits this week</h2><p>Daily visit count · last 7 days</p></div></div><div class="bar-chart">${counts.map((day) => `<div class="bar-group"><div class="bar${day.current ? " current" : ""}" style="height:${Math.max((day.count / maxVisits) * 85, 4)}px" title="${day.count} visits"></div>${day.label}</div>`).join("")}</div><div class="legend"><span>Today</span><span>Other days</span></div></section>
    <section class="panel report-card"><div class="panel-heading"><div><h2>Patient demographics</h2><p>Gender distribution · ${state.patients.length} registered</p></div></div><div class="demographic-list">${distribution.map((item) => `<div class="demographic-row"><span>${item.gender}</span><div class="progress-track"><div class="progress-fill" style="width:${Math.round(item.count / maxPatients * 100)}%"></div></div><strong>${item.count}</strong></div>`).join("")}</div></section></div>
    <p class="privacy-note">Reports summarize records in this local database. Define clinic privacy, retention and access-control procedures before use.</p>`;
}

function renderPatientDetail() {
  const patient = state.patients.find((item) => item.id === selectedPatientId);
  if (!patient) return `<div class="empty-state"><strong>Patient record not found</strong><button class="row-action" data-view="patients">Back to patients</button></div>`;
  const visits = state.visits.filter((visit) => visit.patientId === patient.id).sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  const due = visits.reduce((sum, visit) => sum + balanceFor(visit), 0);
  const paid = visits.reduce((sum, visit) => sum + Number(visit.amountPaid || 0), 0);
  return `<div class="page-heading"><div><button class="back-link" data-view="patients">← Back to patients</button><h1>${escapeHtml(patient.name)}</h1><p>Patient ID ${escapeHtml(patient.id.toUpperCase())} · Registered ${formatDate(patient.createdAt)}</p></div><div class="heading-actions"><button class="button button-quiet" data-action="edit-whatsapp" data-id="${escapeHtml(patient.id)}">Edit WhatsApp number</button><button class="button button-primary" data-action="patient-visit" data-id="${escapeHtml(patient.id)}">＋ Book session</button></div></div>
    <div class="patient-profile-grid"><section class="panel patient-profile"><div class="patient-large-avatar">${escapeHtml(initials(patient.name))}</div><div><h2>Patient details</h2><p>${escapeHtml(patient.phone || "WhatsApp number not added")}</p><p>${escapeHtml(patient.address || "Address not added")}</p><p>${escapeHtml(patient.gender || "Gender not specified")}${patient.dob ? ` · DOB ${formatDate(patient.dob)}` : ""}</p></div><button class="button button-whatsapp" data-action="share-patient" data-id="${escapeHtml(patient.id)}">WhatsApp ↗</button></section>
    <div class="stats-grid detail-stats"><article class="stat-card"><div class="stat-top">Sessions attended<span class="stat-icon">◷</span></div><div class="stat-value">${attendedVisits(patient.id).length}</div><div class="stat-foot">Completed + arrived sessions</div></article><article class="stat-card"><div class="stat-top">Payments received<span class="stat-icon">₹</span></div><div class="stat-value">${money(paid)}</div><div class="stat-foot">Across ${visits.length} scheduled sessions</div></article><article class="stat-card"><div class="stat-top">Pending balance<span class="stat-icon">!</span></div><div class="stat-value">${money(due)}</div><div class="stat-foot">${visits.filter((visit) => balanceFor(visit) > 0).length} session balance(s)</div></article></div></div>
    <section class="panel"><div class="panel-heading"><div><h2>${escapeHtml(serviceLabel())} & payment history</h2><p>Attended visit count excludes cancelled and no-show appointments.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Treatment</th><th>Plan</th><th>Discount</th><th>Fee</th><th>Paid</th><th>Balance</th><th>Attendance</th><th>Action</th></tr></thead><tbody>${visits.length ? visits.map((visit) => `<tr><td>${formatDate(visit.date)}<small class="patient-meta">${escapeHtml(visit.time)}</small></td><td>${escapeHtml(visit.department)}</td><td>${escapeHtml(visit.billingType || "Per session")}</td><td>${money(visit.discountAmount || 0)}</td><td>${money(visit.fee)}</td><td>${money(visit.amountPaid || 0)}</td><td class="${balanceFor(visit) ? "balance-cell" : ""}">${money(balanceFor(visit))}</td><td>${statusBadge(visit.status)}<small class="patient-meta">${statusBadge(paymentState(visit))}</small></td><td>${balanceFor(visit) ? `<button class="row-action" data-action="record-payment" data-id="${escapeHtml(visit.id)}">Pay</button>` : `<button class="row-action" data-action="open-invoice" data-visit-id="${escapeHtml(visit.id)}" data-payment-id="${escapeHtml(visit.payments?.[0]?.id || "")}">Invoice</button>`}</td></tr>`).join("") : `<tr><td colspan="9"><div class="empty-state">No sessions recorded yet.</div></td></tr>`}</tbody></table></div></section>`;
}

function renderSettings() {
  const clinic = clinicSettings();
  return `<div class="page-heading"><div><h1>Clinic settings</h1><p>Customize the clinic identity, service labels, theme and invoice details.</p></div></div>
    <section class="panel settings-panel"><div class="panel-heading"><div><h2>Clinic profile & appearance</h2><p>This physiotherapy-first template can be relabeled for another clinic workflow.</p></div></div>
    <form id="clinic-form"><div class="form-grid">
      <label class="field">App display name<input name="brandName" maxlength="32" required value="${escapeHtml(clinic.brandName)}"><small>Short name shown in the sidebar.</small></label>
      <label class="field">Practice specialty<input name="specialty" maxlength="60" required value="${escapeHtml(clinic.specialty)}" placeholder="e.g. Physiotherapy, Dental"></label>
      <label class="field field-wide">Clinic / invoice name<input name="name" maxlength="120" required value="${escapeHtml(clinic.name)}"></label>
      <label class="field">Doctor / service provider<input name="doctor" maxlength="100" required value="${escapeHtml(clinic.doctor)}"></label>
      <label class="field">Provider title<input name="providerTitle" maxlength="60" required value="${escapeHtml(clinic.providerTitle)}" placeholder="e.g. Physiotherapist, Dentist"></label>
      <label class="field">Visit label<input name="serviceLabel" maxlength="24" required value="${escapeHtml(clinic.serviceLabel)}" placeholder="e.g. Session, Consultation"></label>
      <label class="field">Visit label (plural)<input name="serviceLabelPlural" maxlength="24" required value="${escapeHtml(clinic.serviceLabelPlural)}" placeholder="e.g. Sessions, Consultations"></label>
      <label class="field">Invoice service description<input name="serviceDescription" maxlength="80" required value="${escapeHtml(clinic.serviceDescription)}" placeholder="e.g. Physiotherapy session"></label>
      <label class="field">Accent theme<select name="brandColor"><option value="purple"${clinic.brandColor === "purple" ? " selected" : ""}>Purple</option><option value="blue"${clinic.brandColor === "blue" ? " selected" : ""}>Blue</option><option value="teal"${clinic.brandColor === "teal" ? " selected" : ""}>Teal</option></select></label>
      <label class="field">Clinic phone / WhatsApp<input name="phone" type="tel" maxlength="25" value="${escapeHtml(clinic.phone)}" placeholder="+91 98765 43210"></label>
      <label class="field field-wide">Clinic address<input name="address" maxlength="200" value="${escapeHtml(clinic.address)}" placeholder="Enter full clinic address"></label>
      <label class="field">Email<input name="email" type="email" maxlength="120" value="${escapeHtml(clinic.email)}"></label>
      <label class="field">GSTIN (if applicable)<input name="gstin" maxlength="20" value="${escapeHtml(clinic.gstin)}"></label>
    </div><div class="dialog-actions"><button class="button button-primary" type="submit">Save clinic details</button></div></form></section>
    <p class="privacy-note">Changing these labels customizes the appearance and wording only. It does not add specialty-specific medical forms, treatment protocols, clinical safety checks or regulatory approval. WhatsApp messages still require staff review.</p>`;
}

function renderInvoice() {
  const visit = state.visits.find((item) => item.id === invoiceVisitId);
  const patient = visit && patientFor(visit);
  const payment = visit && (visit.payments || []).find((item) => item.id === invoicePaymentId);
  if (!visit || !patient || !payment) return `<div class="empty-state">Invoice record could not be found.</div>`;
  const clinic = clinicSettings();
  return `<article class="invoice-paper"><div class="invoice-brand"><div><span class="invoice-kicker">${escapeHtml(clinic.specialty.toUpperCase())} ${escapeHtml(serviceLabel().toUpperCase())} RECEIPT</span><h1>${escapeHtml(clinic.name)}</h1><p>${escapeHtml(clinic.doctor)} · ${escapeHtml(clinic.address)}</p><p>${escapeHtml(clinic.phone || "Clinic phone not set")}${clinic.email ? ` · ${escapeHtml(clinic.email)}` : ""}</p>${clinic.gstin ? `<p>GSTIN: ${escapeHtml(clinic.gstin)}</p>` : ""}</div><div class="invoice-number"><strong>${escapeHtml(payment.invoiceNumber)}</strong><span>Receipt date ${formatDate(payment.date)}</span></div></div>
    <div class="invoice-divider"></div><div class="invoice-two-col"><div><small>BILL TO</small><strong>${escapeHtml(patient.name)}</strong><span>${escapeHtml(patient.address || "Address not provided")}</span><span>WhatsApp: ${escapeHtml(patient.phone || "Not provided")}</span></div><div><small>SESSION DETAILS</small><strong>${formatDate(visit.date)} · ${escapeHtml(visit.time)}</strong><span>${escapeHtml(visit.department)} · ${escapeHtml(visit.clinician)}</span><span>Plan: ${escapeHtml(visit.billingType || "Per session")}</span></div></div>
    <table class="invoice-table"><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody><tr><td>${escapeHtml(clinic.serviceDescription)}${visit.reason ? ` — ${escapeHtml(visit.reason)}` : ""}</td><td>${money(visit.baseFee ?? visit.fee)}</td></tr>${visit.discountAmount ? `<tr><td>Discount${visit.discountLabel ? ` (${escapeHtml(visit.discountLabel)})` : ""}</td><td>− ${money(visit.discountAmount)}</td></tr>` : ""}<tr class="invoice-total"><td>${escapeHtml(serviceLabel())} total</td><td>${money(visit.fee)}</td></tr><tr><td>Payment received (${escapeHtml(payment.method)})</td><td>${money(payment.amount)}</td></tr><tr><td>Balance remaining</td><td>${money(payment.balanceAfter ?? balanceFor(visit))}</td></tr></tbody></table>
    <div class="invoice-thanks">Thank you for choosing ${escapeHtml(clinic.name)}. Verify your clinic and applicable tax details before issuing this receipt for accounting.</div></article>`;
}

const viewInfo = {
  dashboard: { label: "Overview", render: renderDashboard },
  patients: { label: "Patients", render: renderPatients },
  "patient-detail": { label: "Patient history", render: renderPatientDetail },
  appointments: { label: "Appointments", render: renderAppointments },
  visits: { label: "Visits & queue", render: renderVisits },
  billing: { label: "Payments & invoices", render: renderBilling },
  reports: { label: "Reports", render: renderReports },
  settings: { label: "Clinic settings", render: renderSettings },
};

function render() {
  const clinic = clinicSettings();
  document.getElementById("page-content").innerHTML = viewInfo[activeView].render();
  document.getElementById("breadcrumb-page").textContent = viewInfo[activeView].label;
  document.getElementById("patient-count").textContent = state.patients.length;
  document.getElementById("clinic-name-sidebar").textContent = clinic.doctor;
  document.getElementById("breadcrumb-clinic").textContent = clinic.doctor;
  document.getElementById("clinic-brand-name").textContent = clinic.brandName;
  document.getElementById("clinic-brand-specialty").textContent = clinic.specialty.toUpperCase();
  document.getElementById("clinic-specialty-sidebar").textContent = clinic.specialty;
  document.getElementById("profile-doctor-name").textContent = clinic.doctor;
  document.getElementById("profile-doctor-title").textContent = clinic.providerTitle;
  applyClinicBrand(clinic.brandColor);
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
  const notificationCount = state.visits.filter((visit) => balanceFor(visit) > 0 || (visit.followUpDate && !visit.followUpCompleted)).length;
  const notificationBadge = document.getElementById("notification-count");
  notificationBadge.textContent = notificationCount > 99 ? "99+" : String(notificationCount);
  notificationBadge.hidden = notificationCount === 0;
  document.getElementById("notification-dot").hidden = notificationCount === 0;
  document.getElementById("notifications-button").setAttribute("aria-label", `${notificationCount} clinic reminders`);
}

function applyClinicBrand(colorName) {
  const palettes = {
    purple: { primary: "#7446a8", dark: "#5b3288", pale: "#f1eafa" },
    blue: { primary: "#3f6fa8", dark: "#2c5485", pale: "#edf3fb" },
    teal: { primary: "#368575", dark: "#256b5d", pale: "#eaf6f2" },
  };
  const palette = palettes[colorName] || palettes.purple;
  const root = document.documentElement;
  root.style.setProperty("--green", palette.primary);
  root.style.setProperty("--green-dark", palette.dark);
  root.style.setProperty("--green-pale", palette.pale);
}

function openPatientDialog() {
  document.getElementById("patient-form").reset();
  document.getElementById("patient-dialog").showModal();
}

function openVisitDialog(patientId = "", visitDate = todayKey) {
  if (!state.patients.length) {
    showToast("Add a patient before recording a visit.");
    openPatientDialog();
    return;
  }
  const form = document.getElementById("visit-form");
  form.reset();
  form.elements.department.value = clinicSettings().specialty;
  const select = document.getElementById("visit-patient");
  select.innerHTML = state.patients.slice().sort((a, b) => a.name.localeCompare(b.name)).map((patient) => `<option value="${escapeHtml(patient.id)}">${escapeHtml(patient.name)} · ${escapeHtml(patient.id.toUpperCase())}</option>`).join("");
  if (patientId) select.value = patientId;
  form.elements.clinician.value = clinicSettings().doctor;
  form.elements.date.value = visitDate;
  document.getElementById("visit-eyebrow").textContent = `${clinicSettings().specialty.toUpperCase()} ${serviceLabel().toUpperCase()}`;
  document.getElementById("visit-heading").textContent = `Book a ${serviceLabel().toLowerCase()}`;
  document.getElementById("visit-description").textContent = `Schedule a patient ${serviceLabel().toLowerCase()} or record today's ${serviceLabel().toLowerCase()}.`;
  const now = new Date();
  form.elements.time.value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  document.getElementById("visit-dialog").showModal();
}

function openPaymentDialog(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  if (!visit || balanceFor(visit) <= 0) {
    showToast("There is no outstanding balance for this session.", true);
    return;
  }
  const form = document.getElementById("payment-form");
  form.reset();
  form.elements.visitId.value = visit.id;
  form.elements.amount.value = balanceFor(visit);
  form.elements.date.value = todayKey;
  document.getElementById("payment-dialog").showModal();
}

function openNoShowDialog(visitId) {
  const visit = state.visits.find((item) => item.id === visitId);
  if (!visit) return;
  const form = document.getElementById("no-show-form");
  form.reset();
  form.elements.visitId.value = visit.id;
  document.getElementById("no-show-dialog").showModal();
}

function openInvoice(visitId, paymentId) {
  const visit = state.visits.find((item) => item.id === visitId);
  const payment = visit?.payments?.find((item) => item.id === paymentId);
  if (!visit || !payment) {
    showToast("This invoice record is not available.", true);
    return;
  }
  invoiceVisitId = visitId;
  invoicePaymentId = paymentId;
  document.getElementById("invoice-content").innerHTML = renderInvoice();
  document.getElementById("invoice-dialog").showModal();
}

function openNotificationsDialog() {
  const pendingPayments = state.visits.filter((visit) => balanceFor(visit) > 0);
  const pendingFollowUps = state.visits.filter((visit) => visit.followUpDate && !visit.followUpCompleted)
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
  const content = document.getElementById("notifications-content");
  content.innerHTML = pendingPayments.length || pendingFollowUps.length
    ? `<div class="notification-groups">
        <section class="notification-group"><h3>Payments to follow up <span>${pendingPayments.length}</span></h3>
          ${pendingPayments.length ? `<p>${pendingPayments.length} session${pendingPayments.length === 1 ? "" : "s"} have an outstanding balance of <strong>${money(pendingPayments.reduce((sum, visit) => sum + balanceFor(visit), 0))}</strong>.</p>` : `<p>All session balances are clear.</p>`}
          <button type="button" class="button button-quiet" data-view="billing">Review payments →</button>
        </section>
        <section class="notification-group"><h3>Patient follow-ups <span>${pendingFollowUps.length}</span></h3>
          ${pendingFollowUps.length ? `<ul>${pendingFollowUps.slice(0, 5).map((visit) => { const patient = patientFor(visit); return patient ? `<li><strong>${escapeHtml(patient.name)}</strong><span>${formatDate(visit.followUpDate)} · ${escapeHtml(visit.department)}</span></li>` : ""; }).join("")}</ul>` : `<p>No pending follow-ups.</p>`}
          <button type="button" class="button button-quiet" data-view="appointments">Open follow-up list →</button>
        </section>
      </div>`
    : `<div class="empty-state"><strong>You're all caught up</strong>No unpaid session balances or follow-up reminders are waiting.</div>`;
  document.getElementById("notifications-dialog").showModal();
}

function addPayment(visit, amount, method, paymentDate) {
  const payment = { id: makeId("pay"), amount, method, date: paymentDate, invoiceNumber: makeInvoiceNumber() };
  visit.amountPaid = Number(visit.amountPaid || 0) + amount;
  payment.balanceAfter = balanceFor({ ...visit, amountPaid: visit.amountPaid });
  visit.payment = paymentState(visit) === "Paid" ? "paid" : visit.amountPaid > 0 ? "partial" : "unpaid";
  visit.method = method;
  visit.payments = [...(visit.payments || []), payment];
  return payment;
}

function exportData() {
  downloadEncryptedBackup();
}

async function addPatient(form) {
  const values = new FormData(form);
  const name = String(values.get("name") || "").trim();
  const phone = String(values.get("phone") || "").trim();
  if (!name) {
    showToast("Patient name is required.", true);
    return;
  }
  if (phone && state.patients.some((patient) => patient.phone && patient.phone.replace(/\D/g, "") === phone.replace(/\D/g, ""))) {
    if (!window.confirm("A patient with this phone number already exists. Add a separate patient record anyway?")) return;
  }
  state.patients.push({
    id: makeId("p"), name, dob: String(values.get("dob") || ""), gender: String(values.get("gender") || ""),
    phone, emergency: String(values.get("emergency") || "").trim(), address: String(values.get("address") || "").trim(), createdAt: todayKey,
  });
  if (!await saveState()) return;
  document.getElementById("patient-dialog").close();
  activeView = "patients";
  render();
  showToast(`${name} added to the patient directory.`);
}

async function addVisit(form) {
  const values = new FormData(form);
  const baseFee = Number(values.get("fee"));
  const discountValue = Number(values.get("discountValue") || 0);
  const discountType = String(values.get("discountType"));
  const discountAmount = discountType === "percent" ? baseFee * Math.min(discountValue, 100) / 100 : discountType === "amount" ? Math.min(discountValue, baseFee) : 0;
  const fee = Math.max(0, Math.round(baseFee - discountAmount));
  const date = String(values.get("date") || "");
  const followUpDate = String(values.get("followUpDate") || "");
  let amountPaid = Number(values.get("paidAmount") || 0);
  if (String(values.get("payment")) === "paid" && (amountPaid === 0 || amountPaid === baseFee)) amountPaid = fee;
  if (!Number.isFinite(baseFee) || baseFee <= 0 || !Number.isFinite(discountValue) || discountValue < 0 || (discountType === "percent" && discountValue > 100) || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > fee) {
    showToast("Check the session fee, discount and amount received.", true);
    return;
  }
  if (String(values.get("payment")) === "partial" && (amountPaid <= 0 || amountPaid >= fee)) {
    showToast("For part payment, enter an amount greater than zero and less than the session total.", true);
    return;
  }
  if (!String(values.get("time"))) {
    showToast("Appointment time is required.", true);
    return;
  }
  if (!Number.isFinite(fee)) {
    showToast("Enter a valid non-negative consultation fee.", true);
    return;
  }
  if (followUpDate && followUpDate < date) {
    showToast("Follow-up date cannot be earlier than the appointment date.", true);
    return;
  }
  const visit = {
    id: makeId("v"), patientId: String(values.get("patientId")), date,
    time: String(values.get("time") || ""),
    department: String(values.get("department") || "").trim(), clinician: String(values.get("clinician") || "").trim(),
    reason: String(values.get("reason") || "").trim(), fee, baseFee, discountAmount: Math.round(discountAmount),
    discountLabel: discountType === "percent" ? `${discountValue}%` : discountType === "amount" ? money(discountValue) : "",
    billingType: String(values.get("billingType")), amountPaid: 0, payment: "unpaid",
    method: String(values.get("method")), status: "Scheduled", payments: [],
    followUpDate, followUpCompleted: false,
  };
  if (!patientFor(visit)) {
    showToast("Select a valid patient before saving the visit.", true);
    return;
  }
  state.visits.push(visit);
  if (amountPaid > 0) addPayment(visit, amountPaid, String(values.get("method")), todayKey);
  if (!await saveState()) return;
  document.getElementById("visit-dialog").close();
  activeView = activeView === "appointments" ? "appointments" : "visits";
  selectedCalendarDate = visit.date;
  calendarMonth = new Date(`${visit.date}T00:00:00`);
  calendarMonth.setDate(1);
  render();
  showToast("Visit added to the clinic queue.");
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.view) {
    target.closest("dialog")?.close();
    activeView = target.dataset.view;
    render();
    document.getElementById("sidebar").classList.remove("open");
    return;
  }
  if (target.dataset.action === "new-patient") {
    target.closest("dialog")?.close();
    openPatientDialog();
  }
  if (target.dataset.action === "new-visit") {
    target.closest("dialog")?.close();
    openVisitDialog();
  }
  if (target.dataset.action === "help") document.getElementById("help-dialog").showModal();
  if (target.dataset.action === "notifications") openNotificationsDialog();
  if (target.dataset.action === "appointment-new") openVisitDialog("", selectedCalendarDate);
  if (target.dataset.action === "patient-visit") openVisitDialog(target.dataset.id);
  if (target.dataset.action === "patient-detail") {
    selectedPatientId = target.dataset.id;
    activeView = "patient-detail";
    render();
  }
  if (target.dataset.action === "edit-whatsapp") {
    const patient = state.patients.find((item) => item.id === target.dataset.id);
    if (!patient) return;
    const form = document.getElementById("whatsapp-form");
    form.reset();
    form.elements.patientId.value = patient.id;
    form.elements.phone.value = patient.phone || "";
    document.getElementById("whatsapp-dialog").showModal();
  }
  if (target.dataset.action === "share-patient") {
    const patient = state.patients.find((item) => item.id === target.dataset.id);
    if (patient) shareOnWhatsApp(patient.phone, `Hello ${patient.name}, this is ${clinicSettings().doctor}'s ${clinicSettings().specialty.toLowerCase()} clinic.`);
  }
  if (target.dataset.action === "record-payment") openPaymentDialog(target.dataset.id);
  if (target.dataset.action === "open-invoice") openInvoice(target.dataset.visitId, target.dataset.paymentId);
  if (target.dataset.action === "print-invoice") window.print();
  if (target.dataset.action === "whatsapp-invoice") {
    const visit = state.visits.find((item) => item.id === invoiceVisitId);
    const payment = visit?.payments?.find((item) => item.id === invoicePaymentId);
    const patient = visit && patientFor(visit);
    if (visit && payment && patient) {
      shareOnWhatsApp(patient.phone, `${clinicSettings().specialty} payment receipt ${payment.invoiceNumber}\n${state.clinic.name}\nPatient: ${patient.name}\n${serviceLabel()}: ${formatDate(visit.date)}\nAmount received: ${money(payment.amount)}\nBalance: ${money(balanceFor(visit))}\nThank you.`);
    }
  }
  if (target.dataset.action === "export") await exportData();
  if (target.dataset.action === "calendar-date") {
    selectedCalendarDate = target.dataset.date;
    calendarMonth = new Date(`${selectedCalendarDate}T00:00:00`);
    calendarMonth.setDate(1);
    render();
  }
  if (target.dataset.action === "calendar-previous" || target.dataset.action === "calendar-next") {
    const offset = target.dataset.action === "calendar-previous" ? -1 : 1;
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
    selectedCalendarDate = dateKey(calendarMonth);
    render();
  }
  if (target.dataset.action === "calendar-today" || target.dataset.action === "calendar-tomorrow") {
    selectedCalendarDate = target.dataset.action === "calendar-today" ? todayKey : tomorrowKey();
    calendarMonth = new Date(`${selectedCalendarDate}T00:00:00`);
    calendarMonth.setDate(1);
    render();
  }
  if (target.dataset.action === "follow-up-done") {
    const visit = state.visits.find((item) => item.id === target.dataset.id);
    if (!visit) return;
    visit.followUpCompleted = true;
    if (!await saveState()) return;
    render();
    showToast("Follow-up reminder marked as done.");
  }
  if (target.dataset.action === "share-follow-up") {
    const visit = state.visits.find((item) => item.id === target.dataset.id);
    const patient = visit && patientFor(visit);
    if (visit && patient) shareOnWhatsApp(patient.phone, `Hello ${patient.name}, a reminder from ${state.clinic.name}: your ${clinicSettings().specialty.toLowerCase()} follow-up is on ${formatDate(visit.followUpDate)} at ${visit.time}. Please reply to confirm or reschedule.`);
  }
  if (target.dataset.action === "share-appointment") {
    const visit = state.visits.find((item) => item.id === target.dataset.id);
    const patient = visit && patientFor(visit);
    if (visit && patient) shareOnWhatsApp(patient.phone, `Hello ${patient.name}, your ${clinicSettings().specialty.toLowerCase()} ${serviceLabel().toLowerCase()} with ${visit.clinician} is on ${formatDate(visit.date)} at ${visit.time}. Please reply to confirm or request a change.`);
  }
  if (target.dataset.action === "no-show") {
    openNoShowDialog(target.dataset.id);
  }
  if (["arrive", "complete"].includes(target.dataset.action)) {
    const visit = state.visits.find((item) => item.id === target.dataset.id);
    if (!visit) return;
    visit.status = target.dataset.action === "arrive" ? "Arrived" : "Completed";
    if (!await saveState()) return;
    render();
    showToast(`Appointment marked ${visit.status.toLowerCase()}.`);
  }
  if (target.dataset.action === "reschedule") {
    const visit = state.visits.find((item) => item.id === target.dataset.id);
    if (!visit) return;
    const form = document.getElementById("reschedule-form");
    form.reset();
    form.elements.visitId.value = visit.id;
    form.elements.date.value = visit.date < todayKey ? todayKey : visit.date;
    form.elements.time.value = visit.time;
    document.getElementById("reschedule-dialog").showModal();
  }
  if (target.dataset.closeDialog !== undefined) target.closest("dialog").close();
});

document.getElementById("patient-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await addPatient(event.currentTarget);
});
document.getElementById("visit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await addVisit(event.currentTarget);
});
document.getElementById("payment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const visit = state.visits.find((item) => item.id === String(values.get("visitId")));
  const amount = Number(values.get("amount"));
  if (!visit || !Number.isFinite(amount) || amount <= 0 || amount > balanceFor(visit)) {
    showToast(`Enter a payment greater than zero and no more than the remaining ${money(balanceFor(visit || { fee: 0 }))}.`, true);
    return;
  }
  const payment = addPayment(visit, amount, String(values.get("method")), String(values.get("date")));
  if (!await saveState()) return;
  document.getElementById("payment-dialog").close();
  render();
  showToast("Payment saved. Invoice is ready to print or share.");
  openInvoice(visit.id, payment.id);
});
document.getElementById("no-show-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const visit = state.visits.find((item) => item.id === String(values.get("visitId")));
  if (!visit) {
    showToast("Appointment could not be found.", true);
    return;
  }
  visit.status = "No-show";
  visit.noShowReason = String(values.get("reason") || "").trim();
  if (!await saveState()) return;
  document.getElementById("no-show-dialog").close();
  render();
  showToast("No-show recorded. You can rebook this patient.");
});
document.getElementById("whatsapp-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const patient = state.patients.find((item) => item.id === String(values.get("patientId")));
  if (!patient) {
    showToast("Patient could not be found.", true);
    return;
  }
  patient.phone = String(values.get("phone") || "").trim();
  if (!await saveState()) return;
  document.getElementById("whatsapp-dialog").close();
  render();
  showToast("Patient WhatsApp number updated.");
});
document.getElementById("reschedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const visit = state.visits.find((item) => item.id === String(values.get("visitId")));
  if (!visit) {
    showToast("Appointment could not be found.", true);
    return;
  }
  visit.rescheduleReason = String(values.get("reason")).trim();
  visit.rescheduledFrom = { date: visit.date, time: visit.time };
  visit.date = String(values.get("date"));
  visit.time = String(values.get("time"));
  visit.status = "Scheduled";
  if (!await saveState()) return;
  document.getElementById("reschedule-dialog").close();
  selectedCalendarDate = visit.date;
  calendarMonth = new Date(`${visit.date}T00:00:00`);
  calendarMonth.setDate(1);
  activeView = "appointments";
  render();
  showToast("Appointment rescheduled.");
});
document.getElementById("page-content").addEventListener("submit", async (event) => {
  if (event.target.id !== "clinic-form") return;
  event.preventDefault();
  const values = new FormData(event.target);
  state.clinic = {
    name: String(values.get("name")).trim(), doctor: String(values.get("doctor")).trim(),
    brandName: String(values.get("brandName")).trim(), providerTitle: String(values.get("providerTitle")).trim(),
    specialty: String(values.get("specialty")).trim(), serviceLabel: String(values.get("serviceLabel")).trim(),
    serviceLabelPlural: String(values.get("serviceLabelPlural")).trim(),
    serviceDescription: String(values.get("serviceDescription")).trim(), brandColor: String(values.get("brandColor")),
    phone: String(values.get("phone")).trim(), address: String(values.get("address")).trim(),
    email: String(values.get("email")).trim(), gstin: String(values.get("gstin")).trim(),
  };
  if (!await saveState()) return;
  render();
  showToast("Clinic invoice details saved.");
});
document.getElementById("visit-form").elements.payment.addEventListener("change", (event) => {
  const form = document.getElementById("visit-form");
  if (event.target.value === "paid") form.elements.paidAmount.value = String(calculateSessionFee(form));
  else if (event.target.value === "unpaid") form.elements.paidAmount.value = "0";
});
function calculateSessionFee(form) {
  const baseFee = Number(form.elements.fee.value) || 0;
  const discountValue = Number(form.elements.discountValue.value) || 0;
  const discountType = form.elements.discountType.value;
  const discount = discountType === "percent" ? baseFee * Math.min(discountValue, 100) / 100
    : discountType === "amount" ? Math.min(discountValue, baseFee) : 0;
  return Math.max(0, Math.round(baseFee - discount));
}
document.getElementById("visit-form").addEventListener("input", (event) => {
  const form = event.currentTarget;
  if (form.elements.payment.value === "paid" && ["fee", "discountType", "discountValue"].includes(event.target.name)) {
    form.elements.paidAmount.value = String(calculateSessionFee(form));
  }
});
document.getElementById("page-content").addEventListener("input", (event) => {
  if (event.target.id === "patient-search") {
    patientQuery = event.target.value;
    const gender = document.getElementById("gender-filter")?.value || "";
    const filtered = state.patients.filter((patient) => `${patient.name} ${patient.phone} ${patient.id}`.toLowerCase().includes(patientQuery.toLowerCase()) && (!gender || patient.gender === gender));
    document.getElementById("patient-table-body").innerHTML = renderPatientRows(filtered);
  }
  if (event.target.id === "visit-search") {
    const dateFilter = document.getElementById("visit-date-filter").value;
    filterVisits(event.target.value, dateFilter);
  }
});
document.getElementById("page-content").addEventListener("change", (event) => {
  if (event.target.id === "gender-filter") {
    const query = document.getElementById("patient-search").value.toLowerCase();
    const gender = event.target.value;
    const filtered = state.patients.filter((patient) => `${patient.name} ${patient.phone} ${patient.id}`.toLowerCase().includes(query) && (!gender || patient.gender === gender));
    document.getElementById("patient-table-body").innerHTML = renderPatientRows(filtered);
  }
  if (event.target.id === "visit-date-filter") filterVisits(document.getElementById("visit-search").value, event.target.value);
});

function filterVisits(query, dateFilter) {
  const filtered = state.visits.filter((visit) => {
    const patient = patientFor(visit);
    const matchesText = patient && `${patient.name} ${visit.department} ${visit.clinician}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (dateFilter !== "today" || visit.date === todayKey);
  }).sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time));
  document.getElementById("visit-table-body").innerHTML = renderVisitRows(filtered);
}

document.getElementById("export-data").addEventListener("click", exportData);
document.getElementById("mobile-menu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.getElementById("today-label").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(today);
document.getElementById("lock-app").addEventListener("click", lockApp);
document.getElementById("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  const errorBox = document.getElementById("auth-error");
  const submit = document.getElementById("auth-submit");
  if (authSetupMode && password !== form.elements.confirmPassword.value) {
    errorBox.textContent = "The passwords do not match.";
    return;
  }
  submit.disabled = true;
  errorBox.textContent = "";
  try {
    const { result } = await apiRequest(authSetupMode ? "/api/setup" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    csrfToken = result.csrf;
    await loadState();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    if (document.getElementById("auth-dialog").open) submit.disabled = false;
    form.elements.password.value = "";
    if (form.elements.confirmPassword) form.elements.confirmPassword.value = "";
  }
});
for (const eventName of ["pointerdown", "keydown", "touchstart"]) {
  document.addEventListener(eventName, () => {
    if (csrfToken) startIdleLock();
  }, { passive: true });
}

loadState();
