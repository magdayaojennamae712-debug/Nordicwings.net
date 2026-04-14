// ============================================================
// SkyBook — script.js
// Frontend logic: Firebase auth, flight search, Stripe payment,
// bookings dashboard. All "pages" are shown/hidden in the DOM.
// ============================================================

// ── YOUR FIREBASE CONFIG ──────────────────────────────────────
// Replace these values with your own from:
// Firebase Console → Project Settings → Your apps → Web app
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBC6ocYFDsFMxbx8eccxfeUzooG4HitugQ",
  authDomain:        "skybook-30c99.firebaseapp.com",
  projectId:         "skybook-30c99",
  storageBucket:     "skybook-30c99.firebasestorage.app",
  messagingSenderId: "696427827576",
  appId:             "1:696427827576:web:b8f4b32dfefc9902e8388d"
};

// ── YOUR STRIPE PUBLISHABLE KEY ───────────────────────────────
// Get this from: Stripe Dashboard → Developers → API Keys
const STRIPE_PUBLISHABLE_KEY = "pk_test_51TLzxKAcVzPDklFmI7KvmRH5mfEBgFSD8VKpz9b0USzbh4QeSmiAhfyXCBF0PkcTNh791ZpzKDCxFekuKkRTspkN00duTwNGZm";

// ─────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// Stripe instance (for payment elements)
const stripe = Stripe(STRIPE_PUBLISHABLE_KEY);

// ─────────────────────────────────────────────────────────────
// STATE — app-level variables
// ─────────────────────────────────────────────────────────────
let currentUser      = null;    // Firebase user object
let selectedFlight   = null;    // The flight the user clicked on
let searchParams     = {};      // Last search params (for display)
let stripeElements   = null;    // Stripe Elements instance
let cancelBookingId  = null;    // Booking being cancelled

// ─────────────────────────────────────────────────────────────
// AUTH STATE LISTENER
// Fires whenever login state changes (on load, login, logout)
// ─────────────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  currentUser = user;
  updateNavForAuth(user);
});

function updateNavForAuth(user) {
  const navLogin    = document.getElementById('nav-login');
  const navSignup   = document.getElementById('nav-signup');
  const navUser     = document.getElementById('nav-user');
  const navUsername = document.getElementById('nav-username');
  const navDash     = document.getElementById('nav-dashboard');

  if (user) {
    navLogin.style.display    = 'none';
    navSignup.style.display   = 'none';
    navUser.style.display     = 'flex';
    navDash.style.display     = 'inline-flex';
    navUsername.textContent   = user.displayName || user.email.split('@')[0];
  } else {
    navLogin.style.display    = 'inline-flex';
    navSignup.style.display   = 'inline-flex';
    navUser.style.display     = 'none';
    navDash.style.display     = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE NAVIGATION
// ─────────────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Load dashboard data when navigating there
  if (pageId === 'dashboard') loadDashboard();
}

// ─────────────────────────────────────────────────────────────
// TRIP TYPE (one-way / round-trip)
// ─────────────────────────────────────────────────────────────
function setTripType(type) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  document.getElementById('return-group').style.display =
    type === 'round-trip' ? 'flex' : 'none';
}

// ─────────────────────────────────────────────────────────────
// AIRPORT AUTOCOMPLETE
// Calls /api/airports/search with the user's typed keyword
// ─────────────────────────────────────────────────────────────
let autocompleteTimers = {}; // Debounce timers per field

async function autocomplete(field) {
  const inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  const listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  const keyword = inputEl.value.trim();

  if (keyword.length < 2) { listEl.innerHTML = ''; return; }

  // Debounce: wait 300ms before calling the API
  clearTimeout(autocompleteTimers[field]);
  autocompleteTimers[field] = setTimeout(async () => {
    try {
      const res     = await fetch(`/api/airports/search?keyword=${encodeURIComponent(keyword)}`);
      const airports = await res.json();

      listEl.innerHTML = airports.map(a => `
        <li onclick="selectAirport('${field}', '${a.iataCode}', '${escape(a.cityName || a.name)}', '${a.entityId || ''}')">
          <span class="ac-code">${a.iataCode} — ${a.cityName || a.name}</span>
          <span class="ac-name">${a.name}${a.countryName ? ', ' + a.countryName : ''}</span>
        </li>
      `).join('');
    } catch (e) {
      listEl.innerHTML = '';
    }
  }, 300);
}

