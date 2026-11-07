/* ══════════════════════════════════════════════════════════
   API CLIENT — Google Apps Script backend
   Paste your Web App URL below (ends in /exec). See apps-script/Code.gs
   for the backend itself and the setup steps.
═══════════════════════════════════════════════════════════ */
const API_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwTzTEQS1JT8iQvE7afTjOGV8edTjwHmeB1-E-XO4ETlvo_sk1E9IwZCqAh_LcWmO5k/exec';
let authToken = null;
const AUTH_TOKEN_KEY = 'careCircleAuthToken';
function saveAuthToken(token) {
  authToken = token;
  try { localStorage.setItem(AUTH_TOKEN_KEY, token); } catch {}
}
function clearAuthToken() {
  authToken = null;
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
}

async function callApi(action, data) {
  const params = new URLSearchParams();
  params.append('action', action);
  if (authToken) params.append('token', authToken);
  if (data) {
    Object.keys(data).forEach((key) => {
      const value = data[key];
      if (value === undefined) return;
      params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    });
  }
  let res;
  try {
    res = await fetch(API_ENDPOINT, { method: 'POST', body: params });
  } catch (networkErr) {
    throw new Error('Can’t reach the server. Check API_ENDPOINT at the top of the script.');
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Unexpected response from the server.');
  }
  if (!json.ok) {
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
}

/* Full-screen "working…" overlay + in-flight guard, so slow server calls
   never look like the app froze. */
let authInFlight = false;
function showBusy(msg) {
  document.getElementById('busy-text').textContent = msg || 'Working…';
  document.getElementById('busy-overlay').classList.add('show');
}
function hideBusy() {
  document.getElementById('busy-overlay').classList.remove('show');
}

/* ══════════════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════════════ */
const screens = ['home','meds','calendar','feed','emergency'];
let currentScreen = 'home';

function goTo(id) {
  closeApptDetailModal();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', screens[i] === id);
    t.setAttribute('aria-selected', screens[i] === id);
  });
  document.getElementById('fab').style.display =
    ['home','meds','calendar','feed'].includes(id) ? 'flex' : 'none';
  currentScreen = id;
}

function openFab() {
  if (currentScreen === 'meds')     { document.getElementById('med-modal').classList.add('open'); return; }
  if (currentScreen === 'calendar') { document.getElementById('appt-modal').classList.add('open'); return; }
  openComment();
}

/* ══════════════════════════════════════════════════════════
   AUTH STATE
═══════════════════════════════════════════════════════════ */
let currentUser = null;   // { id, email, fullName, firstName, role }
let currentFamily = null; // { id, name, plan }
let pendingSignup = null; // { fullName, email, password } — held between the signup form and plan screen
let selectedPlan = 'free';
let pendingInviteDrafts = []; // invites collected on the onboarding invite screen, sent on Continue

function switchAuthTab(which) {
  document.getElementById('tab-login').classList.toggle('active', which === 'login');
  document.getElementById('tab-signup').classList.toggle('active', which === 'signup');
  document.getElementById('login-form').classList.toggle('hidden', which !== 'login');
  document.getElementById('signup-form').classList.toggle('hidden', which !== 'signup');
  hideAuthError('login');
  hideAuthError('signup');
}
function showAuthError(which, msg) {
  const el = document.getElementById(which + '-error');
  el.textContent = msg;
  el.classList.add('show');
}
function hideAuthError(which) {
  document.getElementById(which + '-error').classList.remove('show');
}
function validEmail(v) { return /^\S+@\S+\.\S+$/.test(v); }

/* Converts a <input type="time"> value ("14:30") to the "8:00 AM"-style
   string the rest of the app displays and matches against. */
function to12HourLabel(hhmm) {
  const [hStr, mStr] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return h + ':' + mStr + ' ' + period;
}

/* Country-code-aware phone validation — mirrors src/lib/phone.ts on the backend.
   Both copies matter: this one gives instant feedback in the form; the backend's
   copy is the real security boundary, since anyone can call the API directly. */
const PHONE_RULES = {
  '+961': { min: 7,  max: 8  }, '+971': { min: 9,  max: 9  }, '+966': { min: 9,  max: 9  },
  '+962': { min: 9,  max: 9  }, '+20':  { min: 10, max: 10 }, '+963': { min: 9,  max: 9  },
  '+964': { min: 10, max: 10 }, '+965': { min: 8,  max: 8  }, '+974': { min: 8,  max: 8  },
  '+973': { min: 8,  max: 8  }, '+968': { min: 8,  max: 8  }, '+970': { min: 9,  max: 9  },
  '+90':  { min: 10, max: 10 }, '+357': { min: 8,  max: 8  }, '+1':   { min: 10, max: 10 },
  '+44':  { min: 10, max: 11 }, '+33':  { min: 9,  max: 9  }, '+49':  { min: 6,  max: 11 },
  '+61':  { min: 9,  max: 9  }, '+91':  { min: 10, max: 10 },
};
function isValidPhoneLocal(v, code) {
  const digits = v.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return false;
  const rule = PHONE_RULES[code] || { min: 6, max: 12 };
  return digits.length >= rule.min && digits.length <= rule.max;
}
function phoneErrorMessage(code) {
  const rule = PHONE_RULES[code] || { min: 6, max: 12 };
  const range = rule.min === rule.max ? `${rule.min} digits` : `${rule.min}–${rule.max} digits`;
  return `Enter a valid ${code} number (${range})`;
}

async function submitLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-password').value;
  if (!email || !pw) { showAuthError('login', 'Enter your email and password'); return; }
  if (!validEmail(email)) { showAuthError('login', 'Enter a valid email address'); return; }
  hideAuthError('login');
  if (authInFlight) return;
  authInFlight = true;
  showBusy('Signing you in…');
  try {
    const data = await callApi('loginUser', { email, password: pw });
    saveAuthToken(data.token);
    currentUser = data.user;
    currentFamily = data.family;
    await loadAppData();
    enterApp();
  } catch (err) {
    showAuthError('login', err.message);
  } finally {
    authInFlight = false;
    hideBusy();
  }
}

function passwordStrengthLevel(pw) {
  if (!pw) return 'empty';
  if (pw.length < 6) return 'weak';
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^A-Za-z0-9]/.test(pw)) variety++;
  if (pw.length >= 8 && variety >= 2) return 'strong';
  return 'medium';
}
function updatePasswordMeterUI(inputId, hintId, segPrefix) {
  const pw = document.getElementById(inputId).value;
  const level = passwordStrengthLevel(pw);
  const input = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  const segs = [1, 2, 3].map(n => document.getElementById(segPrefix + '-' + n));

  ['pw-weak', 'pw-medium', 'pw-strong'].forEach(c => { input.classList.remove(c); hint.classList.remove(c); });
  segs.forEach(seg => seg.classList.remove('fill-weak', 'fill-medium', 'fill-strong'));

  if (level === 'empty') {
    hint.innerHTML = '&bull; At least 6 characters';
    return;
  }
  input.classList.add('pw-' + level);
  hint.classList.add('pw-' + level);
  const filled = level === 'weak' ? 1 : level === 'medium' ? 2 : 3;
  for (let i = 0; i < filled; i++) segs[i].classList.add('fill-' + level);

  const icon = level === 'strong' ? '&check;' : level === 'medium' ? '&check;' : '&bull;';
  const label = level === 'weak' ? 'At least 6 characters' : level === 'medium' ? 'Good — meets the minimum' : 'Strong password';
  hint.innerHTML = icon + ' ' + label;
}
function updateSignupPasswordHint() {
  updatePasswordMeterUI('signup-password', 'signup-password-hint', 'signup-password-seg');
}
function updateForgotPasswordHint() {
  updatePasswordMeterUI('fp-new-password', 'fp-password-hint', 'fp-password-seg');
}
function updateJoinPasswordHint() {
  updatePasswordMeterUI('join-password', 'join-password-hint', 'join-password-seg');
}

async function submitSignup() {
  const fullName = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pw = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;

  if (!fullName || !email || !pw || !confirm) { showAuthError('signup', 'Fill in every field to continue'); return; }
  if (!validEmail(email)) { showAuthError('signup', 'Enter a valid email address'); return; }
  if (pw.length < 6) { showAuthError('signup', 'Password must be at least 6 characters'); return; }
  if (pw !== confirm) { showAuthError('signup', 'Passwords do not match'); return; }
  hideAuthError('signup');

  pendingInviteDrafts = [];
  document.getElementById('ob-invite-list').innerHTML = '';
  document.getElementById('ob-invite-name').value = '';
  document.getElementById('ob-invite-email').value = '';
  clearOnboardingFields();
  obEditMode = false;

  // Plan selection is skipped for now — every new account is Free.
  if (authInFlight) return;
  authInFlight = true;
  showBusy('Creating your account…');
  try {
    const data = await callApi('signupUser', { fullName, email, password: pw, plan: 'free' });
    saveAuthToken(data.token);
    currentUser = data.user;
    currentFamily = data.family;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('ob-skip').style.display = '';
    document.getElementById('invite-screen').style.display = 'flex';
  } catch (err) {
    showAuthError('signup', err.message);
  } finally {
    authInFlight = false;
    hideBusy();
  }
}

