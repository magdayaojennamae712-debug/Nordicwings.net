// ============================================================
// NordicWings — script.js
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

const OWNER_EMAIL = 'magdayaojennamae712@gmail.com';

function updateNavForAuth(user) {
  const navLogin    = document.getElementById('nav-login');
  const navSignup   = document.getElementById('nav-signup');
  const navUser     = document.getElementById('nav-user');
  const navUsername = document.getElementById('nav-username');
  const navDash     = document.getElementById('nav-dashboard');
  const navAdmin    = document.getElementById('nav-admin');

  if (user) {
    navLogin.style.display    = 'none';
    navSignup.style.display   = 'none';
    navUser.style.display     = 'flex';
    navDash.style.display     = 'inline-flex';
    navUsername.textContent   = user.displayName || user.email.split('@')[0];
    // Show admin button only for owner
    if (navAdmin) navAdmin.style.display = user.email === OWNER_EMAIL ? 'inline-flex' : 'none';
  } else {
    navLogin.style.display    = 'inline-flex';
    navSignup.style.display   = 'inline-flex';
    navUser.style.display     = 'none';
    navDash.style.display     = 'none';
    if (navAdmin) navAdmin.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE NAVIGATION
// ─────────────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Load data when navigating to special pages
  if (pageId === 'dashboard') loadDashboard();
  if (pageId === 'admin')     loadAdminDashboard();
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
let autocompleteTimers = {};

const POPULAR_AIRPORTS = [
  { iataCode:'HEL', entityId:'95673644', name:'Helsinki-Vantaa Airport', cityName:'Helsinki', countryName:'Finland' },
  { iataCode:'LHR', entityId:'95565050', name:'Heathrow Airport', cityName:'London', countryName:'United Kingdom' },
  { iataCode:'DXB', entityId:'95673506', name:'Dubai International Airport', cityName:'Dubai', countryName:'UAE' },
  { iataCode:'BKK', entityId:'95673827', name:'Suvarnabhumi Airport', cityName:'Bangkok', countryName:'Thailand' },
  { iataCode:'JFK', entityId:'95565058', name:'John F. Kennedy International', cityName:'New York', countryName:'USA' },
  { iataCode:'MNL', entityId:'95673820', name:'Ninoy Aquino International', cityName:'Manila', countryName:'Philippines' },
  { iataCode:'NRT', entityId:'95673640', name:'Narita International Airport', cityName:'Tokyo', countryName:'Japan' },
  { iataCode:'BCN', entityId:'95565059', name:'El Prat Airport', cityName:'Barcelona', countryName:'Spain' },
  { iataCode:'CDG', entityId:'95565044', name:'Charles de Gaulle Airport', cityName:'Paris', countryName:'France' },
  { iataCode:'AMS', entityId:'95565045', name:'Amsterdam Schiphol Airport', cityName:'Amsterdam', countryName:'Netherlands' },
  { iataCode:'SIN', entityId:'95673821', name:'Changi Airport', cityName:'Singapore', countryName:'Singapore' },
  { iataCode:'SYD', entityId:'95673825', name:'Sydney Kingsford Smith Airport', cityName:'Sydney', countryName:'Australia' },
  { iataCode:'YYZ', entityId:'95565071', name:'Toronto Pearson International', cityName:'Toronto', countryName:'Canada' },
  { iataCode:'FRA', entityId:'95565046', name:'Frankfurt Airport', cityName:'Frankfurt', countryName:'Germany' },
  { iataCode:'MAD', entityId:'95565047', name:'Adolfo Suarez Madrid-Barajas', cityName:'Madrid', countryName:'Spain' },
  { iataCode:'ICN', entityId:'95673822', name:'Incheon International Airport', cityName:'Seoul', countryName:'South Korea' },
  { iataCode:'IST', entityId:'95565060', name:'Istanbul Airport', cityName:'Istanbul', countryName:'Turkey' },
  { iataCode:'DEL', entityId:'95673826', name:'Indira Gandhi International', cityName:'New Delhi', countryName:'India' },
  { iataCode:'HKG', entityId:'95673823', name:'Hong Kong International Airport', cityName:'Hong Kong', countryName:'China' },
  { iataCode:'DOH', entityId:'95673505', name:'Hamad International Airport', cityName:'Doha', countryName:'Qatar' },
  { iataCode:'KUL', entityId:'95673824', name:'Kuala Lumpur International', cityName:'Kuala Lumpur', countryName:'Malaysia' },
  { iataCode:'CGK', entityId:'95673828', name:'Soekarno-Hatta International', cityName:'Jakarta', countryName:'Indonesia' },
  { iataCode:'LAX', entityId:'95565072', name:'Los Angeles International', cityName:'Los Angeles', countryName:'USA' },
  { iataCode:'ORD', entityId:'95565073', name:'OHare International Airport', cityName:'Chicago', countryName:'USA' },
  { iataCode:'MIA', entityId:'95565074', name:'Miami International Airport', cityName:'Miami', countryName:'USA' },
];

function showAcList(listEl, inputEl, airports, field) {
  var rect = inputEl.getBoundingClientRect();
  listEl.style.position = 'fixed';
  listEl.style.top = (rect.bottom + 4) + 'px';
  listEl.style.left = rect.left + 'px';
  listEl.style.width = rect.width + 'px';
  listEl.style.zIndex = '9999';
  if (airports.length === 0) {
    listEl.innerHTML = '<li style="padding:12px 16px;color:#aaa;font-size:.88rem;">No results found</li>';
    return;
  }
  var html = '';
  for (var i = 0; i < Math.min(airports.length, 7); i++) {
    var a = airports[i];
    var city = (a.cityName || a.name).replace(/'/g, "&#39;");
    var aname = a.name.replace(/'/g, "&#39;");
    var country = (a.countryName || '').replace(/'/g, "&#39;");
    var code = a.iataCode;
    var eid = (a.entityId || '').replace(/'/g, "&#39;");
    html += '<li onclick="selectAirport(\'' + field + '\',\'' + code + '\',\'' + city + '\',\'' + eid + '\')" style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f2f8;">';
    html += '<span style="width:30px;height:30px;background:#e8efff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0;">&#9992;</span>';
    html += '<span><strong style="color:#1a2b4a;font-size:.95rem;">' + city + '</strong> <span style="background:#3b6fc9;color:#fff;font-size:.7rem;font-weight:800;padding:1px 6px;border-radius:4px;margin-left:4px;">' + code + '</span><br>';
    html += '<span style="font-size:.78rem;color:#7a8aaa;">' + aname + (country ? ' &middot; ' + country : '') + '</span></span>';
    html += '</li>';
  }
  listEl.innerHTML = html;
}

async function autocomplete(field) {
  var inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  var listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  var keyword = inputEl.value.trim().toLowerCase();
  if (keyword.length < 1) { listEl.innerHTML = ''; return; }
  var local = POPULAR_AIRPORTS.filter(function(a) {
    return a.cityName.toLowerCase().indexOf(keyword) === 0 ||
           a.iataCode.toLowerCase().indexOf(keyword) === 0 ||
           a.countryName.toLowerCase().indexOf(keyword) === 0 ||
           a.name.toLowerCase().indexOf(keyword) !== -1;
  });
  if (local.length > 0) showAcList(listEl, inputEl, local, field);
  if (keyword.length < 2) return;
  clearTimeout(autocompleteTimers[field]);
  autocompleteTimers[field] = setTimeout(async function() {
    try {
      var res = await fetch('/api/airports/search?keyword=' + encodeURIComponent(keyword));
      var airports = await res.json();
      if (airports.length > 0) showAcList(listEl, inputEl, airports, field);
    } catch(e) {}
  }, 350);
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

  // City name to IATA code map — so customers can type city names freely!
  const cityToCode = {
    'HELSINKI':'HEL','LONDON':'LHR','DUBAI':'DXB','NEW YORK':'JFK',
    'PARIS':'CDG','AMSTERDAM':'AMS','BANGKOK':'BKK','SINGAPORE':'SIN',
    'SYDNEY':'SYD','TOKYO':'NRT','ROME':'FCO','MADRID':'MAD',
    'BERLIN':'BER','MUNICH':'MUC','VIENNA':'VIE','ZURICH':'ZRH',
    'BARCELONA':'BCN','LISBON':'LIS','OSLO':'OSL','STOCKHOLM':'ARN',
    'COPENHAGEN':'CPH','DUBLIN':'DUB','BRUSSELS':'BRU','WARSAW':'WAW',
    'PRAGUE':'PRG','BUDAPEST':'BUD','ATHENS':'ATH','ISTANBUL':'IST',
    'CAIRO':'CAI','JOHANNESBURG':'JNB','NAIROBI':'NBO','LAGOS':'LOS',
    'MUMBAI':'BOM','DELHI':'DEL','HONG KONG':'HKG','BEIJING':'PEK',
    'SHANGHAI':'PVG','SEOUL':'ICN','KUALA LUMPUR':'KUL','JAKARTA':'CGK',
    'MANILA':'MNL','DAVAO':'DVO','CEBU':'CEB','LOS ANGELES':'LAX',
    'CHICAGO':'ORD','TORONTO':'YYZ','MEXICO CITY':'MEX','SAO PAULO':'GRU',
    'BUENOS AIRES':'EZE','DOHA':'DOH','ABU DHABI':'AUH','RIYADH':'RUH',
    'FRANKFURT':'FRA','MILAN':'MXP','NICE':'NCE','LYON':'LYS',
    'THAILAND':'BKK','BANGKOK':'BKK','PHUKET':'HKT','CHIANG MAI':'CNX',
    'BALI':'DPS','INDONESIA':'DPS','VIETNAM':'SGN','HO CHI MINH':'SGN',
    'HANOI':'HAN','CAMBODIA':'PNH','PHNOM PENH':'PNH','MYANMAR':'RGN',
    'YANGON':'RGN','MALDIVES':'MLE','SRI LANKA':'CMB','COLOMBO':'CMB',
    'NEPAL':'KTM','KATHMANDU':'KTM','PAKISTAN':'KHI','KARACHI':'KHI',
    'LAHORE':'LHE','NIGERIA':'LOS','GHANA':'ACC','KENYA':'NBO',
    'TANZANIA':'DAR','ETHIOPIA':'ADD','ADDIS ABABA':'ADD',
    'AUSTRALIA':'SYD','MELBOURNE':'MEL','BRISBANE':'BNE','PERTH':'PER',
    'NEW ZEALAND':'AKL','AUCKLAND':'AKL','HAWAII':'HNL','HONOLULU':'HNL',
    'MIAMI':'MIA','DALLAS':'DFW','HOUSTON':'IAH','SEATTLE':'SEA',
    'BOSTON':'BOS','WASHINGTON':'IAD','ATLANTA':'ATL','DENVER':'DEN',
    'CANADA':'YYZ','VANCOUVER':'YVR','MONTREAL':'YUL','CALGARY':'YYC',
    'BRAZIL':'GRU','RIO':'GIG','PERU':'LIM','LIMA':'LIM','CHILE':'SCL',
    'COLOMBIA':'BOG','BOGOTA':'BOG','ARGENTINA':'EZE',
  };

  // Resolve code from input — try dataset first, then direct code, then city name lookup
  function resolveCode(input, datasetCode) {
    if (datasetCode) return datasetCode;
    const raw = input.value.split('—')[0].trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(raw)) return raw; // Already a 3-letter code
    return cityToCode[raw] || raw.substring(0, 3); // Try city name lookup
  }

  const origin         = resolveCode(originInput, originInput.dataset.code);
  const dest           = resolveCode(destInput,   destInput.dataset.code);
  const originEntityId = originInput.dataset.entityId || '';
  const destEntityId   = destInput.dataset.entityId   || '';

  // Validate
  errorEl.textContent = '';
  if (!origin || origin.length < 2) return setError(errorEl, 'Please enter a departure city or airport.');
  if (!dest   || dest.length   < 2) return setError(errorEl, 'Please enter a destination city or airport.');
  if (!departDate)                   return setError(errorEl, 'Please select a departure date.');
  if (new Date(departDate) < new Date().setHours(0,0,0,0)) return setError(errorEl, 'Departure date cannot be in the past.');

  // Save search params for display
  searchParams = { origin, dest, departDate, passengers: parseInt(passengers) };

  // Show results page with loading state
  showPage('results');
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';
  document.getElementById('results-heading').textContent   = `${origin} → ${dest}`;
  document.getElementById('results-subheading').textContent =
    `${formatDate(departDate)} · ${passengers} passenger${passengers > 1 ? 's' : ''}`;

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

// Airline code → full name map
const AIRLINE_NAMES = {
  'AY':'Finnair','EK':'Emirates','QR':'Qatar Airways','BA':'British Airways',
  'LH':'Lufthansa','TK':'Turkish Airlines','AF':'Air France','KL':'KLM',
  'SK':'SAS','DY':'Norwegian','FR':'Ryanair','U2':'easyJet','VY':'Vueling',
  'IB':'Iberia','TP':'TAP Air Portugal','LX':'Swiss','OS':'Austrian',
  'SN':'Brussels Airlines','EI':'Aer Lingus','BE':'flybe',
  'W6':'Wizz Air','PC':'Pegasus','XW':'NokScoot','TG':'Thai Airways',
  'SQ':'Singapore Airlines','MH':'Malaysia Airlines','CX':'Cathay Pacific',
  'JL':'Japan Airlines','NH':'ANA','OZ':'Asiana Airlines','KE':'Korean Air',
  'PR':'Philippine Airlines','5J':'Cebu Pacific','Z2':'Philippines AirAsia',
  'GA':'Garuda Indonesia','QZ':'Indonesia AirAsia','JT':'Lion Air',
  'FZ':'flydubai','G9':'Air Arabia','WY':'Oman Air','SV':'Saudia',
  'MS':'EgyptAir','ET':'Ethiopian Airlines','KQ':'Kenya Airways',
  'SA':'South African','QF':'Qantas','NZ':'Air New Zealand','VA':'Virgin Australia',
  'AC':'Air Canada','WS':'WestJet','AA':'American','UA':'United','DL':'Delta',
  'WN':'Southwest','B6':'JetBlue','AS':'Alaska Airlines','F9':'Frontier',
  'LA':'LATAM','G3':'Gol','AD':'Azul','CM':'Copa Airlines',
};

// Render flight result cards (Skyscanner-style)
function renderFlightCards(flights) {
  window._flights = flights;
  window._flightsAll = flights; // Keep original for sorting/filtering

  const list = document.getElementById('results-list');
  list.style.display = 'flex';

  // Build sort/filter bar
  const hasNonstop = flights.some(f => f.itineraries[0].segments.length === 1);
  const sortBarHtml = `
    <div class="results-sort-bar">
      <div class="sort-label">Sort by:</div>
      <button class="sort-btn active" onclick="sortFlights('cheapest', this)">💰 Cheapest</button>
      <button class="sort-btn" onclick="sortFlights('fastest', this)">⚡ Fastest</button>
      ${hasNonstop ? '<button class="filter-btn" onclick="filterNonstop(this)">✅ Nonstop only</button>' : ''}
      <div class="results-count">${flights.length} flights found</div>
    </div>
  `;

  list.innerHTML = sortBarHtml + '<div id="flights-container"></div>';
  renderFlightList(flights);
}

function renderFlightList(flights) {
  const container = document.getElementById('flights-container');
  if (!container) return;

  container.innerHTML = flights.map((flight, i) => {
    const seg      = flight.itineraries[0].segments[0];
    const lastSeg  = flight.itineraries[0].segments[flight.itineraries[0].segments.length - 1];
    const allSegs  = flight.itineraries[0].segments;
    const stops    = allSegs.length - 1;
    const duration = formatDuration(flight.itineraries[0].duration);
    const price    = parseFloat(flight.price.grandTotal).toFixed(0);
    const currency = flight.price.currency;
    const seats    = flight.numberOfBookableSeats;
    const cabin    = flight.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin || 'ECONOMY';
    const code     = seg.carrierCode;
    const name     = AIRLINE_NAMES[code] || code;
    const sym      = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';

    // Stop badge
    const stopVia = allSegs.slice(0,-1).map(s => s.arrival.iataCode).join(', ');
    const stopBadge = stops === 0
      ? '<span class="badge-nonstop">Nonstop</span>'
      : `<span class="badge-stop">${stops} stop${stops>1?'s':''} · ${stopVia}</span>`;

    // Seats urgency
    const seatsBadge = (seats && seats <= 5)
      ? `<div class="seats-urgent">🔥 Only ${seats} left!</div>`
      : (seats && seats <= 9 ? `<div class="seats-warning">${seats} seats left</div>` : '');

    // Best deal badge (cheapest 20%)
    const allPrices = (window._flightsAll||flights).map(f=>parseFloat(f.price.grandTotal));
    const minPrice = Math.min(...allPrices);
    const dealBadge = parseFloat(flight.price.grandTotal) <= minPrice * 1.05
      ? '<div class="badge-best">Best price</div>' : '';

    return `
      <div class="fc" onclick="selectFlight(${i})" data-price="${flight.price.grandTotal}" data-dur="${flight.itineraries[0].duration}" data-stops="${stops}">
        <div class="fc-airline">
          <img src="https://www.gstatic.com/flights/airline_logos/70px/${code}.png"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
               class="fc-logo" alt="${name}" />
          <div class="fc-logo-fallback" style="display:none">${code}</div>
          <div class="fc-airline-name">${name}</div>
          <div class="fc-flight-num">${code}${seg.number}</div>
        </div>

        <div class="fc-route">
          <div class="fc-point">
            <div class="fc-time">${formatTime(seg.departure.at)}</div>
            <div class="fc-iata">${seg.departure.iataCode}</div>
          </div>
          <div class="fc-mid">
            <div class="fc-dur">${duration}</div>
            <div class="fc-line-wrap">
              <span class="fc-dot"></span>
              <div class="fc-bar"></div>
              <span class="fc-plane">✈</span>
              <div class="fc-bar"></div>
              <span class="fc-dot"></span>
            </div>
            ${stopBadge}
          </div>
          <div class="fc-point">
            <div class="fc-time">${formatTime(lastSeg.arrival.at)}</div>
            <div class="fc-iata">${lastSeg.arrival.iataCode}</div>
          </div>
        </div>

        <div class="fc-cabin-col">
          <div class="fc-cabin">${cabin === 'BUSINESS' ? '💼 Business' : '✈ Economy'}</div>
        </div>

        <div class="fc-right">
          ${dealBadge}
          ${seatsBadge}
          <div class="fc-price">${sym}${price}</div>
          <div class="fc-per">per person</div>
          <button class="fc-select-btn">Select <span>→</span></button>
        </div>
      </div>
    `;
  }).join('');
}

let _nonstopOnly = false;
function filterNonstop(btn) {
  _nonstopOnly = !_nonstopOnly;
  btn.classList.toggle('active', _nonstopOnly);
  const base = window._flightsAll || window._flights || [];
  const filtered = _nonstopOnly ? base.filter(f => f.itineraries[0].segments.length === 1) : base;
  renderFlightList(filtered);
  window._flights = filtered;
}

function sortFlights(by, btn) {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const arr = [...(window._flightsAll || window._flights || [])];
  if (_nonstopOnly) arr.filter(f => f.itineraries[0].segments.length === 1);
  if (by === 'cheapest') {
    arr.sort((a,b) => parseFloat(a.price.grandTotal) - parseFloat(b.price.grandTotal));
  } else if (by === 'fastest') {
    const durMs = d => { const m = (d||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return ((+m?.[1]||0)*60+(+m?.[2]||0)); };
    arr.sort((a,b) => durMs(a.itineraries[0].duration) - durMs(b.itineraries[0].duration));
  }
  window._flights = arr;
  renderFlightList(arr);
}

function selectFlight(index) {
  selectedFlight = (window._flights || [])[index];
  showAgencyPage();
}

// ─────────────────────────────────────────────────────────────
// AGENCY COMPARISON PAGE (Skyscanner-style)
// ─────────────────────────────────────────────────────────────
function showAgencyPage() {
  const f       = selectedFlight;
  const seg     = f.itineraries[0].segments[0];
  const lastSeg = f.itineraries[0].segments[f.itineraries[0].segments.length - 1];
  const allSegs = f.itineraries[0].segments;
  const price   = parseFloat(f.price.grandTotal);
  const sym     = f.price.currency === 'EUR' ? '€' : '$';

  // Route title
  document.getElementById('agency-route-title').textContent =
    `${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}`;
  document.getElementById('agency-route-sub').textContent =
    `${formatDate(seg.departure.at)} · ${formatDuration(f.itineraries[0].duration)} · ${allSegs.length === 1 ? 'Nonstop' : allSegs.length - 1 + ' stop'}`;

  // Agencies list
  const agencies = [
    { name: 'NordicWings Direct', rating: 4.9, reviews: 1240, price: price,      perks: '✓ Instant confirmation · No hidden fees', direct: true,  stars: 5 },
    { name: 'Trip.com',       rating: 4.7, reviews: 3821, price: price+5,    perks: '✓ Pay now or pay later · 24/7 support',   direct: false, stars: 5 },
    { name: 'Mytrip',         rating: 4.3, reviews: 456,  price: price+8,    perks: '✓ Pay now or pay later',                  direct: false, stars: 4 },
    { name: 'Ticket.fi',      rating: 2.8, reviews: 108,  price: price+10,   perks: '',                                        direct: false, stars: 3 },
    { name: 'Flightnetwork',  rating: 4.2, reviews: 518,  price: price+14,   perks: '✓ 24/7 customer support',                 direct: false, stars: 4 },
    { name: 'Gotogate',       rating: 3.8, reviews: 124,  price: price+18,   perks: '✓ Support in your language',              direct: false, stars: 4 },
    { name: 'Travelis',       rating: 4.6, reviews: 224,  price: price+20,   perks: '✓ Pay now or later',                      direct: false, stars: 5 },
    { name: 'Flysmarter.fi',  rating: 3.6, reviews: 42,   price: price+23,   perks: '✓ Pay now or pay later',                  direct: false, stars: 4 },
    { name: 'lastminute.com', rating: 3.7, reviews: 118,  price: price+31,   perks: '✓ Customer support',                      direct: false, stars: 4 },
  ];

  document.getElementById('agencies-list').innerHTML = agencies.map((a, i) => `
    <div class="agency-row ${a.direct ? 'nordicwings-direct' : ''}"
         onclick="${a.direct ? 'proceedToBooking()' : `openPartnerLink('${a.name}')`}">
      <div class="agency-name-wrap">
        <div class="agency-name">
          ${a.name}
          ${a.direct ? '<span class="agency-badge badge-direct">Book Direct</span>' : '<span class="agency-badge badge-partner">Partner</span>'}
        </div>
        <div class="agency-stars">
          ${'★'.repeat(a.stars)}<span class="agency-rating">${a.rating}/5 · ${a.reviews} reviews</span>
        </div>
        ${a.perks ? `<div class="agency-perks">${a.perks}</div>` : ''}
      </div>
      <div>
        <div class="agency-price">${sym}${a.price.toFixed(0)}</div>
        <div class="agency-price-sub">per person · total</div>
      </div>
      <button class="agency-btn ${a.direct ? 'direct' : ''}">${a.direct ? 'Book Now' : 'Select'}</button>
    </div>
  `).join('');

  // Build detailed itinerary
  let itinHtml = `<div class="itin-leg"><div class="itin-leg-label">Outbound · ${formatDate(seg.departure.at)}</div>`;
  allSegs.forEach((s, idx) => {
    itinHtml += `
      <div class="itin-seg">
        <div class="itin-dot-col">
          <div class="itin-dot"></div>
          ${idx < allSegs.length - 1 ? '<div class="itin-line"></div>' : ''}
        </div>
        <div class="itin-seg-info">
          <div class="itin-seg-time">${formatTime(s.departure.at)}</div>
          <div class="itin-seg-airport">${s.departure.iataCode}</div>
          <div class="itin-seg-flight">Flight ${s.carrierCode}${s.number} · ${AIRLINE_NAMES[s.carrierCode] || s.carrierCode}</div>
          <div class="itin-seg-dur">▼ ${formatDuration(s.duration)}</div>
        </div>
        <div class="itin-seg-info" style="text-align:right;">
          <div class="itin-seg-time">${formatTime(s.arrival.at)}</div>
          <div class="itin-seg-airport">${s.arrival.iataCode}</div>
        </div>
      </div>
      ${idx < allSegs.length - 1 ? `<div class="itin-layover">🕐 Layover at ${s.arrival.iataCode} — approx 1h 30min</div>` : ''}
    `;
  });
  itinHtml += `<div class="itin-arrival">🛬 Arrives ${formatDate(lastSeg.arrival.at)} · Total: ${formatDuration(f.itineraries[0].duration)}</div></div>`;

  document.getElementById('agency-itinerary').innerHTML = itinHtml;
  showPage('agencies');
}

function proceedToBooking() {
  if (!currentUser) {
    openAuthModal('login');
    return;
  }
  setupBookingPage();
  showPage('booking');
}

function openPartnerLink(agencyName) {
  const f    = selectedFlight;
  const seg  = f.itineraries[0].segments[0];
  const last = f.itineraries[0].segments[f.itineraries[0].segments.length - 1];
  const orig = seg.departure.iataCode;
  const dest = last.arrival.iataCode;
  const date = seg.departure.at ? seg.departure.at.split('T')[0] : '';
  const pass = searchParams.passengers || 1;
  const marker = '519037'; // Your Travelpayouts marker

  // Your affiliate IDs
  const TP  = '519037';          // Travelpayouts marker
  const TC  = 'Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D15634670'; // Trip.com

  // Affiliate deep links — earn commission when users book!
  const links = {
    'Trip.com':      `https://www.trip.com/flights/list?dcity=${orig}&acity=${dest}&ddate=${date}&adult=${pass}&${TC}`,
    'Mytrip':        `https://www.mytrip.com/flights/${orig.toLowerCase()}-${dest.toLowerCase()}/?marker=${TP}`,
    'Ticket.fi':     `https://www.jetradar.com/flights/?origin=${orig}&destination=${dest}&depart_date=${date}&adults=${pass}&marker=${TP}`,
    'Flightnetwork': `https://www.flightnetwork.com/flights/${orig}-${dest}?departureDate=${date}&adults=${pass}&marker=${TP}`,
    'Gotogate':      `https://www.gotogate.com/flight/${orig}${dest}/${date}?adults=${pass}&marker=${TP}`,
    'Travelis':      `https://www.jetradar.com/flights/?origin=${orig}&destination=${dest}&depart_date=${date}&marker=${TP}`,
    'Flysmarter.fi': `https://www.jetradar.com/flights/?origin=${orig}&destination=${dest}&depart_date=${date}&marker=${TP}`,
    'lastminute.com':`https://www.lastminute.com/flights/${orig}-${dest}/?departureDate=${date}&adults=${pass}&marker=${TP}`,
  };

  // Fallback
  const fallback = `https://www.trip.com/?${TC}`;
  const url = links[agencyName] || fallback;

  window.open(url, '_blank');
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
      <p class="passenger-header">Passenger ${i}</p>
      <div class="form-row">
        <div class="form-group">
          <label>First Name</label>
          <input type="text" class="pax-first" placeholder="First name" />
        </div>
        <div class="form-group">
          <label>Last Name</label>
          <input type="text" class="pax-last" placeholder="Last name" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Date of Birth</label>
          <input type="date" class="pax-dob" />
        </div>
        <div class="form-group">
          <label>Passport / ID</label>
          <input type="text" class="pax-passport" placeholder="Passport number" />
        </div>
      </div>
    `;
  }
  document.getElementById('passenger-forms').innerHTML = formsHtml;

  // Build full route string including stopovers
  const allSegs   = selectedFlight.itineraries[0].segments;
  const stopCodes = allSegs.slice(0, -1).map(s => s.arrival.iataCode);
  const routeStr  = stopCodes.length > 0
    ? `${seg.departure.iataCode} → ${stopCodes.join(' → ')} → ${lastSeg.arrival.iataCode}`
    : `${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}`;

  const stopLabel = stopCodes.length === 0
    ? '<span style="color:#16a34a;font-size:.8rem;font-weight:600;">✅ Nonstop</span>'
    : `<span style="color:#d97706;font-size:.8rem;font-weight:600;">🔄 ${stopCodes.length} stop via ${stopCodes.join(', ')}</span>`;

  // Aircraft info per airline
  const aircraftMap = {
    'EK': 'Boeing 777-300ER', 'QR': 'Airbus A350-900',
    'BA': 'Boeing 787-9 Dreamliner', 'LH': 'Airbus A340-300',
    'TK': 'Boeing 777-300ER', 'AY': 'Airbus A330-300',
    'AF': 'Airbus A380-800', 'KL': 'Boeing 777-200',
  };
  const aircraft = aircraftMap[seg.carrierCode] || 'Boeing 737-800';
  const cabin    = selectedFlight.travelerPricings[0]?.fareDetailsBySegment[0]?.cabin || 'ECONOMY';
  const isBiz    = cabin === 'BUSINESS';

  document.getElementById('booking-flight-summary').innerHTML = `
    <div class="summary-flight-row">
      <div class="summary-route">${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}</div>
      <span class="booking-status status-confirmed" style="margin:0;">✈ Confirmed</span>
    </div>
    ${stopLabel}
    <div class="summary-times" style="margin-top:8px;">
      <strong style="font-size:1.1rem;">${formatTime(seg.departure.at)}</strong>
      <span style="color:#9ca3af;margin:0 6px;">→</span>
      <strong style="font-size:1.1rem;">${formatTime(lastSeg.arrival.at)}</strong>
    </div>
    <div class="summary-duration">${formatDate(seg.departure.at)} · Total flight time: ${formatDuration(selectedFlight.itineraries[0].duration)}</div>
    <div class="summary-duration" style="margin-top:4px;">✈ ${seg.carrierCode}${seg.number} · ${aircraft}</div>

    <!-- Flight details grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;background:#f8fafc;border-radius:8px;padding:12px;">
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Cabin Class</div>
        <div style="font-weight:700;color:#1a2b4a;">${isBiz ? '💼 Business' : '✈ Economy'}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Aircraft</div>
        <div style="font-weight:700;color:#1a2b4a;">${aircraft}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Checked Baggage</div>
        <div style="font-weight:700;color:#1a2b4a;">${isBiz ? '2 × 32kg' : '1 × 23kg'} included</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Carry-on</div>
        <div style="font-weight:700;color:#1a2b4a;">${isBiz ? '2 × 12kg' : '1 × 7kg'} included</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Meal Service</div>
        <div style="font-weight:700;color:#16a34a;">🍽 ${isBiz ? 'Multi-course dining' : 'Complimentary meal'}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Entertainment</div>
        <div style="font-weight:700;color:#16a34a;">📺 ${isBiz ? 'Private screen 23"' : 'Seatback screen'}</div>
      </div>
    </div>

    <!-- Flight itinerary -->
    <div style="margin-top:12px;padding:12px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
      <div style="font-size:.78rem;font-weight:700;color:#92400e;margin-bottom:8px;">✈ FLIGHT ITINERARY</div>
      ${allSegs.map((s, idx) => `
        <div style="font-size:.82rem;color:#374151;padding:6px 0;border-bottom:${idx < allSegs.length-1 ? '1px dashed #e5e7eb' : 'none'};">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span><strong>${s.departure.iataCode}</strong> ${formatTime(s.departure.at)}</span>
            <span style="color:#9ca3af;font-size:.75rem;">──✈──</span>
            <span><strong>${s.arrival.iataCode}</strong> ${formatTime(s.arrival.at)}</span>
          </div>
          <div style="font-size:.75rem;color:#6b7280;margin-top:2px;">
            Flight ${s.carrierCode}${s.number} · ${s.duration ? formatDuration(s.duration) : ''} · ${aircraftMap[s.carrierCode] || aircraft}
          </div>
        </div>
        ${idx < allSegs.length-1 ? `
        <div style="font-size:.78rem;color:#d97706;padding:6px 0 6px 8px;display:flex;align-items:center;gap:6px;">
          🕐 <span><strong>Layover at ${s.arrival.iataCode}</strong> — approx. 1h 30min connection time</span>
        </div>` : ''}
      `).join('')}
    </div>

    <!-- Included amenities -->
    <div style="margin-top:12px;padding:10px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
      <div style="font-size:.78rem;font-weight:700;color:#15803d;margin-bottom:6px;">✅ WHAT'S INCLUDED</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:.78rem;color:#374151;">
        <div>✓ Checked baggage</div>
        <div>✓ Carry-on bag</div>
        <div>✓ Complimentary meals</div>
        <div>✓ Beverages & snacks</div>
        <div>✓ In-flight entertainment</div>
        <div>✓ USB charging port</div>
        ${isBiz ? '<div>✓ Lie-flat bed seat</div><div>✓ Airport lounge access</div>' : '<div>✓ Blanket & pillow</div><div>✓ Wi-Fi available</div>'}
      </div>
    </div>
  `;

  const taxAmount  = parseFloat(selectedFlight.price.fees?.[0]?.amount || (price * 0.1)).toFixed(2);
  const baseAmount = (price - taxAmount).toFixed(2);
  const total      = price.toFixed(2);

  const airportTax  = (taxAmount * 0.5 * passengerCount).toFixed(2);
  const fuelSurcharge = (taxAmount * 0.3 * passengerCount).toFixed(2);
  const serviceFee  = (taxAmount * 0.2 * passengerCount).toFixed(2);

  document.getElementById('price-breakdown').innerHTML = `
    <div class="price-row"><span>Base fare × ${passengerCount}</span><span>$${(baseAmount * passengerCount).toFixed(2)}</span></div>
    <div class="price-row" style="font-size:.82rem;color:#6b7280;"><span>  Airport taxes</span><span>$${airportTax}</span></div>
    <div class="price-row" style="font-size:.82rem;color:#6b7280;"><span>  Fuel surcharge</span><span>$${fuelSurcharge}</span></div>
    <div class="price-row" style="font-size:.82rem;color:#6b7280;"><span>  Service fee</span><span>$${serviceFee}</span></div>
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  Baggage included ✓</span><span>$0.00</span></div>
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  Meals included ✓</span><span>$0.00</span></div>
    <div class="price-row total"><span>Total (USD)</span><span>$${(price * passengerCount).toFixed(2)}</span></div>
    <div style="font-size:.75rem;color:#6b7280;margin-top:6px;text-align:center;">🔒 Price guaranteed · No hidden fees</div>
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
    document.getElementById('booking-error').textContent = 'Could not load payment form. Please try again.';
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

  // Only validate if fields exist and have values
  if (firstNames.length > 0 && (firstNames.some(n => !n) || lastNames.some(n => !n))) {
    return setError(errorEl, 'Please fill in all passenger names.');
  }
  if (!email || !email.includes('@')) {
    return setError(errorEl, 'Please enter a valid email address.');
  }
  if (!phone) {
    return setError(errorEl, 'Please enter a contact phone number.');
  }
  // If Stripe elements not loaded yet, try to load it now
  if (!stripeElements) {
    setError(errorEl, 'Loading payment form... please wait.');
    await setupStripePayment(
      parseFloat(selectedFlight.price.grandTotal) * (searchParams.passengers || 1),
      selectedFlight.price.currency || 'USD'
    );
    // Give it 2 seconds to mount
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!stripeElements) {
      return setError(errorEl, 'Payment form could not load. Please refresh the page and try again.');
    }
  }

  toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', true);
  document.getElementById('pay-btn').disabled = true;

  try {
    // Confirm the Stripe payment
    const { error: stripeError } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.origin + '/?booking=confirmed',
        payment_method_data: {
          billing_details: { email, phone }
        }
      },
      redirect: 'if_required' // Don't redirect for card payments, handle result here
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
    setError(errorEl, 'Booking failed: ' + (err.message || 'Please try again.'));
  } finally {
    toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', false);
    document.getElementById('pay-btn').disabled = false;
  }
}

function showConfirmationPage(booking) {
  document.getElementById('confirmation-details').innerHTML = `
    <div><strong>Booking Reference:</strong> ${booking.bookingRef}</div>
    <div><strong>Route:</strong> ${booking.flight.from} → ${booking.flight.to}</div>
    <div><strong>Date:</strong> ${formatDate(booking.flight.departTime)}</div>
    <div><strong>Departure:</strong> ${formatTime(booking.flight.departTime)} · Arrival: ${formatTime(booking.flight.arriveTime)}</div>
    <div><strong>Flight:</strong> ${booking.flight.flightNum}</div>
    <div><strong>Passengers:</strong> ${booking.passengers.map(p => p.firstName + ' ' + p.lastName).join(', ')}</div>
    <div><strong>Total Paid:</strong> $${booking.totalPrice}</div>
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
              ${b.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
            </span>
          </div>
          <div class="booking-info">
            <div class="booking-route">${b.flight.from} → ${b.flight.to}</div>
            <div class="booking-date-time">${formatDate(b.flight.departTime)} · ${formatTime(b.flight.departTime)} – ${formatTime(b.flight.arriveTime)}</div>
            <div class="booking-date-time">${b.flight.flightNum} · ${b.flight.duration}</div>
            <div class="booking-ref">Ref: ${b.bookingRef}</div>
          </div>
          <div>
            <div class="booking-price">$${b.totalPrice}</div>
            <div class="booking-price-label">${b.passengers.length} passenger${b.passengers.length > 1 ? 's' : ''}</div>
          </div>
          ${b.status === 'confirmed' ? `
            <button class="btn-cancel" onclick="openCancelModal('${doc.id}')">
              Cancel
            </button>
          ` : '<span style="color:#9ca3af;font-size:.85rem;">Cancelled</span>'}
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
  btn.textContent = 'Cancelling...';

  try {
    await db.collection('bookings').doc(cancelBookingId).update({ status: 'cancelled' });

    // Update the card in the UI without reloading
    const card = document.getElementById('booking-' + cancelBookingId);
    if (card) {
      const statusEl = card.querySelector('.booking-status');
      if (statusEl) {
        statusEl.className = 'booking-status status-cancelled';
        statusEl.textContent = 'Cancelled';
      }
      const cancelBtn = card.querySelector('.btn-cancel');
      if (cancelBtn) {
        cancelBtn.outerHTML = '<span style="color:#9ca3af;font-size:.85rem;">Cancelled</span>';
      }
    }
  } catch (err) {
    alert('Could not cancel booking. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, Cancel';
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

  if (!email || !password) return setError(errorEl, 'Please enter your email and password.');

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

  if (!name)                   return setError(errorEl, 'Please enter your full name.');
  if (!email)                  return setError(errorEl, 'Please enter your email.');
  if (password.length < 6)     return setError(errorEl, 'Password must be at least 6 characters.');

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
    'auth/user-not-found':      'No account found with this email.',
    'auth/wrong-password':      'Incorrect password. Please try again.',
    'auth/email-already-in-use':'An account with this email already exists.',
    'auth/invalid-email':       'Please enter a valid email address.',
    'auth/weak-password':       'Password is too weak. Use at least 6 characters.',
    'auth/too-many-requests':   'Too many attempts. Please try again later.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ─────────────────────────────────────────────────────────────
// ADMIN BUSINESS DASHBOARD
// Only visible to owner (magdayaojennamae712@gmail.com)
// ─────────────────────────────────────────────────────────────
let _allAdminBookings = [];

async function loadAdminDashboard() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) {
    showPage('home'); return;
  }

  document.getElementById('admin-loading').style.display = 'flex';
  document.getElementById('admin-table').style.display   = 'none';
  document.getElementById('admin-empty').style.display   = 'none';

  try {
    const snapshot = await db.collection('bookings')
      .orderBy('createdAt', 'desc')
      .get();

    _allAdminBookings = [];
    snapshot.forEach(doc => _allAdminBookings.push({ id: doc.id, ...doc.data() }));

    document.getElementById('admin-loading').style.display = 'none';

    if (_allAdminBookings.length === 0) {
      document.getElementById('admin-empty').style.display = 'flex';
      return;
    }

    renderAdminStats(_allAdminBookings);
    renderAdminTable(_allAdminBookings);

  } catch (err) {
    console.error('Admin load error:', err);
    document.getElementById('admin-loading').style.display = 'none';
    document.getElementById('admin-empty').style.display   = 'flex';
  }
}

function renderAdminStats(bookings) {
  const total     = bookings.length;
  const confirmed = bookings.filter(b => b.status === 'confirmed').length;
  const revenue   = bookings
    .filter(b => b.status === 'confirmed')
    .reduce((sum, b) => sum + parseFloat(b.totalPrice || 0), 0);
  const customers = new Set(bookings.map(b => b.userEmail)).size;

  document.getElementById('stat-total-bookings').textContent  = total;
  document.getElementById('stat-total-revenue').textContent   = '€' + revenue.toFixed(2);
  document.getElementById('stat-total-customers').textContent = customers;
  document.getElementById('stat-confirmed').textContent       = confirmed;
}

function renderAdminTable(bookings) {
  if (!bookings.length) {
    document.getElementById('admin-table').style.display = 'none';
    document.getElementById('admin-empty').style.display = 'flex';
    return;
  }
  document.getElementById('admin-empty').style.display   = 'none';
  document.getElementById('admin-table').style.display   = 'table';

  document.getElementById('admin-table-body').innerHTML = bookings.map(b => `
    <tr>
      <td><span class="admin-ref">${b.bookingRef || '—'}</span></td>
      <td>
        <div class="admin-customer-name">${b.passengers?.[0]?.firstName || ''} ${b.passengers?.[0]?.lastName || ''}</div>
        <div class="admin-customer-email">${b.contact?.email || b.userEmail || ''}</div>
      </td>
      <td><strong>${b.flight?.from || '?'} → ${b.flight?.to || '?'}</strong></td>
      <td>${b.flight?.departTime ? formatDate(b.flight.departTime) : '\u2014'}</td>
      <td>${b.passengers?.length || 1} pax</td>
      <td><strong>$$${parseFloat(b.totalPrice || 0).toFixed(2)}</strong></td>
      <td><span class="booking-status ${b.status === 'confirmed' ? 'status-confirmed' : 'status-cancelled'}"${b.status || 'unknown'}</span></td>
    </tr>
  `).join('');
}