function selectAirport(field, code, cityName, entityId) {
  const inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  const listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  inputEl.value = `${code} — ${unescape(cityName)}`;
  inputEl.dataset.code     = code;     // Store the IATA/Sky code
  inputEl.dataset.entityId = entityId; // Store the entityId for Sky Scrapper
  listEl.innerHTML = '';
}

// Close autocomplete when clicking elsewhere
document.addEventListener('click', e => {
  if (!e.target.closest('.autocomplete-wrap')) {
    document.querySelectorAll('.autocomplete-list').forEach(l => l.innerHTML = '');
  }
});

function swapAirports() {
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const tempVal  = originInput.value;
  const tempCode = originInput.dataset.code;
  originInput.value = destInput.value;
  originInput.dataset.code = destInput.dataset.code || '';
  destInput.value = tempVal;
  destInput.dataset.code = tempCode || '';
}

// ─────────────────────────────────────────────────────────────
// FLIGHT SEARCH
// Reads the form, calls /api/flights/search, shows results
// ─────────────────────────────────────────────────────────────
async function searchFlights() {
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const departDate  = document.getElementById('depart-input').value;
  const passengers  = document.getElementById('passengers-input').value;
  const errorEl     = document.getElementById('search-error');

  // Get IATA/Sky codes (from dataset if set by autocomplete, otherwise try input value directly)
  const origin           = originInput.dataset.code     || originInput.value.split('—')[0].trim().toUpperCase();
  const dest             = destInput.dataset.code       || destInput.value.split('—')[0].trim().toUpperCase();
  const originEntityId   = originInput.dataset.entityId || '';
  const destEntityId     = destInput.dataset.entityId   || '';

  // Validate
  errorEl.textContent = '';
  if (!origin || origin.length !== 3) return setError(errorEl, 'Valitse kelvollinen lähtölentokenttä.');
  if (!dest   || dest.length   !== 3) return setError(errorEl, 'Valitse kelvollinen määränpäälentokenttä.');
  if (!departDate)                    return setError(errorEl, 'Valitse lähtöpäivämäärä.');
  if (new Date(departDate) < new Date().setHours(0,0,0,0)) return setError(errorEl, 'Lähtöpäivämäärä ei voi olla menneisyydessä.');

  // Save search params for display
  searchParams = { origin, dest, departDate, passengers: parseInt(passengers) };

  // Show results page with loading state
  showPage('results');
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';
  document.getElementById('results-heading').textContent   = `${origin} → ${dest}`;
  document.getElementById('results-subheading').textContent =
    `${formatDate(departDate)} · ${passengers} matkustaja${passengers > 1 ? 'a' : ''}`;

  // Set search button loading state
  toggleBtnLoading('search-btn-text', 'search-btn-spinner', true);

  try {
    const res   = await fetch(`/api/flights/search?origin=${origin}&destination=${dest}&departureDate=${departDate}&adults=${passengers}&originEntityId=${originEntityId}&destinationEntityId=${destEntityId}`);
    const data  = await res.json();

    document.getElementById('results-loading').style.display = 'none';

    if (!Array.isArray(data) || data.length === 0) {
      document.getElementById('results-empty').style.display = 'flex';
      return;
    }

    renderFlightCards(data);
  } catch (err) {
    document.getElementById('results-loading').style.display = 'none';
    document.getElementById('results-empty').style.display   = 'flex';
  } finally {
    toggleBtnLoading('search-btn-text', 'search-btn-spinner', false);
  }
}