/* ══════════════════════════════════════════════════════════
   INVITE MEMBERS (onboarding step — batch-sent on Continue)
═══════════════════════════════════════════════════════════ */
function obAddInvite() {
  const name = document.getElementById('ob-invite-name').value.trim();
  const email = document.getElementById('ob-invite-email').value.trim();
  if (!name) { showToast('Enter a name'); return; }
  if (!email || !validEmail(email)) { showToast('Enter a valid email'); return; }
  pendingInviteDrafts.push({ name, email });
  document.getElementById('ob-invite-name').value = '';
  document.getElementById('ob-invite-email').value = '';
  renderObInviteList();
}
function obRemoveInvite(i) {
  pendingInviteDrafts.splice(i, 1);
  renderObInviteList();
}
function renderObInviteList() {
  const box = document.getElementById('ob-invite-list');
  box.innerHTML = pendingInviteDrafts.map((m, i) => `
    <div class="ob-med-row">
      <div>
        <div class="ob-med-row-name">${m.name}</div>
        <div class="ob-med-row-sub">${m.email} &bull; Not yet sent</div>
      </div>
      <button class="ob-med-remove" onclick="obRemoveInvite(${i})" aria-label="Remove ${m.name}">&#x2715;</button>
    </div>`).join('');
}
async function continueFromInviteScreen() {
  for (const invite of pendingInviteDrafts) {
    try {
      await callApi('addInvite', invite);
    } catch (err) {
      showToast('Could not invite ' + invite.name + ': ' + err.message);
    }
  }
  document.getElementById('invite-screen').style.display = 'none';
  document.getElementById('onboarding-screen').style.display = 'flex';
  obGoToStep(1);
}