// Render flight result cards
function renderFlightCards(flights) {
  const list = document.getElementById('results-list');
  list.style.display = 'flex';

  list.innerHTML = flights.map((flight, i) => {
    const seg       = flight.itineraries[0].segments[0];
    const lastSeg   = flight.itineraries[0].segments[flight.itineraries[0].segments.length - 1];
    const stops     = flight.itineraries[0].segments.length - 1;
    const duration  = formatDuration(flight.itineraries[0].duration);
    const price     = parseFloat(flight.price.grandTotal).toFixed(2);
    const currency  = flight.price.currency;
    const cabin     = flight.travelerPricings[0]?.fareDetailsBySegment[0]?.cabin || 'ECONOMY';
    const seats     = flight.numberOfBookableSeats || '';

    return `
      <div class="flight-card" onclick="selectFlight(${i})">
        <div class="flight-airline">
          <div class="airline-code">${seg.carrierCode}</div>
          <div class="airline-number">${seg.carrierCode}${seg.number}</div>
        </div>

        <div class="flight-route">
          <div class="route-point">
            <div class="route-time">${formatTime(seg.departure.at)}</div>
            <div class="route-airport">${seg.departure.iataCode}</div>
          </div>
          <div class="route-line">
            <span class="route-duration">${duration}</span>
            <div class="route-bar"></div>
            <span class="route-stops">${stops === 0 ? 'Suora' : stops + ' välilaskua'}</span>
          </div>
          <div class="route-point">
            <div class="route-time">${formatTime(lastSeg.arrival.at)}</div>
            <div class="route-airport">${lastSeg.arrival.iataCode}</div>
          </div>
        </div>

        <div class="flight-meta">
          <div class="flight-cabin">${cabin.charAt(0) + cabin.slice(1).toLowerCase()}</div>
          ${seats ? `<div class="flight-seats">${seats} paikkaa jäljellä</div>` : ''}
        </div>

        <div class="flight-price">
          <div class="price-amount">${currency === 'USD' ? '$' : currency}${price}</div>
          <div class="price-label">per henkilö</div>
        </div>

        <button class="btn-select">Valitse</button>
      </div>
    `;
  }).join('');

  // Store flights array on window for access in selectFlight()
  window._flights = flights;
}

function selectFlight(index) {
  selectedFlight = window._flights[index];

  // Require login before booking
  if (!currentUser) {
    openAuthModal('login');
    return;
  }

  setupBookingPage();
  showPage('booking');
}

// ─────────────────────────────────────────────────────────────
// BOOKING PAGE SETUP
// Builds the passenger forms and loads the Stripe payment element
// ─────────────────────────────────────────────────────────────
async function setupBookingPage() {
  const seg      = selectedFlight.itineraries[0].segments[0];
  const lastSeg  = selectedFlight.itineraries[0].segments[selectedFlight.itineraries[0].segments.length - 1];
  const price    = parseFloat(selectedFlight.price.grandTotal);
  const currency = selectedFlight.price.currency;
  const passengerCount = searchParams.passengers || 1;

  // Pre-fill contact email with logged-in user's email
  if (currentUser) {
    document.getElementById('contact-email').value = currentUser.email || '';
  }

  // Build passenger forms
  let formsHtml = '';
  for (let i = 1; i <= passengerCount; i++) {
    formsHtml += `
      <p class="passenger-header">Matkustaja ${i}</p>
      <div class="form-row">
        <div class="form-group">
          <label>Etunimi</label>
          <input type="text" class="pax-first" placeholder="Etunimi" />
        </div>
        <div class="form-group">
          <label>Sukunimi</label>
          <input type="text" class="pax-last" placeholder="Sukunimi" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Syntymäpäivä</label>
          <input type="date" class="pax-dob" />
        </div>
        <div class="form-group">
          <label>Passi / Henkilötodistus</label>
          <input type="text" class="pax-passport" placeholder="Passinumero" />
        </div>
      </div>
    `;
  }
  document.getElementById('passenger-forms').innerHTML = formsHtml;

  // Build flight summary sidebar
  document.getElementById('booking-flight-summary').innerHTML = `
    <div class="summary-flight-row">
      <div class="summary-route">${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}</div>
      <span class="booking-status status-confirmed" style="margin:0;">✈ Vahvistettu</span>
    </div>
    <div class="summary-times">
      <strong>${formatTime(seg.departure.at)}</strong>
      <span style="color:#9ca3af;">→</span>
      <strong>${formatTime(lastSeg.arrival.at)}</strong>
    </div>
    <div class="summary-duration">${formatDate(searchParams.departDate)} · ${formatDuration(selectedFlight.itineraries[0].duration)}</div>
    <div class="summary-duration" style="margin-top:4px;">${seg.carrierCode}${seg.number}</div>
  `;

  const taxAmount  = parseFloat(selectedFlight.price.fees?.[0]?.amount || (price * 0.1)).toFixed(2);
  const baseAmount = (price - taxAmount).toFixed(2);
  const total      = price.toFixed(2);

  document.getElementById('price-breakdown').innerHTML = `
    <div class="price-row"><span>Perushinta × ${passengerCount}</span><span>$${(baseAmount * passengerCount).toFixed(2)}</span></div>
    <div class="price-row"><span>Verot ja maksut</span><span>$${(taxAmount * passengerCount).toFixed(2)}</span></div>
    <div class="price-row total"><span>Yhteensä</span><span>$${(price * passengerCount).toFixed(2)}</span></div>
  `;

  // Setup Stripe payment element
  await setupStripePayment(price * passengerCount, currency);
}

async function setupStripePayment(amount, currency) {
  document.getElementById('booking-error').textContent = '';

  try {
    // Ask our backend to create a PaymentIntent
    const res  = await fetch('/api/payments/create-intent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amount,
        currency: currency || 'USD',
        flightDetails: {
          from: searchParams.origin,
          to:   searchParams.dest,
          date: searchParams.departDate
        }
      })
    });
    const { clientSecret, error } = await res.json();

    if (error) throw new Error(error);

    // Mount the Stripe Payment Element into #payment-element
    stripeElements = stripe.elements({ clientSecret, appearance: { theme: 'stripe' } });
    const paymentElement = stripeElements.create('payment');
    paymentElement.mount('#payment-element');
  } catch (err) {
    document.getElementById('booking-error').textContent = 'Maksukaavaketta ei voitu ladata. Yritä uudelleen.';
  }
}

// ─────────────────────────────────────────────────────────────
// SUBMIT BOOKING (pay + save to Firestore)
// ─────────────────────────────────────────────────────────────
async function submitBooking() {
  const errorEl = document.getElementById('booking-error');
  errorEl.textContent = '';

  // Validate passenger fields
  const firstNames = Array.from(document.querySelectorAll('.pax-first')).map(el => el.value.trim());
  const lastNames  = Array.from(document.querySelectorAll('.pax-last')).map(el => el.value.trim());
  const email      = document.getElementById('contact-email').value.trim();
  const phone      = document.getElementById('contact-phone').value.trim();

  if (firstNames.some(n => !n) || lastNames.some(n => !n)) {
    return setError(errorEl, 'Täytä kaikkien matkustajien nimet.');
  }
  if (!email || !email.includes('@')) {
    return setError(errorEl, 'Syötä kelvollinen sähköpostiosoite.');
  }
  if (!phone) {
    return setError(errorEl, 'Syötä yhteystietopuhelinnumero.');
  }
  if (!stripeElements) {
    return setError(errorEl, 'Maksukaavake ei ole vielä valmis. Odota hetki.');
  }

  toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', true);
  document.getElementById('pay-btn').disabled = true;

  try {
    // Confirm the Stripe payment
    const { error: stripeError } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        payment_method_data: {
          billing_details: { email, phone }
        }
      },
      redirect: 'if_required' // Don't redirect, handle result here
    });

    if (stripeError) {
      setError(errorEl, stripeError.message);
      return;
    }

    // Payment succeeded — save booking to Firestore
    const seg     = selectedFlight.itineraries[0].segments[0];
    const lastSeg = selectedFlight.itineraries[0].segments[selectedFlight.itineraries[0].segments.length - 1];
    const price   = parseFloat(selectedFlight.price.grandTotal) * (searchParams.passengers || 1);

    const booking = {
      userId:    currentUser.uid,
      userEmail: currentUser.email,
      bookingRef: generateBookingRef(),
      status:    'confirmed',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      flight: {
        from:       seg.departure.iataCode,
        to:         lastSeg.arrival.iataCode,
        departTime: seg.departure.at,
        arriveTime: lastSeg.arrival.at,
        airline:    seg.carrierCode,
        flightNum:  seg.carrierCode + seg.number,
        duration:   formatDuration(selectedFlight.itineraries[0].duration)
      },
      passengers: firstNames.map((first, i) => ({
        firstName: first,
        lastName:  lastNames[i]
      })),
      contact: { email, phone },
      totalPrice: price.toFixed(2),
      currency:  selectedFlight.price.currency || 'USD'
    };

    const docRef = await db.collection('bookings').add(booking);

    // Show confirmation page
    showConfirmationPage(booking);

  } catch (err) {
    setError(errorEl, 'Varaus epäonnistui: ' + (err.message || 'Yritä uudelleen.'));
  } finally {
    toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', false);
    document.getElementById('pay-btn').disabled = false;
  }
}