/* Invite someone later, from Settings */
function openInviteModal() { document.getElementById('invite-modal').classList.add('open'); }
function closeInviteModal() { document.getElementById('invite-modal').classList.remove('open'); }
async function submitInvite() {
  const name = document.getElementById('invite-name-input').value.trim();
  const email = document.getElementById('invite-email-input').value.trim();
  if (!name) { showToast('Enter a name'); return; }
  if (!email || !validEmail(email)) { showToast('Enter a valid email'); return; }
  try {
    await callApi('addInvite', { name, email });
    document.getElementById('invite-name-input').value = '';
    document.getElementById('invite-email-input').value = '';
    closeInviteModal();
    await loadFamilyInfo();
    showToast('Invite sent to ' + name);
  } catch (err) {
    showToast(err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   SETTINGS: plan + family members
═══════════════════════════════════════════════════════════ */
let familyMembers = [];   // registered users in the family, from /api/families/me
let pendingInvites = [];  // people invited but not yet registered

async function loadFamilyInfo() {
  const data = await callApi('getFamily');
  familyMembers = (data && data.members) || [];
  pendingInvites = (data && data.pendingInvites) || [];
  renderSettingsFamilyInfo();
}

function renderSettingsFamilyInfo() {
  const total = familyMembers.length + pendingInvites.length;
  const planLabel = currentFamily && currentFamily.plan === 'premium' ? 'Premium' : 'Free';
  document.getElementById('settings-family-name').textContent = currentFamily ? currentFamily.name : '';
  document.getElementById('settings-plan-members').textContent =
    planLabel + ' plan — ' + total + (total === 1 ? ' member' : ' members');
  const joinedRows = familyMembers.filter(m => m.id !== currentUser.id).map(m => `
    <div class="settings-row" style="cursor:default;">
      <div><div class="settings-label">${m.fullName}</div><div class="settings-sub">${m.email}</div></div>
      <span class="role-badge">${roleLabel(m.role)}</span>
    </div>`).join('');
  const invitedRows = pendingInvites.map(m => `
    <div class="settings-row" style="cursor:default;">
      <div><div class="settings-label">${m.name}</div><div class="settings-sub">${m.email}</div></div>
      <span class="pill pill-amber">Invited</span>
    </div>`).join('');
  document.getElementById('settings-member-list').innerHTML = joinedRows + invitedRows;
  document.getElementById('feed-family-subtitle').textContent =
    (currentFamily ? currentFamily.name : '') + ' • ' + total + (total === 1 ? ' member' : ' members');
}

/* ══════════════════════════════════════════════════════════
   CAREGIVER COVERAGE
═══════════════════════════════════════════════════════════ */
const CAREGIVER_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const CAREGIVER_DAY_LABELS = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' };
const CAREGIVER_PALETTE = ['#1E2D4A', '#4A7C6F', '#C4892A', '#8B5CF6', '#EC4899', '#0EA5E9'];
let caregiverShifts = {};

function getAssignablePeople() {
  const names = [currentUser.firstName, ...familyMembers.filter(m => m.id !== currentUser.id).map(m => m.firstName), ...pendingInvites.map(i => i.name)];
  Object.values(caregiverShifts).forEach(name => { if (name) names.push(name); });
  return [...new Set(names)];
}
function colorForPerson(name) {
  const people = getAssignablePeople();
  const idx = people.indexOf(name);
  return CAREGIVER_PALETTE[idx >= 0 ? idx % CAREGIVER_PALETTE.length : 0];
}

function renderHomeCoverageCard() {
  const groups = [];
  let current = null;
  CAREGIVER_DAYS.forEach(d => {
    const person = caregiverShifts[d];
    if (current && current.person === person) {
      current.days.push(d);
    } else {
      current = { person, days: [d] };
      groups.push(current);
    }
  });
  let html = groups.map(g => {
    if (!g.person) {
      return `
        <div class="shift-item">
          <div class="shift-avatar" style="background:var(--red-faint);color:var(--red);">?</div>
          <div class="shift-info">
            <div class="shift-name" style="color:var(--red);">No one assigned</div>
            <div class="shift-days">${g.days.join(', ')}</div>
          </div>
        </div>`;
    }
    const isYou = g.person === currentUser.firstName;
    const initial = g.person.charAt(0).toUpperCase();
    return `
      <div class="shift-item">
        <div class="shift-avatar" style="background:${colorForPerson(g.person)}">${initial}</div>
        <div class="shift-info">
          <div class="shift-name">${g.person}${isYou ? ' (you)' : ''}</div>
          <div class="shift-days">${g.days.join(', ')}</div>
        </div>
        ${isYou ? '<span class="pill pill-slate">Active</span>' : ''}
      </div>`;
  }).join('');
  if (familyMembers.length <= 1 && pendingInvites.length === 0) {
    html += `<div style="padding:12px 0 2px;font-size:13px;color:var(--text-muted);text-align:center;">Invite family members to share coverage.</div>`;
  }
  document.getElementById('home-coverage-content').innerHTML = html;
}

function renderCalendarCoverageRow() {
  document.getElementById('calendar-coverage-row').innerHTML = CAREGIVER_DAYS.map(d => {
    const person = caregiverShifts[d];
    if (!person) {
      return `
        <div class="shift-chip gap">
          <div class="shift-chip-day">${d}</div>
          <div class="shift-chip-avatar">?</div>
          <div class="shift-chip-who">Open</div>
        </div>`;
    }
    const isYou = person === currentUser.firstName;
    const initial = person.charAt(0).toUpperCase();
    return `
      <div class="shift-chip">
        <div class="shift-chip-day">${d}</div>
        <div class="shift-chip-avatar" style="background:${colorForPerson(person)}">${initial}</div>
        <div class="shift-chip-who">${person}</div>
      </div>`;
  }).join('');
}

function renderCoverage() {
  renderHomeCoverageCard();
  renderCalendarCoverageRow();
}

function openCoverageModal() {
  const people = getAssignablePeople();
  document.getElementById('coverage-modal-body').innerHTML = CAREGIVER_DAYS.map(d => {
    const current = caregiverShifts[d];
    const options = people.map(p =>
      `<option value="${p}" ${p === current ? 'selected' : ''}>${p}${p === currentUser.firstName ? ' (you)' : ''}</option>`
    ).join('') + `<option value="" ${!current ? 'selected' : ''}>No one assigned</option>`;
    return `
      <div class="form-group">
        <label class="form-label">${CAREGIVER_DAY_LABELS[d]}</label>
        <select class="form-input" id="coverage-select-${d}">${options}</select>
      </div>`;
  }).join('');
  document.getElementById('coverage-modal').classList.add('open');
}
function closeCoverageModal() {
  document.getElementById('coverage-modal').classList.remove('open');
}
async function submitCoverage() {
  const payload = {};
  CAREGIVER_DAYS.forEach(d => {
    payload[d] = document.getElementById('coverage-select-' + d).value || null;
  });
  try {
    caregiverShifts = await callApi('updateCoverage', { coverage: payload });
    closeCoverageModal();
    renderCoverage();
    showToast('Coverage updated');
  } catch (err) {
    showToast(err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   ONBOARDING: Emergency Health Summary + Medications
   (Plan/Invite screens happen before this; see above.)
═══════════════════════════════════════════════════════════ */
let obStep = 1;
let obMeds = [];
let obEditMode = false;
let lastAddedMedSignature = null; // guards against re-adding the same medication twice
const OB_LAST_STEP = 4;

function obGoToStep(n) {
  obStep = n;
  for (let i = 1; i <= OB_LAST_STEP; i++) {
    document.getElementById('ob-step-' + i).classList.toggle('active', i === n);
    document.getElementById('ob-dot-' + i).classList.toggle('active', i === n);
    document.getElementById('ob-dot-' + i).classList.toggle('done', i < n);
  }
  const first = obEditMode ? 3 : 1;
  document.getElementById('ob-back-btn').style.display = n === first ? 'none' : 'inline-flex';
  document.getElementById('ob-next-btn').textContent = n === OB_LAST_STEP ? 'Finish setup' : 'Continue';
}

async function obNext() {
  if (obStep === 1) {
    const name = document.getElementById('ob-name').value.trim();
    if (!name) { showToast('Enter a name to continue'); return; }
  }
  if (obStep === 2) {
    // If they typed a medication but never tapped "+ Add this medication",
    // add it for them now instead of silently losing what they entered —
    // but only if it's not just leftover/autofilled text matching what
    // was already added (otherwise it'd get added twice).
    const pendingName = document.getElementById('ob-med-name').value.trim();
    if (pendingName) {
      const pendingDose = parseFloat(document.getElementById('ob-med-dose').value.trim());
      const pendingTimes = Array.from(document.querySelectorAll('#ob-med-times-list [data-ob-med-time]')).map(el => el.value).filter(Boolean).map(to12HourLabel).join(',');
      const pendingSignature = pendingName.toLowerCase() + '|' + pendingDose + '|' + pendingTimes;
      if (pendingSignature !== lastAddedMedSignature) {
        obAddMed();
        if (document.getElementById('ob-med-name').value.trim()) return; // add failed validation — stay put
      }
    }
  }
  if (obStep === OB_LAST_STEP) {
    const p1El = document.getElementById('ob-c1-phone');
    const p2El = document.getElementById('ob-c2-phone');
    const code1 = document.getElementById('ob-c1-code').value;
    const code2 = document.getElementById('ob-c2-code').value;
    const p1 = p1El.value.trim();
    const p2 = p2El.value.trim();
    const p1Valid = !p1 || isValidPhoneLocal(p1, code1);
    const p2Valid = !p2 || isValidPhoneLocal(p2, code2);
    p1El.classList.toggle('input-error', !p1Valid);
    const p1ErrEl = document.getElementById('ob-c1-phone-error');
    p1ErrEl.textContent = phoneErrorMessage(code1);
    p1ErrEl.classList.toggle('show', !p1Valid);
    p2El.classList.toggle('input-error', !p2Valid);
    const p2ErrEl = document.getElementById('ob-c2-phone-error');
    p2ErrEl.textContent = phoneErrorMessage(code2);
    p2ErrEl.classList.toggle('show', !p2Valid);
    if (!p1Valid || !p2Valid) { showToast('Enter a valid phone number'); return; }
    await finishOnboarding();
    return;
  }
  const next = (obEditMode && obStep === 1) ? 3 : obStep + 1;
  obGoToStep(next);
}
function obPrev() {
  const first = obEditMode ? 3 : 1;
  if (obStep === first) return;
  const prev = (obEditMode && obStep === 3) ? 1 : obStep - 1;
  obGoToStep(prev);
}

function obAddMedTimeRow(value) {
  const list = document.getElementById('ob-med-times-list');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
  row.innerHTML = `
    <input type="hidden" value="${value || '08:00'}" data-ob-med-time />
    <button type="button" class="ob-med-remove" onclick="removeTimeRow(this)" aria-label="Remove time">&#x2715;</button>
  `;
  list.appendChild(row);
  attachTimePicker(row.querySelector('input'));
}
function obResetMedTimeRows() {
  const list = document.getElementById('ob-med-times-list');
  if (!list) return;
  destroyPickersIn(list);
  list.innerHTML = '';
  obAddMedTimeRow('08:00');
}

function obAddMed() {
  const name = document.getElementById('ob-med-name').value.trim();
  const doseInput = document.getElementById('ob-med-dose').value.trim();
  if (!name) { showToast('Enter a medication name'); return; }
  const doseNum = parseFloat(doseInput);
  if (!doseInput || isNaN(doseNum) || doseNum <= 0) { showToast('Enter a valid dosage in mg'); return; }
  const times = Array.from(document.querySelectorAll('#ob-med-times-list [data-ob-med-time]'))
    .map(el => el.value).filter(Boolean).map(to12HourLabel);
  if (!times.length) { showToast('Add at least one reminder time'); return; }
  const endDate = document.getElementById('ob-med-end-date').value;
  obMeds.push({ name, doseValueMg: doseNum, times, endDate: endDate || undefined });
  lastAddedMedSignature = name.toLowerCase() + '|' + doseNum + '|' + times.join(',');
  document.getElementById('ob-med-name').value = '';
  document.getElementById('ob-med-dose').value = '';
  if (obEndDatePicker) obEndDatePicker.clear();
  obResetMedTimeRows();
  renderObMedList();
}
function obRemoveMed(i) {
  obMeds.splice(i, 1);
  renderObMedList();
}
function renderObMedList() {
  const box = document.getElementById('ob-med-list');
  box.innerHTML = obMeds.map((m, i) => `
    <div class="ob-med-row">
      <div>
        <div class="ob-med-row-name">${m.name} — ${m.doseValueMg}mg</div>
        <div class="ob-med-row-sub">${m.times.join(', ')}${m.endDate ? ' &bull; until ' + m.endDate : ''}</div>
      </div>
      <button class="ob-med-remove" onclick="obRemoveMed(${i})" aria-label="Remove ${m.name}">&#x2715;</button>
    </div>`).join('');
}

async function skipOnboarding() {
  showBusy('Setting things up…');
  try {
    const data = await callApi('finishOnboarding', { meds: obMeds });
    obMeds = [];
    document.getElementById('onboarding-screen').style.display = 'none';
    applyBootstrap(data);
    enterApp();
    showToast((data.warnings && data.warnings[0]) || 'You can add medications and health info anytime from Settings');
  } catch (err) {
    showToast(err.message);
  } finally {
    hideBusy();
  }
}

let obFinishing = false;
async function finishOnboarding() {
  if (obFinishing) return;
  obFinishing = true;
  const nextBtn = document.getElementById('ob-next-btn');
  if (nextBtn) nextBtn.disabled = true;
  try {
    await finishOnboardingImpl();
  } finally {
    obFinishing = false;
    if (nextBtn) nextBtn.disabled = false;
  }
}
async function finishOnboardingImpl() {
  const weightVal = document.getElementById('ob-weight-value').value.trim();
  const weightUnit = document.getElementById('ob-weight-unit').value;
  const summaryPayload = {
    name: document.getElementById('ob-name').value.trim() || 'Not added yet',
    dob: document.getElementById('ob-dob').value || undefined,
    bloodType: document.getElementById('ob-blood').value || undefined,
    weightValue: weightVal ? parseFloat(weightVal) : undefined,
    weightUnit: weightVal ? weightUnit : undefined,
    allergies: document.getElementById('ob-allergies').value.trim() || undefined,
    conditions: document.getElementById('ob-conditions').value.trim() || undefined,
    insuranceCarrier: document.getElementById('ob-ins-carrier').value.trim() || undefined,
    insurancePolicy: document.getElementById('ob-ins-policy').value.trim() || undefined,
    insuranceGroup: document.getElementById('ob-ins-group').value.trim() || undefined,
  };

  const contacts = [];
  const c1name = document.getElementById('ob-c1-name').value.trim();
  const c1phone = document.getElementById('ob-c1-phone').value.trim();
  const c2name = document.getElementById('ob-c2-name').value.trim();
  const c2phone = document.getElementById('ob-c2-phone').value.trim();
  if (c1name && c1phone) contacts.push({ name: c1name, countryCode: document.getElementById('ob-c1-code').value, phone: c1phone, isPrimary: true });
  if (c2name && c2phone) contacts.push({ name: c2name, countryCode: document.getElementById('ob-c2-code').value, phone: c2phone, isPrimary: false });

  // Health summary + contacts + starter medications + a fresh copy of all
  // app data: ONE request instead of ~15.
  showBusy(obEditMode ? 'Saving…' : 'Setting things up…');
  let data;
  try {
    data = await callApi('finishOnboarding', { summary: summaryPayload, contacts, meds: obEditMode ? [] : obMeds });
  } catch (err) {
    hideBusy();
    showToast(err.message);
    return;
  }
  hideBusy();

  document.getElementById('onboarding-screen').style.display = 'none';
  applyBootstrap(data);
  const warning = data.warnings && data.warnings[0];

  if (obEditMode) {
    obEditMode = false;
    document.getElementById('ob-dot-2').style.display = '';
    goTo('emergency');
    showToast(warning || 'Emergency card updated');
  } else {
    obMeds = [];
    enterApp();
    showToast(warning || 'Emergency card ready');
  }
}

async function editHealthSummary() {
  closeSettings();
  obEditMode = true;
  document.getElementById('ob-skip').style.display = 'none';
  document.getElementById('ob-dot-2').style.display = 'none';
  const s = healthSummary || {};
  document.getElementById('ob-name').value = (s.name && s.name !== 'Not added yet') ? s.name : '';
  if (dobPicker) dobPicker.setDate(s.dob || null);
  document.getElementById('ob-blood').value = s.bloodType || '';
  document.getElementById('ob-weight-value').value = s.weightValue != null ? s.weightValue : '';
  document.getElementById('ob-weight-unit').value = s.weightUnit || 'lbs';
  document.getElementById('ob-allergies').value = s.allergies || '';
  document.getElementById('ob-conditions').value = s.conditions || '';
  document.getElementById('ob-ins-carrier').value = s.insuranceCarrier || '';
  document.getElementById('ob-ins-policy').value = s.insurancePolicy || '';
  document.getElementById('ob-ins-group').value = s.insuranceGroup || '';

  const primary = emergencyContacts.find(c => c.isPrimary);
  const secondary = emergencyContacts.find(c => !c.isPrimary);
  document.getElementById('ob-c1-name').value = primary ? primary.name : '';
  document.getElementById('ob-c1-code').value = primary ? primary.countryCode : '+961';
  document.getElementById('ob-c1-phone').value = primary ? primary.phone : '';
  document.getElementById('ob-c2-name').value = secondary ? secondary.name : '';
  document.getElementById('ob-c2-code').value = secondary ? secondary.countryCode : '+961';
  document.getElementById('ob-c2-phone').value = secondary ? secondary.phone : '';

  document.getElementById('onboarding-screen').style.display = 'flex';
  obGoToStep(3);
}

function greetingPrefix() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function enterApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('onboarding-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('fab').style.display = 'flex';
  document.getElementById('header-badge').textContent = currentFamily ? currentFamily.name : '';
  document.getElementById('greeting-text').textContent = greetingPrefix() + ', ' + currentUser.firstName;
  document.getElementById('settings-account-name').textContent = currentUser.fullName;
  document.getElementById('settings-account-email').textContent = currentUser.email;
  document.getElementById('settings-account-role').textContent = roleLabel(currentUser.role);
  goTo('home');
}
function roleLabel(role) {
  if (role === 'primary_caregiver') return 'Primary caregiver';
  if (role === 'family_member') return 'Family member';
  return 'Member';
}

async function attemptSessionRestore() {
  let savedToken;
  try { savedToken = localStorage.getItem(AUTH_TOKEN_KEY); } catch { savedToken = null; }
  if (!savedToken) return;
  authToken = savedToken;
  try {
    applyBootstrap(await callApi('bootstrap'));
    enterApp();
  } catch (err) {
    clearAuthToken();
  } finally {
    document.getElementById('session-restore-screen').classList.remove('show');
  }
}

let inviteToken = null;
async function startApp() {
  const params = new URLSearchParams(window.location.search);
  inviteToken = params.get('invite');
  if (inviteToken) {
    try {
      await showJoinFamilyScreen(inviteToken);
    } catch (err) {
      showToast(err.message);
      document.getElementById('auth-screen').style.display = 'flex';
    } finally {
      document.getElementById('session-restore-screen').classList.remove('show');
    }
  } else {
    let hasSession = false;
    try { hasSession = !!localStorage.getItem(AUTH_TOKEN_KEY); } catch {}
    // Nothing to restore: wake the (possibly cold) backend now, while the
    // person is still typing, so sign-up isn't the first request to hit it.
    if (!hasSession) { try { fetch(API_ENDPOINT, { mode: 'no-cors' }).catch(() => {}); } catch {} }
    await attemptSessionRestore();
  }
}
// Looks up an invite code and, if valid, populates and shows the "join
// family" screen. Throws on an invalid/expired/already-used code so
// callers can decide how to surface that (a toast + fallback to login on
// page load, vs. an inline error in the "enter code" modal).
async function showJoinFamilyScreen(token) {
  const info = await callApi('getInviteInfo', { token });
  inviteToken = token;
  document.getElementById('join-family-subtitle').textContent = `You've been invited to join "${info.familyName}"`;
  document.getElementById('join-name').value = info.name;
  document.getElementById('join-email').value = info.email;
  document.getElementById('join-family-screen').style.display = 'flex';
}
let joinSubmitInFlight = false;
async function submitJoinFamily() {
  if (joinSubmitInFlight) return;
  const password = document.getElementById('join-password').value;
  const confirm = document.getElementById('join-confirm').value;
  const errEl = document.getElementById('join-error');
  errEl.classList.remove('show');
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; errEl.classList.add('show'); return; }
  if (password !== confirm) { errEl.textContent = 'Passwords do not match'; errEl.classList.add('show'); return; }

  joinSubmitInFlight = true;
  const btn = document.getElementById('join-submit-btn');
  btn.disabled = true;
  try {
    const data = await callApi('signupViaInvite', { token: inviteToken, password });
    saveAuthToken(data.token);
    currentUser = data.user;
    currentFamily = data.family;
    document.getElementById('join-family-screen').style.display = 'none';
    await loadAppData();
    enterApp();
    showToast(`Welcome to ${currentFamily ? currentFamily.name : 'the family'}!`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    joinSubmitInFlight = false;
    btn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════
   LOADING EVERYTHING AFTER LOGIN/SIGNUP
═══════════════════════════════════════════════════════════ */
function applyBootstrap(d) {
  currentUser = d.user;
  currentFamily = d.family;
  medications = d.medications || [];
  medConfirmations = d.confirmations || [];
  appointments = (d.appointments || []).map(apptFromApi);
  caregiverShifts = d.coverage || {};
  feedPosts = d.feed || [];
  healthSummary = d.healthSummary || null;
  emergencyContacts = d.contacts || [];
  familyMembers = (d.familyInfo && d.familyInfo.members) || [];
  pendingInvites = (d.familyInfo && d.familyInfo.pendingInvites) || [];

  renderSettingsFamilyInfo();
  renderMedsScreen();
  renderHomeMeds();
  renderEmergencyMeds();
  renderCoverage();
  renderApptList();
  renderNextAppt();
  renderCal();
  renderFeed();
  renderEmergencyCard();
  document.getElementById('home-alert-banner').style.display = 'none';
}

// One request returns everything (it used to be 8 separate ones).
async function loadAppData() {
  applyBootstrap(await callApi('bootstrap'));
}

async function loadEmergencyCardData() {
  const [summary, contacts] = await Promise.all([
    callApi('getHealthSummary'),
    callApi('getEmergencyContacts'),
  ]);
  healthSummary = summary || null;
  emergencyContacts = contacts || [];
  renderEmergencyCard();
}

/* ══════════════════════════════════════════════════════════
   EMERGENCY CARD
═══════════════════════════════════════════════════════════ */
let healthSummary = null;
let emergencyContacts = [];

function renderEmergencyCard() {
  const s = healthSummary;
  document.getElementById('em-name').textContent = s ? s.name : 'Not added yet';

  let dobLabel = 'Date of birth not added';
  if (s && s.dob) {
    const d = new Date(s.dob + 'T00:00:00');
    const age = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
    dobLabel = 'Born ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + ' • Age ' + age;
  }
  document.getElementById('em-dob').textContent = dobLabel;
  document.getElementById('em-blood').textContent = (s && s.bloodType) || '—';
  document.getElementById('em-weight').textContent = (s && s.weightValue) ? `${s.weightValue} ${s.weightUnit}` : '—';

  const allergyBox = document.getElementById('em-allergies');
  const allergyList = (s && s.allergies) ? s.allergies.split(',').map(a => a.trim()).filter(Boolean) : [];
  allergyBox.innerHTML = allergyList.length
    ? allergyList.map(a => `<span class="em-allergy-chip">${a}</span>`).join('')
    : '<span style="font-size:14px;opacity:0.7;">None recorded</span>';

  document.getElementById('em-conditions').textContent = (s && s.conditions) || 'None recorded';

  const contactsBox = document.getElementById('em-contacts');
  contactsBox.innerHTML = emergencyContacts.length
    ? emergencyContacts.map(c => `<div class="em-row"><span class="em-row-label">${c.name}</span><span class="em-row-value" style="color:var(--sage);">${c.countryCode} ${c.phone}</span></div>`).join('')
    : '<div class="em-row"><span class="em-row-label">No contacts added yet</span></div>';

  document.getElementById('em-ins-carrier').textContent = (s && s.insuranceCarrier) || '—';
  document.getElementById('em-ins-policy').textContent = (s && s.insurancePolicy) || '—';
  document.getElementById('em-ins-group').textContent = (s && s.insuranceGroup) || '—';
}

/* ══════════════════════════════════════════════════════════
   MEDICATIONS
═══════════════════════════════════════════════════════════ */
let medications = [];
let medConfirmations = [];
let obEndDatePicker = null;
let medEndDatePicker = null;

function initDatePickers() {
  const commonOpts = {
    altInput: true,
    altInputClass: 'form-input date-field-input',
    altFormat: 'M j, Y',
    dateFormat: 'Y-m-d',
    allowInput: false,
    disableMobile: true,
    monthSelectorType: 'static',
    prevArrow: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='15 18 9 12 15 6'/></svg>",
    nextArrow: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='9 18 15 12 9 6'/></svg>",
  };
  obEndDatePicker = flatpickr('#ob-med-end-date', commonOpts);
  medEndDatePicker = flatpickr('#med-end-date-input', commonOpts);
  dobPicker = flatpickr('#ob-dob', Object.assign({}, commonOpts, { maxDate: 'today' }));
  apptDatePicker = flatpickr('#appt-date-input', commonOpts);
  apptTimePicker = makeTimePicker(document.getElementById('appt-time-input'), true);
}

let dobPicker = null;
let apptDatePicker = null;
let apptTimePicker = null;
function attachTimePicker(input) {
  return makeTimePicker(input, false);
}
const pad2 = n => String(n).padStart(2, '0');
/* Time field = three of the app's own dropdown pills (hour / minute / AM-PM).
   The hidden <input> keeps the 24h "HH:MM" value so all existing code that
   reads it keeps working. `optional` adds a "--" blank choice. */
function makeTimePicker(input, optional) {
  const row = document.createElement('div');
  row.className = 'tp-row';
  function mkSel(options) {
    const s = document.createElement('select');
    s.className = 'form-input';
    s.style.flex = '1';
    (optional ? [['', '--']] : []).concat(options).forEach(([v, l]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = l; s.appendChild(o);
    });
    return s;
  }
  const hour = mkSel(Array.from({ length: 12 }, (_, i) => [String(i + 1), pad2(i + 1)]));
  const min = mkSel(Array.from({ length: 12 }, (_, i) => [pad2(i * 5), pad2(i * 5)]));
  const ap = mkSel([['AM', 'AM'], ['PM', 'PM']]);
  row.append(hour, min, ap);
  input.insertAdjacentElement('afterend', row);

  function write() {
    if (hour.value === '') { input.value = ''; return; }
    let h = parseInt(hour.value, 10) % 12;
    if ((ap.value || 'AM') === 'PM') h += 12;
    input.value = pad2(h) + ':' + (min.value || '00');
  }
  function set(v) {
    if (!v) {
      hour.value = ''; min.value = ''; ap.value = '';
      if (!optional) { hour.value = '8'; min.value = '00'; ap.value = 'AM'; }
      write();
      return;
    }
    const [hh, mm] = v.split(':').map(Number);
    hour.value = String(hh % 12 === 0 ? 12 : hh % 12);
    min.value = pad2((Math.round(mm / 5) * 5) % 60);
    ap.value = hh >= 12 ? 'PM' : 'AM';
    write();
  }
  set(input.value || (optional ? '' : '08:00'));
  [hour, min, ap].forEach(s => { enhanceSelect(s); s.addEventListener('change', write); });
  const api = { set, clear: () => set(''), destroy: () => row.remove() };
  input._tp = api;
  return api;
}
function destroyPickersIn(container) {
  container.querySelectorAll('input').forEach(el => { if (el._flatpickr) el._flatpickr.destroy(); });
}
function removeTimeRow(btn) {
  const row = btn.parentElement;
  destroyPickersIn(row);
  row.remove();
}

function dateKeyInTimezone(tz, dateObj) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateObj);
}
function isConfirmedToday(medId, timeSlot) {
  const tz = getStoredTimezone();
  const todayKey = dateKeyInTimezone(tz, new Date());
  return medConfirmations.some(c => c.medicationId === medId && c.timeSlot === timeSlot && dateKeyInTimezone(tz, new Date(c.confirmedAt)) === todayKey);
}

function bucketForTime(time) {
  if (time.indexOf('AM') !== -1) return 'Morning';
  if (time.indexOf('PM') !== -1) {
    const hour = parseInt(time, 10);
    return (hour >= 5 && hour !== 12) ? 'Evening' : 'Afternoon';
  }
  return 'Other';
}

function isMedExpired(m) {
  if (!m.endDate) return false;
  return new Date(m.endDate + 'T23:59:59').getTime() < Date.now();
}
function medEndDateLabel(m) {
  if (!m.endDate) return '';
  const label = new Date(m.endDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return isMedExpired(m) ? 'Course ended ' + label : 'Until ' + label;
}
function medCardHTML(m) {
  const chips = m.times.map(t => `<span class="time-chip">${t}</span>`).join('');
  const firstTime = m.times[0];
  const done = isConfirmedToday(m.id, firstTime);
  return `
    <div class="med-card" id="med-${m.id}">
      <div class="med-card-header">
        <div class="med-card-icon">💊</div>
        <div class="med-card-info">
          <div class="med-card-name">${m.name}</div>
          <div class="med-card-dose">${m.dose}${m.reason ? ' &bull; ' + m.reason : ''}</div>
          <div class="med-card-reason">${m.pharmacy || 'Pharmacy not set'}</div>
          ${m.endDate ? `<div class="med-card-reason" style="color:${isMedExpired(m) ? 'var(--red)' : 'var(--amber)'};font-weight:600;">${medEndDateLabel(m)}</div>` : ''}
        </div>
      </div>
      <div class="med-card-footer">
        <div class="med-times">${chips}</div>
        <button class="take-btn${done ? ' done' : ''}" ${done ? 'disabled' : ''} onclick="confirmMed('${m.id}', '${firstTime}', this)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          ${done ? 'Confirmed' : 'Taken'}
        </button>
      </div>
    </div>`;
}

function renderMedsScreen() {
  const box = document.getElementById('meds-dynamic');
  const seniorName = (healthSummary && healthSummary.name && healthSummary.name !== 'Not added yet') ? healthSummary.name : 'Your family member';
  document.getElementById('meds-subtitle').textContent = seniorName + ' • ' + medications.length + (medications.length === 1 ? ' active' : ' active');
  document.getElementById('meds-adherence').textContent = '—';

  if (!medications.length) {
    box.innerHTML = `
      <div class="card" style="text-align:center;padding:32px 20px;">
        <div style="font-size:15px;color:var(--text-secondary);margin-bottom:14px;">No medications added yet.</div>
        <button class="btn btn-primary" onclick="document.getElementById('med-modal').classList.add('open')">+ Add</button>
      </div>
      <div style="height:16px;"></div>`;
    return;
  }
  const buckets = { Morning: [], Afternoon: [], Evening: [], Other: [] };
  medications.forEach(m => buckets[bucketForTime(m.times[0])].push(m));
  let html = '';
  ['Morning','Afternoon','Evening','Other'].forEach(b => {
    if (!buckets[b].length) return;
    html += `<div class="section-label">${b}</div>`;
    buckets[b].forEach(m => html += medCardHTML(m));
  });
  html += '<div style="height:16px;"></div>';
  box.innerHTML = html;
}

function renderHomeMeds() {
  const box = document.getElementById('home-meds-card');
  document.getElementById('stat-med-count').textContent = medications.length;
  document.getElementById('stat-med-sub').innerHTML = medications.length
    ? `<span class="stat-dot" style="background:var(--sage)"></span>${medications.length} scheduled today`
    : 'Tap to add medications';

  if (!medications.length) {
    box.innerHTML = `<div style="padding:8px 0;font-size:14px;color:var(--text-secondary);text-align:center;">No medications added yet.<br><button onclick="document.getElementById('med-modal').classList.add('open')" style="background:none;border:none;color:var(--sage);font-weight:700;cursor:pointer;font-family:var(--font);margin-top:4px;">+ Add a medication</button></div>`;
    return;
  }
  box.innerHTML = medications.slice(0, 4).map(m => `
    <div class="med-item">
      <div class="med-icon med-icon-sage">💊</div>
      <div class="med-info">
        <div class="med-name">${m.name} ${m.dose}</div>
        <div class="med-dose">${m.reason || 'Scheduled'}</div>
      </div>
      <div>
        <span class="pill pill-amber"><span class="pill-dot"></span>Due ${m.times[0]}</span>
      </div>
    </div>`).join('');
}

function renderEmergencyMeds() {
  const box = document.getElementById('em-current-meds');
  if (!medications.length) {
    box.innerHTML = `<div class="em-row"><span class="em-row-label">No medications added yet</span></div>`;
    return;
  }
  box.innerHTML = medications.map(m =>
    `<div class="em-row"><span class="em-row-label">${m.name}</span><span class="em-row-value">${m.dose} — ${m.times.length > 1 ? m.times.length + 'x daily' : 'once daily'}</span></div>`
  ).join('');
}

async function confirmMed(id, timeSlot, btn) {
  try {
    const confirmation = await callApi('confirmMedication', { id, timeSlot });
    medConfirmations.push(confirmation);
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Confirmed';
    btn.classList.add('done');
    btn.disabled = true;
    showToast('✓ Medication confirmed');
  } catch (err) {
    showToast(err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   APPOINTMENTS + CALENDAR
═══════════════════════════════════════════════════════════ */
let appointments = [];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let calYear = 2026, calMonth = 8;

function apptFromApi(a) {
  const d = new Date(a.date + 'T00:00:00');
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    id: a.id, title: a.title,
    dateKey: d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(),
    dateLabel: dayNames[d.getDay()] + ' ' + monNames[d.getMonth()] + ' ' + d.getDate(),
    time: a.time, provider: a.provider, location: a.location, notes: a.notes, who: a.who,
  };
}

function eventItemHTML(a) {
  return `
    <div class="event-item" id="row-${a.id}">
      <div class="event-time-col">
        <div class="event-time">${a.time}</div>
        <div class="event-date-s">${a.dateLabel}</div>
      </div>
      <div class="event-bar event-bar-sage"></div>
      <div class="event-body">
        <div class="event-title">${a.title}</div>
        <div class="event-sub">${[a.provider, a.location].filter(Boolean).join(' &bull; ')}</div>
        ${a.notes ? `<div class="event-note">${a.notes}</div>` : ''}
        <button class="btn btn-danger btn-sm" style="margin-top:10px;width:auto;" onclick="cancelAppointment('${a.id}')">Cancel</button>
      </div>
    </div>`;
}

function sortedAppointments() {
  return [...appointments].sort((a, b) => new Date(a.dateKey.split('-').join('/')) - new Date(b.dateKey.split('-').join('/')));
}

function renderApptList() {
  const box = document.getElementById('events-list');
  if (!appointments.length) {
    box.innerHTML = `<div style="padding:24px 20px;text-align:center;font-size:14px;color:var(--text-muted);">No upcoming appointments.</div>`;
    return;
  }
  box.innerHTML = sortedAppointments().map(eventItemHTML).join('');
}

function renderNextAppt() {
  document.getElementById('stat-appt-count').textContent = appointments.length;
  const box = document.getElementById('home-next-appt');
  if (!appointments.length) {
    document.getElementById('stat-appt-sub').textContent = 'No appointments yet';
    box.innerHTML = `<div style="text-align:center;padding:12px 0;font-size:14px;color:var(--text-muted);width:100%;">No upcoming appointments</div>`;
    return;
  }
  const next = sortedAppointments()[0];
  document.getElementById('stat-appt-sub').innerHTML = `<span class="stat-dot" style="background:var(--sage)"></span>${next.title}`;
  const [, mon, day] = next.dateKey.split('-');
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dow = new Date(next.dateKey.split('-').join('/')).getDay();
  box.innerHTML = `
    <div>
      <div class="t-title" style="font-size:18px;color:var(--navy);">${next.title}</div>
      <div style="font-size:14px;color:var(--text-secondary);margin-top:4px;">${[next.provider, next.time].filter(Boolean).join(' &bull; ')}</div>
      ${next.location ? `<div style="font-size:14px;color:var(--text-muted);margin-top:2px;">${next.location}</div>` : ''}
      ${next.notes ? `<div style="margin-top:10px;font-size:13px;color:var(--amber);font-weight:600;">Reminder: ${next.notes}</div>` : ''}
      <button class="btn btn-danger btn-sm" style="margin-top:12px;width:auto;" onclick="cancelAppointment('${next.id}')">Cancel</button>
    </div>
    <div style="text-align:right;flex-shrink:0;margin-left:12px;">
      <div class="t-title" style="font-size:22px;color:var(--navy);">${dayNames[dow]}</div>
      <div style="font-size:13px;color:var(--text-muted);">${MONTHS[parseInt(mon,10)-1].slice(0,3)} ${day}</div>
    </div>`;
}

async function cancelAppointment(id) {
  try {
    await callApi('deleteAppointment', { id });
    appointments = appointments.filter(a => a.id !== id);
    closeApptDetailModal();
    renderCal();
    renderApptList();
    renderNextAppt();
    showToast('Appointment canceled');
  } catch (err) {
    showToast(err.message);
  }
}

function renderCal() {
  document.getElementById('cal-month-label').textContent = MONTHS[calMonth] + ' ' + calYear;
  const grid = document.getElementById('cal-grid');
  const headers = Array.from(grid.children).slice(0, 7);
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  const today = new Date();
  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const el = document.createElement('div');
    const isToday = today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === d;
    const key = calYear + '-' + (calMonth + 1) + '-' + d;
    const dayAppts = appointments.filter(a => a.dateKey === key);
    el.className = 'cal-day' + (isToday ? ' today' : '') + (dayAppts.length ? ' has-event' : '');
    el.textContent = d;
    el.onclick = () => {
      grid.querySelectorAll('.cal-day').forEach(c => { if (!c.classList.contains('today')) c.classList.remove('selected'); });
      el.classList.add('selected');
      if (dayAppts.length) openApptDetailModal(key);
    };
    if (dayAppts.length) {
      el.onmouseenter = () => showCalDayPopover(el, dayAppts);
      el.onmouseleave = hideCalDayPopover;
    }
    grid.appendChild(el);
  }
}

function showCalDayPopover(el, dayAppts) {
  const pop = document.getElementById('cal-day-popover');
  const shown = dayAppts.slice(0, 2);
  const extra = dayAppts.length - shown.length;
  pop.innerHTML = shown.map(a => `
    <div class="cal-day-popover-title">${a.title}</div>
    <div class="cal-day-popover-time">${a.time}${a.provider ? ' &bull; ' + a.provider : ''}</div>
  `).join('<div style="height:6px;"></div>') + (extra > 0 ? `<div class="cal-day-popover-time" style="margin-top:4px;">+${extra} more</div>` : '');

  const rect = el.getBoundingClientRect();
  const showBelow = rect.top < 90; // not enough room above near the top of the screen
  pop.classList.toggle('below', showBelow);
  pop.style.left = (rect.left + rect.width / 2) + 'px';
  pop.style.top = (showBelow ? rect.bottom : rect.top) + 'px';
  requestAnimationFrame(() => pop.classList.add('show'));
}

function hideCalDayPopover() {
  document.getElementById('cal-day-popover').classList.remove('show');
}

function openApptDetailModal(key) {
  const items = appointments.filter(a => a.dateKey === key);
  if (!items.length) return;
  const d = new Date(key.split('-').join('/'));
  document.getElementById('appt-detail-title').textContent =
    d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('appt-detail-body').innerHTML = items.map(a => `
    <div class="appt-detail-item">
      <div class="appt-detail-title">${a.title}</div>
      <div class="appt-detail-meta">${[a.time, a.provider].filter(Boolean).join(' • ')}</div>
      ${a.location ? `<div class="appt-detail-meta">${a.location}</div>` : ''}
      ${a.notes ? `<div class="appt-detail-note">${a.notes}</div>` : ''}
      ${a.who ? `<div class="appt-detail-meta">${a.who} is taking them</div>` : ''}
      <button class="btn btn-danger btn-sm" style="margin-top:12px;width:auto;" onclick="cancelAppointment('${a.id}')">Cancel</button>
    </div>`).join('');
  document.getElementById('appt-detail-modal').classList.add('open');
}
function closeApptDetailModal() {
  document.getElementById('appt-detail-modal').classList.remove('open');
}

function changeMonth(dir) {
  closeApptDetailModal();
  calMonth += dir;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  if (calMonth < 0)  { calMonth = 11; calYear--; }
  renderCal();
}

/* ══════════════════════════════════════════════════════════
   FAMILY FEED
═══════════════════════════════════════════════════════════ */
let feedPosts = [];

function feedPostHTML(post) {
  const initial = (post.user ? post.user.firstName : '?').charAt(0).toUpperCase();
  const when = new Date(post.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const comments = (post.comments || []).map(c => `
    <div class="feed-comment">
      <div class="comment-avatar" style="background:${colorForPerson(c.user ? c.user.firstName : '?')}">${(c.user ? c.user.firstName : '?').charAt(0).toUpperCase()}</div>
      <div class="comment-bubble">
        <div class="comment-who">${c.user ? c.user.firstName : 'Someone'}</div>
        <div class="comment-text">${c.content}</div>
      </div>
    </div>`).join('');
  return `
    <div class="feed-item" id="post-${post.id}">
      <div class="feed-header">
        <div class="feed-avatar" style="background:${colorForPerson(post.user ? post.user.firstName : '?')}">${initial}</div>
        <div class="feed-meta">
          <div class="feed-who">${post.user ? post.user.firstName : 'Someone'}${post.user && post.user.id === currentUser.id ? ' (you)' : ''}</div>
          <div class="feed-when">${when}</div>
        </div>
      </div>
      <div class="feed-content">
        <span class="feed-tag">${post.tag}</span><br>${post.content}
      </div>
      <div class="feed-actions">
        <button class="feed-action-btn" onclick="showToast('❤️ Reaction added')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          React
        </button>
        <button class="feed-action-btn" onclick="openComment('${post.id}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Comment
        </button>
      </div>
      ${comments ? `<div class="feed-comments">${comments}</div>` : ''}
    </div>`;
}

function renderFeed() {
  const box = document.getElementById('feed-list');
  if (!feedPosts.length) {
    box.innerHTML = `<div class="card" style="text-align:center;padding:32px 20px;"><div style="font-size:15px;color:var(--text-secondary);">No posts yet. Share an update with your family.</div></div>`;
    return;
  }
  box.innerHTML = feedPosts.map(feedPostHTML).join('');
}

let activeCommentPostId = null;
function openComment(postId) {
  activeCommentPostId = postId || null;
  document.getElementById('modal-title').textContent = activeCommentPostId ? 'Add comment' : 'New post';
  document.getElementById('post-modal').classList.add('open');
}
function closeModal() { document.getElementById('post-modal').classList.remove('open'); }

async function submitPost() {
  const text = document.getElementById('post-text').value.trim();
  const tag = document.getElementById('post-tag').value;
  if (!text) { showToast('Write something first'); return; }

  try {
    if (activeCommentPostId) {
      await callApi('addComment', { postId: activeCommentPostId, content: text });
    } else {
      await callApi('addPost', { tag, content: text });
    }
    feedPosts = await callApi('getFeed');
    renderFeed();
    document.getElementById('post-text').value = '';
    closeModal();
    showToast(activeCommentPostId ? 'Comment added' : 'Posted to family feed');
  } catch (err) {
    showToast(err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   ADD MEDICATION MODAL (Meds tab)
═══════════════════════════════════════════════════════════ */
function closeMedModal() {
  document.getElementById('med-modal').classList.remove('open');
}
function addMedTimeRow(value) {
  const list = document.getElementById('med-times-list');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
  row.innerHTML = `
    <input type="hidden" value="${value || '08:00'}" data-med-time />
    <button type="button" class="ob-med-remove" onclick="removeTimeRow(this)" aria-label="Remove time">&#x2715;</button>
  `;
  list.appendChild(row);
  attachTimePicker(row.querySelector('input'));
}
function resetMedTimeRows() {
  const list = document.getElementById('med-times-list');
  if (!list) return;
  destroyPickersIn(list);
  list.innerHTML = '';
  addMedTimeRow('08:00');
}

let medSubmitInFlight = false;
async function submitMed() {
  if (medSubmitInFlight) return;
  const name = document.getElementById('med-name-input').value.trim();
  const doseInput = document.getElementById('med-dose-input').value.trim();
  const reason = document.getElementById('med-reason-input').value.trim();
  const pharmacy = document.getElementById('med-pharmacy-input').value.trim();
  const endDate = document.getElementById('med-end-date-input').value;

  if (!name) { showToast('Enter a medication name'); return; }
  const doseNum = parseFloat(doseInput);
  if (!doseInput || isNaN(doseNum) || doseNum <= 0) { showToast('Enter a valid dosage in mg'); return; }
  const times = Array.from(document.querySelectorAll('#med-times-list [data-med-time]'))
    .map(el => el.value).filter(Boolean).map(to12HourLabel);
  if (!times.length) { showToast('Add at least one reminder time'); return; }

  medSubmitInFlight = true;
  const btn = document.getElementById('med-submit-btn');
  btn.disabled = true;
  try {
    await callApi('addMedication', { name, doseValueMg: doseNum, times, reason: reason || undefined, pharmacy: pharmacy || undefined, endDate: endDate || undefined });
    medications = await callApi('getMedications');
    renderMedsScreen();
    renderHomeMeds();
    renderEmergencyMeds();
    ['med-name-input','med-dose-input','med-reason-input','med-pharmacy-input'].forEach(id => { document.getElementById(id).value = ''; });
    if (medEndDatePicker) medEndDatePicker.clear();
    resetMedTimeRows();
    closeMedModal();
    showToast('Medication added');
  } catch (err) {
    showToast(err.message);
  } finally {
    medSubmitInFlight = false;
    btn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════
   ADD APPOINTMENT MODAL (Calendar tab)
═══════════════════════════════════════════════════════════ */
function closeApptModal() {
  document.getElementById('appt-modal').classList.remove('open');
}

let fpRequestInFlight = false;
let fpResetInFlight = false;
function openForgotPasswordModal() {
  document.getElementById('fp-email').value = document.getElementById('login-email').value.trim();
  showForgotPasswordStage('request');
  document.getElementById('forgot-password-modal').classList.add('open');
}
function closeForgotPasswordModal() {
  document.getElementById('forgot-password-modal').classList.remove('open');
}

function openInviteCodeModal() {
  document.getElementById('invite-code-input').value = '';
  document.getElementById('invite-code-error').classList.remove('show');
  document.getElementById('invite-code-modal').classList.add('open');
}
function closeInviteCodeModal() {
  document.getElementById('invite-code-modal').classList.remove('open');
}
let inviteCodeSubmitInFlight = false;
async function submitInviteCode() {
  if (inviteCodeSubmitInFlight) return;
  const code = document.getElementById('invite-code-input').value.trim();
  const errEl = document.getElementById('invite-code-error');
  errEl.classList.remove('show');
  if (!code) { errEl.textContent = 'Paste the code from your invite email'; errEl.classList.add('show'); return; }

  inviteCodeSubmitInFlight = true;
  const btn = document.getElementById('invite-code-submit-btn');
  btn.disabled = true;
  try {
    await showJoinFamilyScreen(code);
    closeInviteCodeModal();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    inviteCodeSubmitInFlight = false;
    btn.disabled = false;
  }
}
function showForgotPasswordStage(stage) {
  document.getElementById('fp-stage-request').style.display = stage === 'request' ? 'block' : 'none';
  document.getElementById('fp-stage-reset').style.display = stage === 'reset' ? 'block' : 'none';
  document.getElementById('fp-error').classList.remove('show');
  document.getElementById('fp-code').value = '';
  document.getElementById('fp-new-password').value = '';
  updateForgotPasswordHint();
}
function showFpError(msg) {
  const el = document.getElementById('fp-error');
  el.textContent = msg;
  el.classList.add('show');
}
async function submitForgotPasswordRequest() {
  if (fpRequestInFlight) return;
  const email = document.getElementById('fp-email').value.trim();
  if (!validEmail(email)) { showFpError('Enter a valid email address'); return; }
  fpRequestInFlight = true;
  const btn = document.getElementById('fp-request-btn');
  btn.disabled = true;
  try {
    await callApi('requestPasswordReset', { email });
    showForgotPasswordStage('reset');
    showToast('If that email has an account, a code is on its way');
  } catch (err) {
    showFpError(err.message);
  } finally {
    fpRequestInFlight = false;
    btn.disabled = false;
  }
}
async function submitPasswordReset() {
  if (fpResetInFlight) return;
  const email = document.getElementById('fp-email').value.trim();
  const code = document.getElementById('fp-code').value.trim();
  const newPassword = document.getElementById('fp-new-password').value;
  if (!code) { showFpError('Enter the code from your email'); return; }
  if (newPassword.length < 6) { showFpError('Password must be at least 6 characters'); return; }
  fpResetInFlight = true;
  const btn = document.getElementById('fp-reset-btn');
  btn.disabled = true;
  try {
    await callApi('resetPassword', { email, code, newPassword });
    closeForgotPasswordModal();
    document.getElementById('login-email').value = email;
    document.getElementById('login-password').value = '';
    showToast('Password reset — log in with your new password');
  } catch (err) {
    showFpError(err.message);
  } finally {
    fpResetInFlight = false;
    btn.disabled = false;
  }
}
async function submitAppt() {
  const title = document.getElementById('appt-title-input').value.trim();
  const dateVal = document.getElementById('appt-date-input').value;
  const timeVal = document.getElementById('appt-time-input').value;
  const provider = document.getElementById('appt-provider-input').value.trim();
  const notes = document.getElementById('appt-notes-input').value.trim();
  const who = document.getElementById('appt-who-input').value;

  if (!title) { showToast('Enter an appointment title'); return; }
  if (!dateVal) { showToast('Pick a date'); return; }

  const timeLabel = timeVal
    ? new Date('1970-01-01T' + timeVal).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : undefined;

  try {
    const created = await callApi('addAppointment', { title, date: dateVal, time: timeLabel, provider: provider || undefined, notes: notes || undefined, who: who !== 'TBD' ? who : undefined });
    appointments.push(apptFromApi(created));
    renderCal();
    renderApptList();
    renderNextAppt();
    ['appt-title-input','appt-provider-input','appt-notes-input'].forEach(id => { document.getElementById(id).value = ''; });
    if (apptDatePicker) apptDatePicker.clear();
    if (apptTimePicker) apptTimePicker.clear();
    closeApptModal();
    showToast('Appointment added to calendar');
  } catch (err) {
    showToast(err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════════════ */
function openSettings()  {
  document.getElementById('settings-modal').classList.add('open');
  populateTimezoneSelect();
  document.getElementById('reminders-toggle').classList.toggle('on', remindersEnabled());
}
function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }

/* ══════════════════════════════════════════════════════════
   MEDICATION REMINDERS — Notification API, only while this
   tab is open (no service worker, so nothing fires once the
   tab or browser is closed — that needs real hosting + push
   infrastructure this single-file app doesn't have).
═══════════════════════════════════════════════════════════ */
const TIMEZONE_KEY = 'careCircleTimezone';
const REMINDERS_KEY = 'careCircleRemindersEnabled';

function getStoredTimezone() {
  try {
    return localStorage.getItem(TIMEZONE_KEY) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch { return 'UTC'; }
}
function setTimezone(tz) {
  try { localStorage.setItem(TIMEZONE_KEY, tz); } catch {}
  showToast('Timezone set to ' + tz.replace(/_/g, ' '));
}
function remindersEnabled() {
  try { return localStorage.getItem(REMINDERS_KEY) === 'true'; } catch { return false; }
}
function populateTimezoneSelect() {
  const select = document.getElementById('timezone-select');
  if (select.options.length) { select.value = getStoredTimezone(); return; } // already populated once
  let zones;
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = null; }
  if (!zones || !zones.length) {
    zones = ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Sao_Paulo',
      'Europe/London','Europe/Paris','Europe/Berlin','Africa/Cairo','Asia/Beirut','Asia/Dubai','Asia/Kolkata',
      'Asia/Shanghai','Asia/Tokyo','Australia/Sydney'];
  }
  // The detected/stored zone might not be in that list (e.g. "UTC" itself
  // is often missing from Intl.supportedValuesOf) — always guarantee it's
  // selectable so the dropdown never ends up blank.
  const current = getStoredTimezone();
  if (!zones.includes('UTC')) zones = ['UTC'].concat(zones);
  if (!zones.includes(current)) zones = [current].concat(zones);
  select.innerHTML = zones.map(z => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');
  select.value = current;
}

async function toggleMedReminders() {
  const turningOn = !remindersEnabled();
  if (turningOn) {
    if (typeof Notification === 'undefined') {
      showToast('Notifications aren’t supported in this browser');
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notifications were blocked — allow them in your browser settings to enable reminders');
      return;
    }
  }
  try { localStorage.setItem(REMINDERS_KEY, String(turningOn)); } catch {}
  document.getElementById('reminders-toggle').classList.toggle('on', turningOn);
  showToast(turningOn ? 'Reminders on — keep this tab open to receive them' : 'Reminders off');
}

function timeLabelToMinutes(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((label || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const period = m[3].toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}
function nowMinutesInTimezone(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const min = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return (h % 24) * 60 + min;
}
function todayKeyInTimezone(tz) {
  return dateKeyInTimezone(tz, new Date());
}

function checkMedicationReminders() {
  if (!remindersEnabled()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!medications || !medications.length) return;
  const tz = getStoredTimezone();
  const nowMin = nowMinutesInTimezone(tz);
  const todayKey = todayKeyInTimezone(tz);
  medications.forEach((m) => {
    if (isMedExpired(m)) return;
    (m.times || []).forEach((timeLabel) => {
      const dueMin = timeLabelToMinutes(timeLabel);
      if (dueMin === null) return;
      fireReminderIfDue(m, timeLabel, dueMin, nowMin, todayKey, 'soon', 10);
      fireReminderIfDue(m, timeLabel, dueMin, nowMin, todayKey, 'due', 0);
    });
  });
}
function fireReminderIfDue(m, timeLabel, dueMin, nowMin, todayKey, phase, minutesBefore) {
  if (((dueMin - minutesBefore) + 1440) % 1440 !== nowMin) return;
  const key = 'careCircleNotified:' + todayKey + ':' + m.id + ':' + timeLabel + ':' + phase;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {}
  const title = phase === 'soon' ? m.name + ' due in 10 minutes' : m.name + ' is due now';
  try { new Notification(title, { body: m.dose + ' — scheduled for ' + timeLabel }); } catch {}
}

setInterval(checkMedicationReminders, 30000);

function toggleLargeText() {
  const on = document.documentElement.getAttribute('data-large-text') === 'true';
  document.documentElement.setAttribute('data-large-text', String(!on));
  document.getElementById('large-text-toggle').classList.toggle('on', !on);
  showToast(!on ? 'Large text on' : 'Large text off');
}
function toggleHighContrast() {
  const on = document.documentElement.getAttribute('data-high-contrast') === 'true';
  document.documentElement.setAttribute('data-high-contrast', String(!on));
  document.getElementById('high-contrast-toggle').classList.toggle('on', !on);
  showToast(!on ? 'High contrast on' : 'High contrast off');
}

function logOut() {
  closeSettings();
  closeApptDetailModal();
  clearAuthToken();
  currentUser = null;
  currentFamily = null;
  medications = [];
  appointments = [];
  caregiverShifts = {};
  feedPosts = [];
  healthSummary = null;
  emergencyContacts = [];
  familyMembers = [];
  pendingInvites = [];
  clearOnboardingFields();
  document.getElementById('app').style.display = 'none';
  document.getElementById('fab').style.display = 'none';
  document.getElementById('onboarding-screen').style.display = 'none';
  document.getElementById('plan-screen').style.display = 'none';
  document.getElementById('invite-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  switchAuthTab('login');
  ['login-email','login-password','signup-name','signup-email','signup-password','signup-confirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  hideAuthError('login');
  hideAuthError('signup');
  updateSignupPasswordHint();
  showToast('Logged out');
}

function clearOnboardingFields() {
  lastAddedMedSignature = null;
  ['ob-name','ob-weight-value','ob-allergies','ob-conditions',
   'ob-c1-name','ob-c1-phone','ob-c2-name','ob-c2-phone',
   'ob-ins-carrier','ob-ins-policy','ob-ins-group',
   'ob-med-name','ob-med-dose'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (dobPicker) dobPicker.clear();
  document.getElementById('ob-blood').value = '';
  document.getElementById('ob-weight-unit').value = 'lbs';
  document.getElementById('ob-c1-code').value = '+961';
  document.getElementById('ob-c2-code').value = '+961';
  document.getElementById('ob-med-list').innerHTML = '';
  obResetMedTimeRows();
  ['ob-c1-phone','ob-c2-phone'].forEach(id => document.getElementById(id).classList.remove('input-error'));
  ['ob-c1-phone-error','ob-c2-phone-error'].forEach(id => document.getElementById(id).classList.remove('show'));
}

/* ══════════════════════════════════════════════════════════
   SENIOR MODE
═══════════════════════════════════════════════════════════ */
function switchToSeniorMode() {
  closeSettings();
  document.getElementById('senior-contact-footer').innerHTML = `If you have a question, ask ${currentUser.firstName}`;
  setTimeout(() => document.getElementById('senior-overlay').style.display = 'block', 200);
}
function closeSeniorMode() { document.getElementById('senior-overlay').style.display = 'none'; }
function seniorConfirm(btn) {
  btn.style.background = 'var(--success)';
  btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Done — thank you!';
  btn.disabled = true;
}

/* ══════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════ */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const fadeInStyle = document.createElement('style');
fadeInStyle.textContent = '@keyframes fadeIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }';
document.head.appendChild(fadeInStyle);

/* ══════════════════════════════════════════════════════════
   CUSTOM DROPDOWNS — replaces every native <select>, including the
   open option list (which browsers don't let CSS restyle). The native
   <select> stays in the DOM, hidden, so .value / change handlers and
   programmatic value changes keep working.
═══════════════════════════════════════════════════════════ */
const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const CS_CHEVRON = '<svg class="cs-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
let openCs = null;

function closeCustomSelect() {
  if (!openCs) return;
  openCs.menu.remove();
  openCs.trigger.setAttribute('aria-expanded', 'false');
  openCs.wrap.classList.remove('open');
  openCs = null;
}

function enhanceSelect(select) {
  if (select._cs) return;
  select._cs = true;
  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  if (select.style.flex) wrap.style.flex = select.style.flex;
  if (select.style.width) wrap.style.width = select.style.width;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'cs-label';
  trigger.appendChild(label);
  trigger.insertAdjacentHTML('beforeend', CS_CHEVRON);
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  wrap.appendChild(trigger);
  select.classList.add('cs-native');
  select.tabIndex = -1;

  function refresh() {
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.text : '';
  }
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return nativeSelectValue.get.call(this); },
    set(v) { nativeSelectValue.set.call(this, v); refresh(); },
  });
  new MutationObserver(refresh).observe(select, { childList: true });
  refresh();

  let hi = -1;
  function setHi(i, scroll) {
    if (!openCs) return;
    const items = openCs.menu.children;
    if (!items.length) return;
    hi = Math.max(0, Math.min(items.length - 1, i));
    Array.from(items).forEach((el, n) => el.classList.toggle('hi', n === hi));
    if (scroll) items[hi].scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    select.selectedIndex = i;
    refresh();
    closeCustomSelect();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    trigger.focus();
  }
  function open() {
    closeCustomSelect();
    const menu = document.createElement('div');
    menu.className = 'cs-menu';
    menu.setAttribute('role', 'listbox');
    Array.from(select.options).forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'cs-item' + (i === select.selectedIndex ? ' selected' : '');
      item.setAttribute('role', 'option');
      item.textContent = opt.text;
      item.addEventListener('mousedown', e => e.preventDefault());
      item.addEventListener('click', () => choose(i));
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const r = trigger.getBoundingClientRect();
    menu.style.minWidth = r.width + 'px';
    const h = menu.offsetHeight;
    const below = window.innerHeight - r.bottom;
    const top = (below < h + 12 && r.top > below) ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    menu.style.top = top + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    openCs = { menu, trigger, wrap };
    const sel = menu.querySelector('.selected');
    if (sel) menu.scrollTop = sel.offsetTop - menu.clientHeight / 2 + sel.offsetHeight / 2;
    hi = select.selectedIndex;
    setHi(hi, false);
  }
  trigger.addEventListener('click', () => { openCs && openCs.trigger === trigger ? closeCustomSelect() : open(); });
  trigger.addEventListener('keydown', e => {
    const isOpen = openCs && openCs.trigger === trigger;
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(hi + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(hi - 1, true); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(hi); }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); closeCustomSelect(); }
  });
}

function enhanceAllSelects() {
  document.querySelectorAll('select.form-input').forEach(enhanceSelect);
}
document.addEventListener('mousedown', e => {
  if (openCs && !openCs.menu.contains(e.target) && !openCs.wrap.contains(e.target)) closeCustomSelect();
});
document.addEventListener('scroll', e => {
  if (openCs && !openCs.menu.contains(e.target)) closeCustomSelect();
}, true);
window.addEventListener('resize', closeCustomSelect);

/* ══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});
document.getElementById('login-password').addEventListener('keypress', e => { if (e.key === 'Enter') submitLogin(); });
document.getElementById('signup-confirm').addEventListener('keypress', e => { if (e.key === 'Enter') submitSignup(); });

renderCal();
obResetMedTimeRows();
resetMedTimeRows();
initDatePickers();
enhanceAllSelects();
new MutationObserver(enhanceAllSelects).observe(document.body, { childList: true, subtree: true });
startApp();

// Offline helper + "install to home screen". Only on the hosted https site,
// never when the file is opened straight from a folder.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