function showConfirmationPage(booking) {
  document.getElementById('confirmation-details').innerHTML = `
    <div><strong>Varausnumero:</strong> ${booking.bookingRef}</div>
    <div><strong>Reitti:</strong> ${booking.flight.from} → ${booking.flight.to}</div>
    <div><strong>Päivämäärä:</strong> ${formatDate(booking.flight.departTime)}</div>
    <div><strong>Lähtö:</strong> ${formatTime(booking.flight.departTime)} · Saapuminen: ${formatTime(booking.flight.arriveTime)}</div>
    <div><strong>Lento:</strong> ${booking.flight.flightNum}</div>
    <div><strong>Matkustajat:</strong> ${booking.passengers.map(p => p.firstName + ' ' + p.lastName).join(', ')}</div>
    <div><strong>Maksettu yhteensä:</strong> $${booking.totalPrice}</div>
  `;
  showPage('confirmation');
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD — My Bookings
// ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  const loadingEl  = document.getElementById('dashboard-loading');
  const emptyEl    = document.getElementById('dashboard-empty');
  const listEl     = document.getElementById('dashboard-list');
  const authPrompt = document.getElementById('dashboard-auth-prompt');

  // Reset states
  loadingEl.style.display  = 'none';
  emptyEl.style.display    = 'none';
  listEl.style.display     = 'none';
  authPrompt.style.display = 'none';

  if (!currentUser) {
    authPrompt.style.display = 'flex';
    return;
  }

  loadingEl.style.display = 'flex';

  try {
    const snapshot = await db.collection('bookings')
      .where('userId', '==', currentUser.uid)
      .orderBy('createdAt', 'desc')
      .get();

    loadingEl.style.display = 'none';

    if (snapshot.empty) {
      emptyEl.style.display = 'flex';
      return;
    }

    listEl.style.display = 'flex';
    listEl.innerHTML = '';

    snapshot.forEach(doc => {
      const b = doc.data();
      listEl.innerHTML += `
        <div class="booking-card" id="booking-${doc.id}">
          <div>
            <span class="booking-status ${b.status === 'confirmed' ? 'status-confirmed' : 'status-cancelled'}">
              ${b.status === 'confirmed' ? 'Vahvistettu' : 'Peruutettu'}
            </span>
          </div>
          <div class="booking-info">
            <div class="booking-route">${b.flight.from} → ${b.flight.to}</div>
            <div class="booking-date-time">${formatDate(b.flight.departTime)} · ${formatTime(b.flight.departTime)} – ${formatTime(b.flight.arriveTime)}</div>
            <div class="booking-date-time">${b.flight.flightNum} · ${b.flight.duration}</div>
            <div class="booking-ref">Varausnro: ${b.bookingRef}</div>
          </div>
          <div>
            <div class="booking-price">$${b.totalPrice}</div>
            <div class="booking-price-label">${b.passengers.length} matkustaja${b.passengers.length > 1 ? 'a' : ''}</div>
          </div>
          ${b.status === 'confirmed' ? `
            <button class="btn-cancel" onclick="openCancelModal('${doc.id}')">
              Peruuta
            </button>
          ` : '<span style="color:#9ca3af;font-size:.85rem;">Peruutettu</span>'}
        </div>
      `;
    });

  } catch (err) {
    loadingEl.style.display = 'none';
    emptyEl.style.display   = 'flex';
  }
}

// Cancel booking flow
function openCancelModal(bookingId) {
  cancelBookingId = bookingId;
  document.getElementById('cancel-overlay').style.display = 'flex';
  document.getElementById('cancel-overlay').classList.add('open');
}

function closeCancelModal(e) {
  if (e && e.target !== document.getElementById('cancel-overlay')) return;
  document.getElementById('cancel-overlay').style.display = 'none';
  cancelBookingId = null;
}

async function confirmCancelBooking() {
  if (!cancelBookingId) return;

  const btn = document.getElementById('confirm-cancel-btn');
  btn.disabled = true;
  btn.textContent = 'Peruutetaan...';

  try {
    await db.collection('bookings').doc(cancelBookingId).update({ status: 'cancelled' });

    // Update the card in the UI without reloading
    const card = document.getElementById('booking-' + cancelBookingId);
    if (card) {
      const statusEl = card.querySelector('.booking-status');
      if (statusEl) {
        statusEl.className = 'booking-status status-cancelled';
        statusEl.textContent = 'Peruutettu';
      }
      const cancelBtn = card.querySelector('.btn-cancel');
      if (cancelBtn) {
        cancelBtn.outerHTML = '<span style="color:#9ca3af;font-size:.85rem;">Peruutettu</span>';
      }
    }
  } catch (err) {
    alert('Varausta ei voitu peruuttaa. Yritä uudelleen.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kyllä, peruuta';
    document.getElementById('cancel-overlay').style.display = 'none';
    cancelBookingId = null;
  }
}

// ─────────────────────────────────────────────────────────────
// AUTH MODAL
// ─────────────────────────────────────────────────────────────
function openAuthModal(tab) {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('auth-overlay').classList.add('open');
  switchAuthTab(tab || 'login');
}

function closeAuthModal(e) {
  if (e && e.target !== document.getElementById('auth-overlay')) return;
  document.getElementById('auth-overlay').style.display = 'none';
}

function switchAuthTab(tab) {
  document.getElementById('form-login').style.display  = tab === 'login'  ? 'block' : 'none';
  document.getElementById('form-signup').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('tab-login').classList.toggle('active',  tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  // Clear errors
  document.getElementById('login-error').textContent  = '';
  document.getElementById('signup-error').textContent = '';
}

// Sign In
async function signInUser() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');

  if (!email || !password) return setError(errorEl, 'Syötä sähköpostisi ja salasanasi.');

  toggleBtnLoading('login-btn-text', 'login-btn-spinner', true);

  try {
    await auth.signInWithEmailAndPassword(email, password);
    document.getElementById('auth-overlay').style.display = 'none';

    // If they were trying to book a flight, go back to booking
    if (selectedFlight) {
      setupBookingPage();
      showPage('booking');
    }
  } catch (err) {
    setError(errorEl, friendlyAuthError(err.code));
  } finally {
    toggleBtnLoading('login-btn-text', 'login-btn-spinner', false);
  }
}

// Sign Up
async function signUpUser() {
  const name     = document.getElementById('signup-name').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errorEl  = document.getElementById('signup-error');

  if (!name)                   return setError(errorEl, 'Syötä koko nimesi.');
  if (!email)                  return setError(errorEl, 'Syötä sähköpostisi.');
  if (password.length < 6)     return setError(errorEl, 'Salasanan on oltava vähintään 6 merkkiä.');

  toggleBtnLoading('signup-btn-text', 'signup-btn-spinner', true);

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    document.getElementById('auth-overlay').style.display = 'none';

    if (selectedFlight) {
      setupBookingPage();
      showPage('booking');
    }
  } catch (err) {
    setError(errorEl, friendlyAuthError(err.code));
  } finally {
    toggleBtnLoading('signup-btn-text', 'signup-btn-spinner', false);
  }
}

// Sign Out
async function signOutUser() {
  await auth.signOut();
  showPage('home');
}

// Map Firebase error codes to friendly messages
function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':      'Tällä sähköpostilla ei löydy tiliä.',
    'auth/wrong-password':      'Väärä salasana. Yritä uudelleen.',
    'auth/email-already-in-use':'Tällä sähköpostilla on jo tili.',
    'auth/invalid-email':       'Syötä kelvollinen sähköpostiosoite.',
    'auth/weak-password':       'Salasana on liian heikko. Käytä vähintään 6 merkkiä.',
    'auth/too-many-requests':   'Liian monta yritystä. Yritä myöhemmin uudelleen.'
  };
  return map[code] || 'Jokin meni pieleen. Yritä uudelleen.';
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

// Set an error message in an element
function setError(el, msg) {
  el.textContent = msg;
}

// Toggle button loading state
function toggleBtnLoading(textId, spinnerId, loading) {
  const textEl    = document.getElementById(textId);
  const spinnerEl = document.getElementById(spinnerId);
  if (textEl)    textEl.style.display    = loading ? 'none'   : 'inline';
  if (spinnerEl) spinnerEl.style.display = loading ? 'inline-block' : 'none';
}

// Format ISO date string → "Mon, Jan 15, 2025"
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('fi-FI', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Format ISO datetime → "14:35"
function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Format ISO 8601 duration (PT2H35M) → "2h 35m"
function formatDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return iso;
  const h = match[1] ? match[1] + 'h ' : '';
  const m = match[2] ? match[2] + 'm'  : '';
  return h + m;
}

// Generate a random booking reference
function generateBookingRef() {
  return 'SKY-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Set minimum date on date inputs to today
(function initDateInputs() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('depart-input').min = today;
  document.getElementById('return-input').min = today;
})();
