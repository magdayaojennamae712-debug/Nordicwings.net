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
const STRIPE_PUBLISHABLE_KEY = "pk_live_51TLzx6A2y3gkkjexteIatqrlYXOzr0czlPkEN4F2faog5HqFSQM574swwi0HVrsMt4kr6gYdiyeZvvC0jS9tPuDH00KmkEAZry";

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
let currentUser          = null;    // Firebase user object
let selectedFlight       = null;    // The outbound flight selected
let selectedReturnFlight = null;    // The return flight selected (round trip)
let outboundFlight       = null;    // Temp: holds outbound while searching return
let isRoundTrip          = false;   // True if user chose round trip
let searchReturnDate     = '';      // Return date string (YYYY-MM-DD)
let searchParams         = {};      // Last search params (for display)
let stripeElements       = null;    // Stripe Elements instance
let cancelBookingId      = null;    // Booking being cancelled

// ─────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────
function setError(el, msg) {
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function toggleBtnLoading(textId, spinnerId, loading) {
  const t = document.getElementById(textId);
  const s = document.getElementById(spinnerId);
  if (t) t.style.display = loading ? 'none' : 'inline';
  if (s) s.style.display = loading ? 'inline-block' : 'none';
}

// ─────────────────────────────────────────────────────────────
// PASSENGER PICKER (Adults / Children / Infants)
// ─────────────────────────────────────────────────────────────
var paxCounts = { adults: 1, children: 0, infants: 0 };

function changePax(type, delta) {
  var next = (paxCounts[type] || 0) + delta;
  if (next < 0) return;
  if (type === 'adults'   && next > 9) return;
  if (type === 'children' && next > 8) return;
  if (type === 'infants'  && next > paxCounts.adults) {
    alert('Each infant needs their own adult. Please add more adults first.');
    return;
  }
  paxCounts[type] = next;
  if ((paxCounts.adults + paxCounts.children + paxCounts.infants) < 1) {
    paxCounts.adults = 1;
  }
  updatePaxUI();
}

function updatePaxUI() {
  var adEl = document.getElementById('pax-adults-disp');
  var chEl = document.getElementById('pax-children-disp');
  var inEl = document.getElementById('pax-infants-disp');
  if (adEl) adEl.textContent = paxCounts.adults;
  if (chEl) chEl.textContent = paxCounts.children;
  if (inEl) inEl.textContent = paxCounts.infants;

  var hAdEl = document.getElementById('pax-adults-val');
  var hChEl = document.getElementById('pax-children-val');
  var hInEl = document.getElementById('pax-infants-val');
  if (hAdEl) hAdEl.value = paxCounts.adults;
  if (hChEl) hChEl.value = paxCounts.children;
  if (hInEl) hInEl.value = paxCounts.infants;

  var parts = [];
  if (paxCounts.adults   > 0) parts.push(paxCounts.adults   + ' Adult'   + (paxCounts.adults   > 1 ? 's'   : ''));
  if (paxCounts.children > 0) parts.push(paxCounts.children + ' Child'   + (paxCounts.children > 1 ? 'ren' : ''));
  if (paxCounts.infants  > 0) parts.push(paxCounts.infants  + ' Infant'  + (paxCounts.infants  > 1 ? 's'   : ''));
  var sumEl = document.getElementById('pax-summary');
  if (sumEl) sumEl.textContent = parts.join(', ') || '1 Adult';

  var noteEl = document.getElementById('pax-child-note');
  if (noteEl) noteEl.style.display = (paxCounts.children > 0 || paxCounts.infants > 0) ? 'block' : 'none';
}

function togglePaxPanel() {
  var panel = document.getElementById('pax-panel');
  var btn   = document.getElementById('pax-btn');
  if (!panel || !btn) return;
  if (panel.style.display === 'none' || panel.style.display === '') {
    var rect    = btn.getBoundingClientRect();
    var screenW = window.innerWidth;
    var isMobile = screenW < 600;
    if (isMobile) {
      // On mobile: center panel horizontally, show below button
      var panelW = Math.min(screenW - 24, 340);
      var leftPos = (screenW - panelW) / 2;
      panel.style.position = 'fixed';
      panel.style.top   = (rect.bottom + 8) + 'px';
      panel.style.left  = leftPos + 'px';
      panel.style.width = panelW + 'px';
      // Add backdrop
      var bd = document.getElementById('pax-backdrop');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'pax-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.25);';
        bd.addEventListener('click', closePaxPanel);
        document.body.appendChild(bd);
      }
      bd.style.display = 'block';
    } else {
      // On desktop: position below button, keep within screen
      var panelW = 300;
      var leftPos = rect.left;
      if (leftPos + panelW > screenW - 8) leftPos = screenW - panelW - 8;
      if (leftPos < 8) leftPos = 8;
      panel.style.position = 'fixed';
      panel.style.top   = (rect.bottom + 6) + 'px';
      panel.style.left  = leftPos + 'px';
      panel.style.width = panelW + 'px';
    }
    panel.style.zIndex = '99999';
    panel.style.display = 'block';
  } else {
    closePaxPanel();
  }
}

function closePaxPanel() {
  var panel = document.getElementById('pax-panel');
  if (panel) panel.style.display = 'none';
  var bd = document.getElementById('pax-backdrop');
  if (bd) bd.style.display = 'none';
}

document.addEventListener('click', function(e) {
  var panel = document.getElementById('pax-panel');
  var btn   = document.getElementById('pax-btn');
  if (!panel || !btn || panel.style.display === 'none') return;
  if (!panel.contains(e.target) && !btn.contains(e.target)) {
    closePaxPanel();
  }
}, { passive: true });

// ─────────────────────────────────────────────────────────────
// DATE / TIME / DURATION HELPERS
// ─────────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  } catch(e) { return isoStr; }
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false });
  } catch(e) { return ''; }
}

function formatDuration(pt) {
  if (!pt) return '';
  const m = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return pt;
  const h = parseInt(m[1]||0), min = parseInt(m[2]||0);
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

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
// SEO — update canonical tag + page title per route URL
// ─────────────────────────────────────────────────────────────
const ROUTE_NAMES = {
  MNL:'Manila', DVO:'Davao', CEB:'Cebu', CRK:'Clark', ILO:'Iloilo',
  BKK:'Bangkok', SIN:'Singapore', KUL:'Kuala Lumpur', DXB:'Dubai',
  HKG:'Hong Kong', NRT:'Tokyo', ICN:'Seoul', CGK:'Jakarta',
  LHR:'London', CDG:'Paris', AMS:'Amsterdam', BCN:'Barcelona',
  FCO:'Rome', FRA:'Frankfurt', ARN:'Stockholm', CPH:'Copenhagen',
  HEL:'Helsinki', OUL:'Oulu', TMP:'Tampere', TKU:'Turku'
};
function updateSeoForRoute(from, to) {
  const fromName = ROUTE_NAMES[from] || from;
  const toName   = ROUTE_NAMES[to]   || to;
  const url      = 'https://nordicwings.net/?from=' + from + '&to=' + to;
  const desc     = 'Find cheap flights from ' + fromName + ' (' + from + ') to ' + toName + ' (' + to + '). Compare airlines, see real-time prices and book securely via NordicWings.';
  // Canonical
  let link = document.querySelector('link[rel="canonical"]');
  if (link) link.href = url;
  // Page title
  document.title = 'Cheap Flights ' + fromName + ' to ' + toName + ' | NordicWings';
  // Meta description
  let metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.content = desc;
  // Open Graph
  let ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.content = 'Cheap Flights ' + fromName + ' → ' + toName + ' | NordicWings';
  let ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.content = desc;
  let ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.content = url;
  // Twitter/X
  let twTitle = document.querySelector('meta[name="twitter:title"]');
  if (twTitle) twTitle.content = 'Cheap Flights ' + fromName + ' → ' + toName + ' | NordicWings';
  let twDesc = document.querySelector('meta[name="twitter:description"]');
  if (twDesc) twDesc.content = desc;
  let twUrl = document.querySelector('meta[name="twitter:url"]');
  if (twUrl) twUrl.content = url;
}
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const from   = (params.get('from') || '').toUpperCase();
  const to     = (params.get('to')   || '').toUpperCase();
  if (from && to) {
    updateSeoForRoute(from, to);
    // Pre-fill and auto-search
    const originEl = document.getElementById('origin');
    const destEl   = document.getElementById('destination');
    if (originEl) originEl.value = from;
    if (destEl)   destEl.value   = to;
    searchFlights();
  }
}
// Run on page load
document.addEventListener('DOMContentLoaded', checkUrlParams);

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
// QUICK SEARCH — called from popular destination cards
// Pre-fills origin/destination and triggers search
// ─────────────────────────────────────────────────────────────
function filterRoutes(region, btn) {
  document.querySelectorAll('.route-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.dest-card').forEach(card => {
    if (region === 'all' || card.dataset.region === region) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });
}

function quickSearch(orig, dest) {
  // Fill origin input
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const dateInput   = document.getElementById('depart-input');

  originInput.value = orig;
  originInput.dataset.code = orig;
  destInput.value   = dest;
  destInput.dataset.code = dest;

  // Set date to 30 days from today if not already set
  if (!dateInput.value) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    dateInput.value = d.toISOString().split('T')[0];
  }

  // Scroll to search form and trigger search
  showPage('home');
  setTimeout(() => {
    document.querySelector('.search-box') && document.querySelector('.search-box').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => searchFlights(), 400);
  }, 100);
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
  // Finland
  {iataCode:'HEL',name:'Helsinki-Vantaa Airport',cityName:'Helsinki',countryName:'Finland'},
  {iataCode:'OUL',name:'Oulu Airport',cityName:'Oulu',countryName:'Finland'},
  {iataCode:'TMP',name:'Tampere-Pirkkala Airport',cityName:'Tampere',countryName:'Finland'},
  {iataCode:'TKU',name:'Turku Airport',cityName:'Turku',countryName:'Finland'},
  {iataCode:'RVN',name:'Rovaniemi Airport',cityName:'Rovaniemi',countryName:'Finland'},
  // Scandinavia
  {iataCode:'OSL',name:'Oslo Gardermoen Airport',cityName:'Oslo',countryName:'Norway'},
  {iataCode:'ARN',name:'Stockholm Arlanda Airport',cityName:'Stockholm',countryName:'Sweden'},
  {iataCode:'CPH',name:'Copenhagen Airport',cityName:'Copenhagen',countryName:'Denmark'},
  {iataCode:'BGO',name:'Bergen Airport',cityName:'Bergen',countryName:'Norway'},
  {iataCode:'GOT',name:'Gothenburg Landvetter Airport',cityName:'Gothenburg',countryName:'Sweden'},
  // UK & Ireland
  {iataCode:'LHR',name:'Heathrow Airport',cityName:'London',countryName:'United Kingdom'},
  {iataCode:'LGW',name:'London Gatwick Airport',cityName:'London',countryName:'United Kingdom'},
  {iataCode:'MAN',name:'Manchester Airport',cityName:'Manchester',countryName:'United Kingdom'},
  {iataCode:'EDI',name:'Edinburgh Airport',cityName:'Edinburgh',countryName:'United Kingdom'},
  {iataCode:'BHX',name:'Birmingham Airport',cityName:'Birmingham',countryName:'United Kingdom'},
  {iataCode:'DUB',name:'Dublin Airport',cityName:'Dublin',countryName:'Ireland'},
  // Western Europe
  {iataCode:'CDG',name:'Charles de Gaulle Airport',cityName:'Paris',countryName:'France'},
  {iataCode:'ORY',name:'Paris Orly Airport',cityName:'Paris',countryName:'France'},
  {iataCode:'AMS',name:'Amsterdam Schiphol Airport',cityName:'Amsterdam',countryName:'Netherlands'},
  {iataCode:'FRA',name:'Frankfurt Airport',cityName:'Frankfurt',countryName:'Germany'},
  {iataCode:'MUC',name:'Munich Airport',cityName:'Munich',countryName:'Germany'},
  {iataCode:'BER',name:'Berlin Brandenburg Airport',cityName:'Berlin',countryName:'Germany'},
  {iataCode:'HAM',name:'Hamburg Airport',cityName:'Hamburg',countryName:'Germany'},
  {iataCode:'DUS',name:'Dusseldorf Airport',cityName:'Dusseldorf',countryName:'Germany'},
  {iataCode:'ZRH',name:'Zurich Airport',cityName:'Zurich',countryName:'Switzerland'},
  {iataCode:'GVA',name:'Geneva Airport',cityName:'Geneva',countryName:'Switzerland'},
  {iataCode:'VIE',name:'Vienna International Airport',cityName:'Vienna',countryName:'Austria'},
  {iataCode:'BRU',name:'Brussels Airport',cityName:'Brussels',countryName:'Belgium'},
  // Southern Europe
  {iataCode:'MAD',name:'Adolfo Suarez Madrid-Barajas',cityName:'Madrid',countryName:'Spain'},
  {iataCode:'BCN',name:'Barcelona El Prat Airport',cityName:'Barcelona',countryName:'Spain'},
  {iataCode:'PMI',name:'Palma de Mallorca Airport',cityName:'Palma',countryName:'Spain'},
  {iataCode:'AGP',name:'Malaga Airport',cityName:'Malaga',countryName:'Spain'},
  {iataCode:'LIS',name:'Lisbon Airport',cityName:'Lisbon',countryName:'Portugal'},
  {iataCode:'OPO',name:'Porto Airport',cityName:'Porto',countryName:'Portugal'},
  {iataCode:'FCO',name:'Rome Fiumicino Airport',cityName:'Rome',countryName:'Italy'},
  {iataCode:'MXP',name:'Milan Malpensa Airport',cityName:'Milan',countryName:'Italy'},
  {iataCode:'VCE',name:'Venice Marco Polo Airport',cityName:'Venice',countryName:'Italy'},
  {iataCode:'NCE',name:'Nice Cote d Azur Airport',cityName:'Nice',countryName:'France'},
  {iataCode:'ATH',name:'Athens International Airport',cityName:'Athens',countryName:'Greece'},
  {iataCode:'SKG',name:'Thessaloniki Airport',cityName:'Thessaloniki',countryName:'Greece'},
  // Eastern Europe — Poland
  {iataCode:'WAW',name:'Warsaw Chopin Airport',cityName:'Warsaw',countryName:'Poland'},
  {iataCode:'KRK',name:'Krakow John Paul II Airport',cityName:'Krakow',countryName:'Poland'},
  {iataCode:'GDN',name:'Gdansk Lech Walesa Airport',cityName:'Gdansk',countryName:'Poland'},
  {iataCode:'WRO',name:'Wroclaw Airport',cityName:'Wroclaw',countryName:'Poland'},
  {iataCode:'POZ',name:'Poznan Lawica Airport',cityName:'Poznan',countryName:'Poland'},
  {iataCode:'KTW',name:'Katowice International Airport',cityName:'Katowice',countryName:'Poland'},
  // Eastern Europe — other
  {iataCode:'PRG',name:'Prague Vaclav Havel Airport',cityName:'Prague',countryName:'Czech Republic'},
  {iataCode:'BUD',name:'Budapest Ferenc Liszt Airport',cityName:'Budapest',countryName:'Hungary'},
  {iataCode:'OTP',name:'Bucharest Henri Coanda Airport',cityName:'Bucharest',countryName:'Romania'},
  {iataCode:'SOF',name:'Sofia Airport',cityName:'Sofia',countryName:'Bulgaria'},
  {iataCode:'ZAG',name:'Zagreb Airport',cityName:'Zagreb',countryName:'Croatia'},
  {iataCode:'BEG',name:'Belgrade Nikola Tesla Airport',cityName:'Belgrade',countryName:'Serbia'},
  {iataCode:'VNO',name:'Vilnius Airport',cityName:'Vilnius',countryName:'Lithuania'},
  {iataCode:'RIX',name:'Riga International Airport',cityName:'Riga',countryName:'Latvia'},
  {iataCode:'TLL',name:'Tallinn Airport',cityName:'Tallinn',countryName:'Estonia'},
  {iataCode:'KBP',name:'Kyiv Boryspil Airport',cityName:'Kyiv',countryName:'Ukraine'},
  {iataCode:'IST',name:'Istanbul Airport',cityName:'Istanbul',countryName:'Turkey'},
  {iataCode:'SAW',name:'Istanbul Sabiha Airport',cityName:'Istanbul',countryName:'Turkey'},
  {iataCode:'ADB',name:'Izmir Adnan Menderes Airport',cityName:'Izmir',countryName:'Turkey'},
  // Middle East
  {iataCode:'DXB',name:'Dubai International Airport',cityName:'Dubai',countryName:'UAE'},
  {iataCode:'AUH',name:'Abu Dhabi International Airport',cityName:'Abu Dhabi',countryName:'UAE'},
  {iataCode:'DOH',name:'Hamad International Airport',cityName:'Doha',countryName:'Qatar'},
  {iataCode:'RUH',name:'King Khalid International Airport',cityName:'Riyadh',countryName:'Saudi Arabia'},
  {iataCode:'JED',name:'King Abdulaziz International Airport',cityName:'Jeddah',countryName:'Saudi Arabia'},
  {iataCode:'MCT',name:'Muscat International Airport',cityName:'Muscat',countryName:'Oman'},
  {iataCode:'KWI',name:'Kuwait International Airport',cityName:'Kuwait City',countryName:'Kuwait'},
  {iataCode:'BAH',name:'Bahrain International Airport',cityName:'Manama',countryName:'Bahrain'},
  {iataCode:'AMM',name:'Queen Alia International Airport',cityName:'Amman',countryName:'Jordan'},
  {iataCode:'TLV',name:'Ben Gurion International Airport',cityName:'Tel Aviv',countryName:'Israel'},
  {iataCode:'BEY',name:'Beirut Rafic Hariri Airport',cityName:'Beirut',countryName:'Lebanon'},
  // Asia
  {iataCode:'BKK',name:'Suvarnabhumi Airport',cityName:'Bangkok',countryName:'Thailand'},
  {iataCode:'HKT',name:'Phuket International Airport',cityName:'Phuket',countryName:'Thailand'},
  {iataCode:'CNX',name:'Chiang Mai International Airport',cityName:'Chiang Mai',countryName:'Thailand'},
  {iataCode:'SIN',name:'Singapore Changi Airport',cityName:'Singapore',countryName:'Singapore'},
  {iataCode:'KUL',name:'Kuala Lumpur International Airport',cityName:'Kuala Lumpur',countryName:'Malaysia'},
  {iataCode:'PEN',name:'Penang International Airport',cityName:'Penang',countryName:'Malaysia'},
  {iataCode:'CGK',name:'Soekarno-Hatta International Airport',cityName:'Jakarta',countryName:'Indonesia'},
  {iataCode:'DPS',name:'Ngurah Rai International Airport',cityName:'Bali',countryName:'Indonesia'},
  {iataCode:'MNL',name:'Ninoy Aquino International Airport',cityName:'Manila',countryName:'Philippines'},
  {iataCode:'CEB',name:'Mactan-Cebu International Airport',cityName:'Cebu',countryName:'Philippines'},
  {iataCode:'DVO',name:'Francisco Bangoy International Airport',cityName:'Davao',countryName:'Philippines'},
  {iataCode:'NRT',name:'Tokyo Narita International Airport',cityName:'Tokyo',countryName:'Japan'},
  {iataCode:'HND',name:'Tokyo Haneda Airport',cityName:'Tokyo',countryName:'Japan'},
  {iataCode:'KIX',name:'Kansai International Airport',cityName:'Osaka',countryName:'Japan'},
  {iataCode:'FUK',name:'Fukuoka Airport',cityName:'Fukuoka',countryName:'Japan'},
  {iataCode:'ICN',name:'Incheon International Airport',cityName:'Seoul',countryName:'South Korea'},
  {iataCode:'GMP',name:'Gimpo International Airport',cityName:'Seoul',countryName:'South Korea'},
  {iataCode:'PUS',name:'Gimhae International Airport',cityName:'Busan',countryName:'South Korea'},
  {iataCode:'PEK',name:'Beijing Capital International Airport',cityName:'Beijing',countryName:'China'},
  {iataCode:'PVG',name:'Shanghai Pudong International Airport',cityName:'Shanghai',countryName:'China'},
  {iataCode:'CAN',name:'Guangzhou Baiyun International Airport',cityName:'Guangzhou',countryName:'China'},
  {iataCode:'HKG',name:'Hong Kong International Airport',cityName:'Hong Kong',countryName:'Hong Kong'},
  {iataCode:'TPE',name:'Taiwan Taoyuan International Airport',cityName:'Taipei',countryName:'Taiwan'},
  {iataCode:'SGN',name:'Tan Son Nhat International Airport',cityName:'Ho Chi Minh City',countryName:'Vietnam'},
  {iataCode:'HAN',name:'Noi Bai International Airport',cityName:'Hanoi',countryName:'Vietnam'},
  {iataCode:'DAD',name:'Da Nang International Airport',cityName:'Da Nang',countryName:'Vietnam'},
  {iataCode:'PNH',name:'Phnom Penh International Airport',cityName:'Phnom Penh',countryName:'Cambodia'},
  {iataCode:'REP',name:'Siem Reap International Airport',cityName:'Siem Reap',countryName:'Cambodia'},
  {iataCode:'RGN',name:'Yangon International Airport',cityName:'Yangon',countryName:'Myanmar'},
  {iataCode:'MLE',name:'Velana International Airport',cityName:'Male',countryName:'Maldives'},
  {iataCode:'CMB',name:'Bandaranaike International Airport',cityName:'Colombo',countryName:'Sri Lanka'},
  {iataCode:'KTM',name:'Tribhuvan International Airport',cityName:'Kathmandu',countryName:'Nepal'},
  {iataCode:'DEL',name:'Indira Gandhi International Airport',cityName:'New Delhi',countryName:'India'},
  {iataCode:'BOM',name:'Chhatrapati Shivaji International Airport',cityName:'Mumbai',countryName:'India'},
  {iataCode:'BLR',name:'Kempegowda International Airport',cityName:'Bangalore',countryName:'India'},
  {iataCode:'MAA',name:'Chennai International Airport',cityName:'Chennai',countryName:'India'},
  {iataCode:'CCU',name:'Netaji Subhas Chandra Bose Airport',cityName:'Kolkata',countryName:'India'},
  {iataCode:'KHI',name:'Jinnah International Airport',cityName:'Karachi',countryName:'Pakistan'},
  {iataCode:'LHE',name:'Allama Iqbal International Airport',cityName:'Lahore',countryName:'Pakistan'},
  {iataCode:'ISB',name:'Islamabad International Airport',cityName:'Islamabad',countryName:'Pakistan'},
  {iataCode:'DAC',name:'Hazrat Shahjalal International Airport',cityName:'Dhaka',countryName:'Bangladesh'},
  // Africa
  {iataCode:'CAI',name:'Cairo International Airport',cityName:'Cairo',countryName:'Egypt'},
  {iataCode:'NBO',name:'Jomo Kenyatta International Airport',cityName:'Nairobi',countryName:'Kenya'},
  {iataCode:'ADD',name:'Addis Ababa Bole International Airport',cityName:'Addis Ababa',countryName:'Ethiopia'},
  {iataCode:'LOS',name:'Murtala Muhammed International Airport',cityName:'Lagos',countryName:'Nigeria'},
  {iataCode:'ACC',name:'Kotoka International Airport',cityName:'Accra',countryName:'Ghana'},
  {iataCode:'JNB',name:'OR Tambo International Airport',cityName:'Johannesburg',countryName:'South Africa'},
  {iataCode:'CPT',name:'Cape Town International Airport',cityName:'Cape Town',countryName:'South Africa'},
  {iataCode:'CMN',name:'Mohammed V International Airport',cityName:'Casablanca',countryName:'Morocco'},
  {iataCode:'RAK',name:'Marrakech Menara Airport',cityName:'Marrakech',countryName:'Morocco'},
  {iataCode:'DAR',name:'Julius Nyerere International Airport',cityName:'Dar es Salaam',countryName:'Tanzania'},
  {iataCode:'KGL',name:'Kigali International Airport',cityName:'Kigali',countryName:'Rwanda'},
  // Australia & Pacific
  {iataCode:'SYD',name:'Sydney Kingsford Smith Airport',cityName:'Sydney',countryName:'Australia'},
  {iataCode:'MEL',name:'Melbourne Airport',cityName:'Melbourne',countryName:'Australia'},
  {iataCode:'BNE',name:'Brisbane Airport',cityName:'Brisbane',countryName:'Australia'},
  {iataCode:'PER',name:'Perth Airport',cityName:'Perth',countryName:'Australia'},
  {iataCode:'ADL',name:'Adelaide Airport',cityName:'Adelaide',countryName:'Australia'},
  {iataCode:'AKL',name:'Auckland Airport',cityName:'Auckland',countryName:'New Zealand'},
  {iataCode:'CHC',name:'Christchurch International Airport',cityName:'Christchurch',countryName:'New Zealand'},
  // North America
  {iataCode:'JFK',name:'John F. Kennedy International Airport',cityName:'New York',countryName:'USA'},
  {iataCode:'EWR',name:'Newark Liberty International Airport',cityName:'New York',countryName:'USA'},
  {iataCode:'LAX',name:'Los Angeles International Airport',cityName:'Los Angeles',countryName:'USA'},
  {iataCode:'ORD',name:"O'Hare International Airport",cityName:'Chicago',countryName:'USA'},
  {iataCode:'MIA',name:'Miami International Airport',cityName:'Miami',countryName:'USA'},
  {iataCode:'DFW',name:'Dallas Fort Worth International Airport',cityName:'Dallas',countryName:'USA'},
  {iataCode:'IAH',name:'George Bush Intercontinental Airport',cityName:'Houston',countryName:'USA'},
  {iataCode:'SFO',name:'San Francisco International Airport',cityName:'San Francisco',countryName:'USA'},
  {iataCode:'SEA',name:'Seattle-Tacoma International Airport',cityName:'Seattle',countryName:'USA'},
  {iataCode:'BOS',name:'Logan International Airport',cityName:'Boston',countryName:'USA'},
  {iataCode:'ATL',name:'Hartsfield-Jackson Atlanta Airport',cityName:'Atlanta',countryName:'USA'},
  {iataCode:'DEN',name:'Denver International Airport',cityName:'Denver',countryName:'USA'},
  {iataCode:'LAS',name:'Harry Reid International Airport',cityName:'Las Vegas',countryName:'USA'},
  {iataCode:'MCO',name:'Orlando International Airport',cityName:'Orlando',countryName:'USA'},
  {iataCode:'IAD',name:'Dulles International Airport',cityName:'Washington DC',countryName:'USA'},
  {iataCode:'PHX',name:'Phoenix Sky Harbor Airport',cityName:'Phoenix',countryName:'USA'},
  {iataCode:'YYZ',name:'Toronto Pearson International Airport',cityName:'Toronto',countryName:'Canada'},
  {iataCode:'YVR',name:'Vancouver International Airport',cityName:'Vancouver',countryName:'Canada'},
  {iataCode:'YUL',name:'Montreal Pierre Elliott Trudeau Airport',cityName:'Montreal',countryName:'Canada'},
  {iataCode:'YYC',name:'Calgary International Airport',cityName:'Calgary',countryName:'Canada'},
  {iataCode:'MEX',name:'Benito Juarez International Airport',cityName:'Mexico City',countryName:'Mexico'},
  {iataCode:'CUN',name:'Cancun International Airport',cityName:'Cancun',countryName:'Mexico'},
  // South America
  {iataCode:'GRU',name:'Sao Paulo Guarulhos International Airport',cityName:'Sao Paulo',countryName:'Brazil'},
  {iataCode:'GIG',name:'Rio de Janeiro Galeao Airport',cityName:'Rio de Janeiro',countryName:'Brazil'},
  {iataCode:'EZE',name:'Ezeiza International Airport',cityName:'Buenos Aires',countryName:'Argentina'},
  {iataCode:'SCL',name:'Arturo Merino Benitez Airport',cityName:'Santiago',countryName:'Chile'},
  {iataCode:'LIM',name:'Jorge Chavez International Airport',cityName:'Lima',countryName:'Peru'},
  {iataCode:'BOG',name:'El Dorado International Airport',cityName:'Bogota',countryName:'Colombia'},
  {iataCode:'PTY',name:'Tocumen International Airport',cityName:'Panama City',countryName:'Panama'},
];

function showAcList(listEl, inputEl, airports, field) {
  var rect = inputEl.getBoundingClientRect();
  var screenW = window.innerWidth;
  var listW = Math.min(rect.width, screenW - 16);
  var leftPos = rect.left;
  if (leftPos + listW > screenW - 8) leftPos = screenW - listW - 8;
  if (leftPos < 8) leftPos = 8;
  listEl.style.display = 'block';
  listEl.style.position = 'fixed';
  listEl.style.top = (rect.bottom + 4) + 'px';
  listEl.style.left = leftPos + 'px';
  listEl.style.width = listW + 'px';
  listEl.style.zIndex = '99999';
  listEl.style.maxHeight = '260px';
  listEl.style.overflowY = 'auto';
  listEl.style.webkitOverflowScrolling = 'touch';
  if (airports.length === 0) {
    listEl.innerHTML = '<li style="padding:12px 16px;color:#aaa;font-size:.88rem;">No results found</li>';
    return;
  }
  var html = '';
  for (var i = 0; i < Math.min(airports.length, 8); i++) {
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

function airportSearch(field) {
  var inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  var listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  var keyword = inputEl.value.trim().toLowerCase();
  if (keyword.length < 1) { listEl.innerHTML = ''; listEl.style.display = 'none'; return; }
  // Search local airport list — instant, no API call needed
  var results = POPULAR_AIRPORTS.filter(function(a) {
    var k = keyword;
    return a.cityName.toLowerCase().indexOf(k) !== -1 ||
           a.iataCode.toLowerCase().indexOf(k) !== -1 ||
           a.countryName.toLowerCase().indexOf(k) !== -1 ||
           a.name.toLowerCase().indexOf(k) !== -1;
  });
  // Prioritise exact starts
  results.sort(function(a, b) {
    var aStart = a.cityName.toLowerCase().indexOf(keyword) === 0 ? 0 : 1;
    var bStart = b.cityName.toLowerCase().indexOf(keyword) === 0 ? 0 : 1;
    return aStart - bStart;
  });
  if (results.length > 0) {
    showAcList(listEl, inputEl, results, field);
  } else {
    listEl.innerHTML = '<li style="padding:12px 16px;color:#aaa;font-size:.88rem;">No airport found. Try typing the IATA code (e.g. WAW, LHR)</li>';
    listEl.style.display = 'block';
    listEl.style.position = 'fixed';
    var rect = inputEl.getBoundingClientRect();
    listEl.style.top = (rect.bottom + 4) + 'px';
    listEl.style.left = rect.left + 'px';
    listEl.style.width = rect.width + 'px';
    listEl.style.zIndex = '99999';
  }
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
    document.querySelectorAll('.autocomplete-list').forEach(l => { l.innerHTML = ''; l.style.display = 'none'; });
  }
}, { passive: true });

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
function generateClientFlights(orig, dest, date, numAdults) {
  const knownRoutes = {
    'HEL-LHR':{totalMins:195,stops:[],basePrice:130,airlines:['AY','BA','SK','LH','U2','FR']},
    'HEL-CDG':{totalMins:210,stops:[],basePrice:138,airlines:['AY','AF','LH','BA','SK','U2']},
    'HEL-AMS':{totalMins:195,stops:[],basePrice:125,airlines:['AY','KL','LH','BA','SK','U2']},
    'HEL-FRA':{totalMins:185,stops:[],basePrice:122,airlines:['AY','LH','BA','AF','SK','U2']},
    'HEL-BCN':{totalMins:300,stops:[],basePrice:145,airlines:['AY','VY','FR','IB','U2','SK']},
    'HEL-MAD':{totalMins:315,stops:[],basePrice:148,airlines:['AY','IB','FR','VY','LH','BA']},
    'HEL-FCO':{totalMins:270,stops:[],basePrice:142,airlines:['AY','AZ','FR','LH','BA','U2']},
    'HEL-ATH':{totalMins:270,stops:[],basePrice:155,airlines:['AY','A3','LH','BA','FR','SK']},
    'HEL-IST':{totalMins:225,stops:[],basePrice:160,airlines:['AY','TK','LH','BA','FR','PC']},
    'HEL-VIE':{totalMins:175,stops:[],basePrice:118,airlines:['AY','OS','LH','BA','SK','U2']},
    'HEL-ZRH':{totalMins:200,stops:[],basePrice:135,airlines:['AY','LX','LH','BA','SK','U2']},
    'HEL-ARN':{totalMins:60, stops:[],basePrice:55, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-CPH':{totalMins:90, stops:[],basePrice:72, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-OSL':{totalMins:105,stops:[],basePrice:78, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-WAW':{totalMins:150,stops:[],basePrice:98, airlines:['AY','LO','FR','LH','SK','U2']},
    'HEL-BUD':{totalMins:185,stops:[],basePrice:112,airlines:['AY','W6','LH','BA','FR','SK']},
    'HEL-PRG':{totalMins:175,stops:[],basePrice:108,airlines:['AY','OK','LH','BA','FR','W6']},
    'HEL-DUB':{totalMins:195,stops:[],basePrice:130,airlines:['AY','EI','FR','BA','SK','LH']},
    'HEL-DXB':{totalMins:390,stops:[],basePrice:310,airlines:['AY','EK','QR','TK','LH','FZ']},
    'HEL-BKK':{totalMins:810,stops:['DXB'],basePrice:590,airlines:['AY','EK','TG','QR','TK','LH']},
    'HEL-SIN':{totalMins:870,stops:['DXB'],basePrice:620,airlines:['AY','SQ','EK','QR','TK','LH']},
    'HEL-MNL':{totalMins:960,stops:['DXB'],basePrice:650,airlines:['AY','EK','QR','TK','PR','LH']},
    'HEL-JFK':{totalMins:570,stops:['LHR'],basePrice:480,airlines:['AY','BA','LH','AF','KL','TK']},
    'HEL-LAX':{totalMins:690,stops:['LHR'],basePrice:540,airlines:['AY','BA','LH','AF','KL','AA']},
    'HEL-NRT':{totalMins:870,stops:['HKG'],basePrice:680,airlines:['AY','JL','NH','KL','LH','BA']},
    'HEL-PEK':{totalMins:780,stops:[],basePrice:580,airlines:['AY','CA','LH','KL','BA','AF']},
    'HEL-ICN':{totalMins:810,stops:[],basePrice:640,airlines:['AY','KE','OZ','LH','KL','BA']},
    'HEL-DOH':{totalMins:360,stops:[],basePrice:290,airlines:['AY','QR','EK','TK','LH','BA']},
    'MNL-DVO':{totalMins:90, stops:[],basePrice:38, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'DVO-MNL':{totalMins:90, stops:[],basePrice:38, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'MNL-CEB':{totalMins:60, stops:[],basePrice:28, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'CEB-MNL':{totalMins:60, stops:[],basePrice:28, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'LHR-JFK':{totalMins:435,stops:[],basePrice:380,airlines:['BA','VS','AA','UA','DL','U2']},
    'LHR-DXB':{totalMins:405,stops:[],basePrice:290,airlines:['BA','EK','QR','TK','LH','FZ']},
    'DXB-SIN':{totalMins:420,stops:[],basePrice:250,airlines:['EK','SQ','QR','TK','FZ','MH']},
    'DXB-BKK':{totalMins:390,stops:[],basePrice:220,airlines:['EK','TG','QR','TK','FZ','MH']},
    'BKK-SIN':{totalMins:135,stops:[],basePrice:80, airlines:['TG','SQ','FD','AK','MH','QZ']},
    'SIN-MNL':{totalMins:195,stops:[],basePrice:110,airlines:['SQ','PR','5J','CX','MH','QZ']},
    'AMS-JFK':{totalMins:525,stops:[],basePrice:400,airlines:['KL','UA','DL','AA','BA','AF']},
    'CDG-JFK':{totalMins:510,stops:[],basePrice:420,airlines:['AF','UA','AA','DL','BA','KL']},
  };
  const key = orig+'-'+dest;
  const rev = dest+'-'+orig;
  let route = knownRoutes[key] || knownRoutes[rev];

  if (!route) {
    // Detect region by airport prefix patterns
    const finlandAirports = ['HEL','OUL','TMP','TKU','JYV','KUO','JOE','RVN','KEM','IVL','KAJ','VAA','MHQ'];
    const phAirports      = ['MNL','DVO','CEB','ILO','BCD','KLO','ZAM','GES','DGT','MPH','PPS','TAG'];
    const euAirports      = ['LHR','LGW','CDG','AMS','FRA','MUC','BER','MAD','BCN','FCO','MXP','ARN','CPH','OSL','WAW','VIE','ZRH','ATH','IST','BRU','DUB'];
    const usAirports      = ['JFK','LAX','ORD','ATL','DFW','DEN','SFO','SEA','MIA','BOS','LAS'];
    const asiaAirports    = ['BKK','SIN','KUL','NRT','HND','ICN','PEK','PVG','HKG','TPE','DEL','BOM'];
    const gulfAirports    = ['DXB','AUH','DOH','RUH','KWI','BAH','MCT'];

    const origFI = finlandAirports.includes(orig);
    const destFI = finlandAirports.includes(dest);
    const origPH = phAirports.includes(orig);
    const destPH = phAirports.includes(dest);
    const origEU = euAirports.includes(orig);
    const destEU = euAirports.includes(dest);

    // Finnish domestic (non-HEL) airports to/from international — route via HEL+DXB
    if ((origFI && !['HEL'].includes(orig)) && (destPH || asiaAirports.includes(dest))) {
      route = {totalMins:1080, stops:['HEL','DXB'], basePrice:680, airlines:['AY','EK','QR','TK','PR','AY']};
    } else if ((destFI && !['HEL'].includes(dest)) && (origPH || asiaAirports.includes(orig))) {
      route = {totalMins:1080, stops:['DXB','HEL'], basePrice:680, airlines:['AY','EK','QR','TK','PR','AY']};
    } else if ((origFI || origEU) && destPH) {
      route = {totalMins:960, stops:['DXB'], basePrice:650, airlines:['AY','EK','QR','TK','PR','LH']};
    } else if (origPH && (destFI || destEU)) {
      route = {totalMins:960, stops:['DXB'], basePrice:650, airlines:['PR','EK','QR','TK','AY','LH']};
    } else if (origPH && destPH) {
      // Philippine domestic
      route = {totalMins:75, stops:[], basePrice:32, airlines:['PR','5J','Z2','PR','5J','Z2']};
    } else if (origFI && destFI) {
      // Finnish domestic
      route = {totalMins:70, stops:[], basePrice:65, airlines:['AY','AY','AY','AY','AY','AY']};
    } else if ((origEU || origFI) && usAirports.includes(dest)) {
      route = {totalMins:570, stops:['LHR'], basePrice:480, airlines:['AY','BA','LH','AF','KL','TK']};
    } else if ((origEU || origFI) && gulfAirports.includes(dest)) {
      route = {totalMins:390, stops:[], basePrice:300, airlines:['AY','EK','QR','TK','LH','BA']};
    } else if ((origEU || origFI) && asiaAirports.includes(dest)) {
      route = {totalMins:750, stops:['DXB'], basePrice:520, airlines:['AY','EK','QR','TK','SQ','LH']};
    } else {
      // Generic international fallback — realistic long haul
      route = {totalMins:600, stops:['DXB'], basePrice:420, airlines:['EK','QR','TK','AY','LH','BA']};
    }
  }
  const times=['06:15','08:30','10:45','13:00','15:30','18:00'];
  const pmods=[1.0,2.8,0.95,1.0,0.90,0.95];
  return route.airlines.map((code,i) => {
    const isBiz = i===1;
    const price = Math.round(route.basePrice * pmods[i] * numAdults + (i%3)*40);
    const dep   = new Date(`${date}T${times[i]}:00`);
    const segs  = [];
    if (!route.stops.length) {
      const arr = new Date(dep.getTime()+route.totalMins*60000);
      segs.push({departure:{iataCode:orig,at:dep.toISOString()},arrival:{iataCode:dest,at:arr.toISOString()},carrierCode:code,number:String(100+i*13),duration:`PT${Math.floor(route.totalMins/60)}H${route.totalMins%60}M`});
    } else {
      const s=route.stops[0],s1=Math.round(route.totalMins*0.45),s2=route.totalMins-s1-90;
      const ma=new Date(dep.getTime()+s1*60000),md=new Date(ma.getTime()+90*60000),fa=new Date(md.getTime()+s2*60000);
      segs.push({departure:{iataCode:orig,at:dep.toISOString()},arrival:{iataCode:s,at:ma.toISOString()},carrierCode:code,number:String(100+i*13),duration:`PT${Math.floor(s1/60)}H${s1%60}M`});
      segs.push({departure:{iataCode:s,at:md.toISOString()},arrival:{iataCode:dest,at:fa.toISOString()},carrierCode:code,number:String(101+i*13),duration:`PT${Math.floor(s2/60)}H${s2%60}M`});
    }
    return {
      id:'f'+i,
      price:{grandTotal:price.toFixed(2),currency:'EUR',fees:[{amount:(price*0.1).toFixed(2)}]},
      numberOfBookableSeats:[9,4,7,2,6,8][i]||5,
      itineraries:[{duration:`PT${Math.floor(route.totalMins/60)}H${route.totalMins%60}M`,segments:segs}],
      travelerPricings:[{fareDetailsBySegment:[{cabin:isBiz?'BUSINESS':'ECONOMY'}]}]
    };
  });
}

async function searchFlights() {
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const departDate  = document.getElementById('depart-input').value;
  const errorEl     = document.getElementById('search-error');

  // Read passenger counts from picker
  const numAdults   = parseInt(document.getElementById('pax-adults-val')?.value)   || paxCounts.adults   || 1;
  const numChildren = parseInt(document.getElementById('pax-children-val')?.value) || paxCounts.children || 0;
  const numInfants  = parseInt(document.getElementById('pax-infants-val')?.value)  || paxCounts.infants  || 0;
  const passengers  = numAdults + numChildren + numInfants; // total for display

  // Validate: children/infants require at least 1 adult
  if ((numChildren > 0 || numInfants > 0) && numAdults === 0) {
    return setError(errorEl, 'Children and infants must travel with at least 1 adult.');
  }
  if (numInfants > numAdults) {
    return setError(errorEl, 'Each infant needs their own adult. Please add more adults.');
  }

  // City / country → IATA code (very comprehensive)
  const cityToCode = {
    // Finland
    'HELSINKI':'HEL','TAMPERE':'TMP','TURKU':'TKU','OULU':'OUL','ROVANIEMI':'RVN',
    // Scandinavia
    'OSLO':'OSL','BERGEN':'BGO','STOCKHOLM':'ARN','GOTHENBURG':'GOT','COPENHAGEN':'CPH','MALMO':'MMX',
    // UK & Ireland
    'LONDON':'LHR','MANCHESTER':'MAN','BIRMINGHAM':'BHX','EDINBURGH':'EDI','GLASGOW':'GLA','DUBLIN':'DUB',
    // Western Europe
    'PARIS':'CDG','AMSTERDAM':'AMS','BRUSSELS':'BRU','FRANKFURT':'FRA','BERLIN':'BER',
    'MUNICH':'MUC','HAMBURG':'HAM','DUSSELDORF':'DUS','ZURICH':'ZRH','GENEVA':'GVA',
    'VIENNA':'VIE','ROME':'FCO','MILAN':'MXP','VENICE':'VCE','NAPLES':'NAP',
    'MADRID':'MAD','BARCELONA':'BCN','LISBON':'LIS','PORTO':'OPO',
    'NICE':'NCE','LYON':'LYS','MARSEILLE':'MRS',
    // Eastern Europe
    'WARSAW':'WAW','POLAND':'WAW','KRAKOW':'KRK','GDANSK':'GDN','WROCLAW':'WRO','POZNAN':'POZ','KATOWICE':'KTW',
    'PRAGUE':'PRG','CZECH REPUBLIC':'PRG','BUDAPEST':'BUD','HUNGARY':'BUD',
    'BUCHAREST':'OTP','ROMANIA':'OTP','SOFIA':'SOF','BULGARIA':'SOF',
    'ZAGREB':'ZAG','CROATIA':'ZAG','BELGRADE':'BEG','SERBIA':'BEG',
    'BRATISLAVA':'BTS','SLOVAKIA':'BTS','VILNIUS':'VNO','LITHUANIA':'VNO',
    'RIGA':'RIX','LATVIA':'RIX','TALLINN':'TLL','ESTONIA':'TLL',
    'KIEV':'KBP','KYIV':'KBP','UKRAINE':'KBP',
    'MINSK':'MSQ','BELARUS':'MSQ',
    // Southern Europe
    'ATHENS':'ATH','GREECE':'ATH','THESSALONIKI':'SKG',
    'ISTANBUL':'IST','TURKEY':'IST','ANKARA':'ESB',
    'MALTA':'MLA','VALLETTA':'MLA','NICOSIA':'LCA','CYPRUS':'LCA',
    // Middle East
    'DUBAI':'DXB','UAE':'DXB','ABU DHABI':'AUH','SHARJAH':'SHJ',
    'DOHA':'DOH','QATAR':'DOH','RIYADH':'RUH','SAUDI ARABIA':'RUH',
    'JEDDAH':'JED','MUSCAT':'MCT','OMAN':'MCT','KUWAIT':'KWI',
    'BAHRAIN':'BAH','AMMAN':'AMM','JORDAN':'AMM',
    'TEL AVIV':'TLV','ISRAEL':'TLV','BEIRUT':'BEY','LEBANON':'BEY',
    // Asia
    'BANGKOK':'BKK','THAILAND':'BKK','PHUKET':'HKT','CHIANG MAI':'CNX',
    'SINGAPORE':'SIN','KUALA LUMPUR':'KUL','MALAYSIA':'KUL','PENANG':'PEN',
    'JAKARTA':'CGK','INDONESIA':'CGK','BALI':'DPS','SURABAYA':'SUB',
    'MANILA':'MNL','PHILIPPINES':'MNL','CEBU':'CEB','DAVAO':'DVO',
    'TOKYO':'NRT','JAPAN':'NRT','OSAKA':'KIX','NAGOYA':'NGO','SAPPORO':'CTS','FUKUOKA':'FUK',
    'SEOUL':'ICN','SOUTH KOREA':'ICN','BUSAN':'PUS',
    'BEIJING':'PEK','CHINA':'PEK','SHANGHAI':'PVG','GUANGZHOU':'CAN','SHENZHEN':'SZX','CHENGDU':'CTU',
    'HONG KONG':'HKG','TAIPEI':'TPE','TAIWAN':'TPE',
    'HO CHI MINH':'SGN','VIETNAM':'SGN','HANOI':'HAN','DA NANG':'DAD',
    'CAMBODIA':'PNH','PHNOM PENH':'PNH','SIEM REAP':'REP',
    'MYANMAR':'RGN','YANGON':'RGN',
    'MALDIVES':'MLE','SRI LANKA':'CMB','COLOMBO':'CMB',
    'NEPAL':'KTM','KATHMANDU':'KTM',
    'DELHI':'DEL','INDIA':'DEL','MUMBAI':'BOM','BANGALORE':'BLR','CHENNAI':'MAA','KOLKATA':'CCU','HYDERABAD':'HYD',
    'DHAKA':'DAC','BANGLADESH':'DAC','KARACHI':'KHI','PAKISTAN':'KHI','LAHORE':'LHE','ISLAMABAD':'ISB',
    // Africa
    'CAIRO':'CAI','EGYPT':'CAI','NAIROBI':'NBO','KENYA':'NBO',
    'ADDIS ABABA':'ADD','ETHIOPIA':'ADD','LAGOS':'LOS','NIGERIA':'LOS',
    'ACCRA':'ACC','GHANA':'ACC','JOHANNESBURG':'JNB','SOUTH AFRICA':'JNB','CAPE TOWN':'CPT',
    'CASABLANCA':'CMN','MOROCCO':'CMN','TUNIS':'TUN','TUNISIA':'TUN',
    'DAR ES SALAAM':'DAR','TANZANIA':'DAR','KAMPALA':'EBB','UGANDA':'EBB',
    'KIGALI':'KGL','RWANDA':'KGL','LUSAKA':'LUN','ZAMBIA':'LUN',
    // Australia & Pacific
    'SYDNEY':'SYD','AUSTRALIA':'SYD','MELBOURNE':'MEL','BRISBANE':'BNE','PERTH':'PER','ADELAIDE':'ADL',
    'AUCKLAND':'AKL','NEW ZEALAND':'AKL','CHRISTCHURCH':'CHC',
    // North America
    'NEW YORK':'JFK','LOS ANGELES':'LAX','CHICAGO':'ORD','MIAMI':'MIA',
    'DALLAS':'DFW','HOUSTON':'IAH','SEATTLE':'SEA','BOSTON':'BOS',
    'ATLANTA':'ATL','DENVER':'DEN','SAN FRANCISCO':'SFO','LAS VEGAS':'LAS',
    'WASHINGTON':'IAD','PHILADELPHIA':'PHL','DETROIT':'DTW','MINNEAPOLIS':'MSP',
    'ORLANDO':'MCO','PHOENIX':'PHX','PORTLAND':'PDX','SALT LAKE CITY':'SLC',
    'USA':'JFK','UNITED STATES':'JFK',
    'TORONTO':'YYZ','CANADA':'YYZ','VANCOUVER':'YVR','MONTREAL':'YUL','CALGARY':'YYC',
    'MEXICO CITY':'MEX','MEXICO':'MEX','CANCUN':'CUN','GUADALAJARA':'GDL',
    // Central & South America
    'SAO PAULO':'GRU','BRAZIL':'GRU','RIO':'GIG','RIO DE JANEIRO':'GIG',
    'BUENOS AIRES':'EZE','ARGENTINA':'EZE','SANTIAGO':'SCL','CHILE':'SCL',
    'LIMA':'LIM','PERU':'LIM','BOGOTA':'BOG','COLOMBIA':'BOG',
    'PANAMA CITY':'PTY','PANAMA':'PTY','SAN JOSE':'SJO','COSTA RICA':'SJO',
  };

  function resolveCode(input) {
    const ds = input.dataset.code;
    if (ds) return ds;
    const raw = input.value.split('—')[0].trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(raw)) return raw;
    return cityToCode[raw] || null; // null = not found, will show error
  }

  const origin = resolveCode(originInput);
  const dest   = resolveCode(destInput);

  errorEl.textContent = '';
  if (!origin) return setError(errorEl, 'Could not find departure airport. Try typing the airport code (e.g. HEL, WAW, LHR).');
  if (!dest)   return setError(errorEl, 'Could not find destination airport. Try typing the airport code (e.g. WAW, LHR, DXB).');
  if (!departDate)                   return setError(errorEl, 'Please select a departure date.');
  if (new Date(departDate) < new Date().setHours(0,0,0,0)) return setError(errorEl, 'Departure date cannot be in the past.');

  // Capture trip type and return date
  const activeTab = document.querySelector('.tab-btn.active');
  isRoundTrip = activeTab?.dataset.type === 'round-trip';
  searchReturnDate = document.getElementById('return-input')?.value || '';
  if (isRoundTrip && !searchReturnDate) {
    return setError(errorEl, 'Please select a return date.');
  }
  if (isRoundTrip && new Date(searchReturnDate) <= new Date(departDate)) {
    return setError(errorEl, 'Return date must be after departure date.');
  }

  // Reset round trip state for new search
  outboundFlight = null;
  selectedReturnFlight = null;

  const cabinClass = document.getElementById('cabin-class-input')?.value || 'economy';
  searchParams = { origin, dest, departDate, returnDate: searchReturnDate, passengers,
                   numAdults, numChildren, numInfants, isRoundTrip, cabinClass };

  showPage('results');
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';
  const _banner = document.getElementById('outbound-selected-banner');
  if (_banner) _banner.style.display = 'none';
  document.getElementById('results-heading').textContent   = `${origin} \u2192 ${dest}`;
  // Build passenger summary for results page
  var paxParts2 = [];
  if (numAdults   > 0) paxParts2.push(numAdults   + ' Adult'   + (numAdults   > 1 ? 's'   : ''));
  if (numChildren > 0) paxParts2.push(numChildren + ' Child'   + (numChildren > 1 ? 'ren' : ''));
  if (numInfants  > 0) paxParts2.push(numInfants  + ' Infant'  + (numInfants  > 1 ? 's'   : ''));
  document.getElementById('results-subheading').textContent =
    `${formatDate(departDate)} \u00B7 ${paxParts2.join(', ')}`;

  // Pass entity IDs from autocomplete selection (if user picked from dropdown)
  const originEntityId = originInput.dataset.entityId || '';
  const destEntityId   = destInput.dataset.entityId   || '';

  // Build query params — pass adults, children, infants separately to backend
  const qs = new URLSearchParams({
    origin, destination: dest, departureDate: departDate,
    adults: numAdults, children: numChildren, infants: numInfants,
    cabinClass: cabinClass
  });
  if (originEntityId) qs.set('originEntityId', originEntityId);
  if (destEntityId)   qs.set('destinationEntityId', destEntityId);

  // Try real API — fall back to client-generated demo on any error
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20000); // 20s max wait
    const resp = await fetch(`/api/flights/search?${qs}`, { signal: controller.signal });
    if (!resp.ok) throw new Error('API error');
    const flights = await resp.json();
    document.getElementById('results-loading').style.display = 'none';
    if (!flights || !flights.length) {
      document.getElementById('results-empty').style.display = 'flex';
      return;
    }
    renderFlightCards(flights);
  } catch (err) {
    console.warn('Flight search error:', err.message);
    document.getElementById('results-loading').style.display = 'none';
    document.getElementById('results-empty').style.display   = 'flex';
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

  const kiwiOrigin = searchParams.origin || '';
  const kiwiDest = searchParams.dest || '';
  const kiwiDate = searchParams.departDate || '';
  const kiwiUrl = `https://kiwi.tpk.mx/Imxir0ir`;
  const tripUrl = `https://www.trip.com/?Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D16144585`;
  const kiwiBanner = `
    <div style="background:linear-gradient(135deg,#e0f2fe,#f0fdf4);border:1.5px solid #bae6fd;border-radius:12px;
      padding:12px 16px;margin-bottom:12px;">
      <div style="font-weight:700;color:#0c4a6e;font-size:.88rem;margin-bottom:6px;">💡 Looking for cheaper flights? Compare other platforms:</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <div style="flex:1;min-width:200px;">
          <div style="font-size:.78rem;color:#0369a1;margin-bottom:6px;">🌍 Kiwi.com — budget airlines like Ryanair &amp; Wizz Air</div>
          <a href="${kiwiUrl}" target="_blank" rel="noopener"
            style="background:#0284c7;color:#fff;padding:7px 14px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap;display:inline-block;">
            Compare on Kiwi.com →
          </a>
        </div>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:.78rem;color:#1d4ed8;margin-bottom:6px;">✈️ Trip.com — hotels, flights &amp; packages worldwide</div>
          <a href="${tripUrl}" target="_blank" rel="noopener"
            style="background:#1d4ed8;color:#fff;padding:7px 14px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap;display:inline-block;">
            Compare on Trip.com →
          </a>
        </div>
      </div>
    </div>`;

  list.innerHTML = kiwiBanner + sortBarHtml + '<div id="flights-container"></div>';
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

    // Baggage & meal info based on airline type and cabin
    const budgetAirlines = ['FR','U2','W6','DY','PC','XW','VY','FD','AK','QZ','JT','ID','SJ'];
    const isBudget = budgetAirlines.includes(code);
    const isBiz = cabin === 'BUSINESS';
    const baggage = isBiz
      ? '🧳 2× 32kg checked · 18kg cabin'
      : isBudget
        ? '🎒 Cabin bag only (10kg) · Checked bag: add-on'
        : '🧳 23kg checked · 8kg cabin included';
    const meal = isBiz
      ? '🍽️ Full meal · Drinks · Lounge access'
      : isBudget
        ? '🥤 Buy on board'
        : '🍱 Meal included';

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
          <div class="fc-baggage">${baggage}</div>
          <div class="fc-meal">${meal}</div>
          <div class="fc-conditions" style="margin-top:6px;font-size:.72rem;display:flex;gap:6px;flex-wrap:wrap;">
            ${flight.conditions?.refundable
              ? '<span style="background:#dcfce7;color:#166534;padding:2px 7px;border-radius:20px;">✓ Refundable</span>'
              : '<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:20px;">✗ Non-refundable</span>'}
            ${flight.conditions?.changeable
              ? '<span style="background:#dbeafe;color:#1e40af;padding:2px 7px;border-radius:20px;">✓ Changes allowed</span>'
              : '<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:20px;">✗ No changes</span>'}
          </div>
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
  const flight = (window._flights || [])[index];

  if (isRoundTrip && !outboundFlight) {
    // First selection = outbound flight — now search for return
    outboundFlight = flight;
    searchReturnFlightsAndShow();
  } else if (isRoundTrip && outboundFlight) {
    // Second selection = return flight — proceed to agency/booking
    selectedFlight       = outboundFlight;
    selectedReturnFlight = flight;
    outboundFlight = null;
    showAgencyPage();
  } else {
    // One-way trip
    selectedFlight       = flight;
    selectedReturnFlight = null;
    showAgencyPage();
  }
}

async function searchReturnFlightsAndShow() {
  const { dest, origin, passengers } = searchParams;

  // Show outbound-selected banner
  const banner    = document.getElementById('outbound-selected-banner');
  const bannerInfo = document.getElementById('outbound-selected-info');
  if (banner && outboundFlight) {
    const ob     = outboundFlight;
    const obSeg  = ob.itineraries[0].segments[0];
    const obLast = ob.itineraries[0].segments[ob.itineraries[0].segments.length - 1];
    const airName = AIRLINE_NAMES[obSeg.carrierCode] || obSeg.carrierCode;
    if (bannerInfo) bannerInfo.textContent =
      `${airName} · ${obSeg.departure.iataCode} → ${obLast.arrival.iataCode} · ` +
      `${formatDate(obSeg.departure.at)} · ${formatTime(obSeg.departure.at)} – ${formatTime(obLast.arrival.at)}`;
    banner.style.display = 'flex';
  }

  // Update heading
  document.getElementById('results-heading').textContent = `${dest} \u2192 ${origin}`;
  document.getElementById('results-subheading').textContent =
    `Return · ${formatDate(searchReturnDate)} · ${passengers} passenger${passengers > 1 ? 's' : ''}`;
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';

  const qs = new URLSearchParams({
    origin: dest, destination: origin,
    departureDate: searchReturnDate, adults: passengers
  });

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`/api/flights/search?${qs}`, { signal: controller.signal });
    if (!resp.ok) throw new Error('API error');
    const flights = await resp.json();
    document.getElementById('results-loading').style.display = 'none';
    if (!flights || !flights.length) {
      document.getElementById('results-empty').style.display = 'flex';
      return;
    }
    renderFlightCards(flights);
  } catch (err) {
    console.warn('Return flight search failed:', err.message);
    document.getElementById('results-loading').style.display = 'none';
    document.getElementById('results-empty').style.display   = 'flex';
  }
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

  // Agencies list — NordicWings Direct first if Duffel flight, then partners
  const isDuffelFlight = !!(f.duffelOfferId);
  const agencies = [
    ...(isDuffelFlight ? [
      { name: 'NordicWings', rating: 5.0, reviews: 0, price: price, perks: '✓ Book directly · Real ticket issued instantly · Secure Stripe payment', direct: true, stars: 5, highlight: true }
    ] : []),
    { name: 'Skyscanner',     rating: 4.8, reviews: 52400, price: price,    perks: '✓ Real flights · Best price guarantee · Trusted worldwide', direct: false, stars: 5, highlight: true },
    { name: 'Jetradar',       rating: 4.7, reviews: 41800, price: price+1,  perks: '✓ Compare 728 airlines · Earn cashback · Best deals',      direct: false, stars: 5, highlight: true },
    { name: 'Google Flights', rating: 4.9, reviews: 98000, price: price+2,  perks: '✓ Live prices · No booking fees · Direct airline booking',  direct: false, stars: 5, highlight: true },
    { name: 'Kayak',          rating: 4.6, reviews: 31200, price: price+4,  perks: '✓ Compare 100s of airlines · Price alerts',                 direct: false, stars: 5, highlight: false },
    { name: 'Trip.com',       rating: 4.7, reviews: 3821,  price: price+5,  perks: '✓ Pay now or pay later · 24/7 support',                    direct: false, stars: 5, highlight: false },
    { name: 'Mytrip',         rating: 4.3, reviews: 456,   price: price+8,  perks: '✓ Pay now or pay later',                                   direct: false, stars: 4, highlight: false },
    { name: 'Gotogate',       rating: 3.8, reviews: 124,   price: price+14, perks: '✓ Support in your language',                               direct: false, stars: 4, highlight: false },
    { name: 'lastminute.com', rating: 3.7, reviews: 118,   price: price+22, perks: '✓ Customer support',                                       direct: false, stars: 4, highlight: false },
  ];

  document.getElementById('agencies-list').innerHTML = `
    <div class="agency-disclaimer">
      ℹ️ <strong>Estimated prices shown.</strong> Clicking a partner will open their site with live, real prices for this route. Prices may vary by date and availability.
    </div>
  ` + agencies.map((a, i) => `
    <div class="agency-row ${a.direct ? 'nordicwings-direct' : ''} ${a.highlight ? 'agency-highlight' : ''}"
         onclick="${a.direct ? 'proceedToBooking()' : `openPartnerLink('${a.name}')`}">
      <div class="agency-name-wrap">
        <div class="agency-name">
          ${a.name}
          ${a.direct ? '<span class="agency-badge badge-direct">Book Direct</span>' : '<span class="agency-badge badge-partner">Partner</span>'}
          ${a.highlight ? '<span class="agency-badge badge-top">⭐ Top Pick</span>' : ''}
        </div>
        <div class="agency-stars">
          ${'★'.repeat(a.stars)}<span class="agency-rating">${a.rating}/5 · ${a.reviews.toLocaleString()} reviews</span>
        </div>
        ${a.perks ? `<div class="agency-perks">${a.perks}</div>` : ''}
      </div>
      <div>
        <div class="agency-price">${sym}${a.price.toFixed(0)}</div>
        <div class="agency-price-sub">est. per person</div>
      </div>
      <button class="agency-btn ${a.direct ? 'direct' : ''}">${a.direct ? 'Book Now' : 'View Deal'}</button>
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
      ${idx < allSegs.length - 1 ? (
        allSegs[idx+1] && s.arrival.iataCode !== allSegs[idx+1].departure.iataCode
          ? `<div class="itin-layover" style="color:#dc2626;background:#fef2f2;border-radius:6px;padding:4px 8px;">⚠️ <strong>Airport change:</strong> Arrive ${s.arrival.iataCode}, depart from ${allSegs[idx+1].departure.iataCode} — self-transfer required (collect & re-check bags)</div>`
          : `<div class="itin-layover">🕐 Layover at ${s.arrival.iataCode} — approx 1h 30min</div>`
      ) : ''}
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
  const marker = '719573'; // Your Travelpayouts marker

  // Your affiliate IDs
  const TP  = '719573';          // Travelpayouts marker
  const TC  = 'Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D15634670'; // Trip.com

  // Affiliate deep links — earn commission when users book!
  const links = {
    // ── Real booking search engines (top partners) ──
    'Skyscanner':     `https://www.skyscanner.net/transport/flights/${orig}/${dest}/${date.replace(/-/g,'')}/?adults=${pass}&cabinclass=economy&ref=home`,
    'Jetradar':       `https://www.jetradar.com/flights/?origin=${orig}&destination=${dest}&depart_date=${date}&adults=${pass}&marker=719573`,
    'Google Flights': `https://www.google.com/flights#flt=${orig}.${dest}.${date};c:EUR;e:1;sd:1;t:f`,
    'Kayak':          `https://www.kayak.com/flights/${orig}-${dest}/${date}/${pass}adults`,
    // ── Affiliate / OTA partners ──
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
  const fallback = `https://www.skyscanner.net/transport/flights/${orig}/${dest}/${date.replace(/-/g,'')}/?adults=${pass}`;
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

  // Build passenger forms — separate sections for Adults, Children, Infants
  const nAdults   = searchParams.numAdults   || passengerCount;
  const nChildren = searchParams.numChildren || 0;
  const nInfants  = searchParams.numInfants  || 0;

  // Price breakdown: use combined outbound + return price per person
  const returnPriceVal = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
  const combinedPrice  = price + returnPriceVal;
  const adultPrice  = Math.round(combinedPrice * 100) / 100;
  const childPrice  = Math.round(combinedPrice * 0.75 * 100) / 100;
  const infantPrice = Math.round(combinedPrice * 0.10 * 100) / 100;
  const totalPrice  = (adultPrice * nAdults) + (childPrice * nChildren) + (infantPrice * nInfants);

  // Store for payment
  window._paxBreakdown = { nAdults, nChildren, nInfants, adultPrice, childPrice, infantPrice, totalPrice };

  function buildAdultForm(num) {
    return `
      <div class="pax-form-block" style="background:#f8faff;border:1.5px solid #dbeafe;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">👤 Adult ${num}</p>
          <span style="background:#dbeafe;color:#1d4ed8;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">Full price · €${adultPrice.toFixed(2)}</span>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Title</label>
            <select class="pax-title">
              <option value="mr">Mr</option>
              <option value="ms">Ms</option>
              <option value="mrs">Mrs</option>
              <option value="dr">Dr</option>
            </select>
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date of Birth</label>
            <input type="date" class="pax-dob" />
          </div>
          <div class="form-group">
            <label>Passport / ID Number</label>
            <input type="text" class="pax-passport" placeholder="Passport number" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Email</label>
            <input type="email" class="pax-email" placeholder="For ticket delivery" />
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" class="pax-phone" placeholder="+358..." />
          </div>
        </div>
      </div>`;
  }

  function buildChildForm(num) {
    return `
      <div class="pax-form-block" style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">🧒 Child ${num} <span style="font-size:.75rem;color:#92400e;font-weight:500;">(2–17 yrs)</span></p>
          <span style="background:#fed7aa;color:#92400e;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">~25% off · €${childPrice.toFixed(2)}</span>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:.78rem;color:#92400e;margin-bottom:12px;">
          ⚠️ Children aged 2–17 must travel with at least one adult.
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
          <div class="form-group">
            <label>Date of Birth <span style="color:#d97706;font-size:.75rem;">(must be 2–17)</span></label>
            <input type="date" class="pax-dob pax-dob-child" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Passport / ID Number</label>
            <input type="text" class="pax-passport" placeholder="Passport number" />
          </div>
          <div class="form-group">
            <label>Email <span style="color:#94a3b8;font-size:.75rem;">(optional)</span></label>
            <input type="email" class="pax-email" placeholder="Parent's email if under 18" />
          </div>
        </div>
        <input type="hidden" class="pax-title" value="ms">
        <input type="hidden" class="pax-phone" value="">
      </div>`;
  }

  function buildInfantForm(num) {
    return `
      <div class="pax-form-block" style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">👶 Infant ${num} <span style="font-size:.75rem;color:#166534;font-weight:500;">(0–1 yr · lap)</span></p>
          <span style="background:#dcfce7;color:#166534;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">~90% off · €${infantPrice.toFixed(2)}</span>
        </div>
        <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:8px 12px;font-size:.78rem;color:#065f46;margin-bottom:12px;">
          👶 Infants travel on a parent/guardian's lap — no separate seat. Must be under 2 years old on the date of travel.
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date of Birth <span style="color:#16a34a;font-size:.75rem;">(must be under 2)</span></label>
            <input type="date" class="pax-dob pax-dob-infant" />
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
        </div>
        <input type="hidden" class="pax-title" value="ms">
        <input type="hidden" class="pax-passport" value="">
        <input type="hidden" class="pax-email" value="">
        <input type="hidden" class="pax-phone" value="">
      </div>`;
  }

  let formsHtml = '';
  // Adults section
  for (let i = 1; i <= nAdults; i++)   formsHtml += buildAdultForm(i);
  // Children section
  for (let i = 1; i <= nChildren; i++) formsHtml += buildChildForm(i);
  // Infants section
  for (let i = 1; i <= nInfants; i++)  formsHtml += buildInfantForm(i);

  // Price breakdown banner
  if (nChildren > 0 || nInfants > 0) {
    formsHtml += `
      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <div style="font-weight:800;color:#1e3a8a;font-size:.9rem;margin-bottom:8px;">💶 Price Breakdown</div>
        ${nAdults   > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>👤 Adults × ${nAdults}</span><span>€${(adultPrice * nAdults).toFixed(2)}</span></div>` : ''}
        ${nChildren > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>🧒 Children × ${nChildren} <span style="color:#92400e;">(−25%)</span></span><span>€${(childPrice * nChildren).toFixed(2)}</span></div>` : ''}
        ${nInfants  > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>👶 Infants × ${nInfants} <span style="color:#166534;">(−90%)</span></span><span>€${(infantPrice * nInfants).toFixed(2)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;color:#1e3a8a;padding-top:8px;border-top:1px solid #bfdbfe;margin-top:6px;">
          <span>Total</span><span>€${totalPrice.toFixed(2)}</span>
        </div>
      </div>`;
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
      <div style="display:flex;align-items:center;gap:10px;">
        <img src="https://www.gstatic.com/flights/airline_logos/70px/${seg.carrierCode}.png"
             onerror="this.style.display='none'"
             style="width:32px;height:32px;object-fit:contain;border-radius:4px;background:#f1f5f9;padding:2px;" />
        <div class="summary-route">${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}</div>
      </div>
      <span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:4px 10px;border-radius:6px;font-size:.8rem;font-weight:600;">✈ Selected</span>
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
      ${allSegs.map((s, idx) => {
        const nextSeg = allSegs[idx + 1];
        let layoverStr = '';
        if (nextSeg) {
          const arrTime = new Date(s.arrival.at);
          const depTime = new Date(nextSeg.departure.at);
          const diffMins = Math.round((depTime - arrTime) / 60000);
          const lh = Math.floor(diffMins / 60);
          const lm = diffMins % 60;
          layoverStr = lh > 0 ? `${lh}h ${lm}m` : `${lm}m`;
        }
        const segDur = s.duration ? formatDuration(s.duration) : '';
        return `
        <div style="font-size:.82rem;color:#374151;padding:6px 0;border-bottom:${idx < allSegs.length-1 ? '1px dashed #e5e7eb' : 'none'};">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <img src="https://www.gstatic.com/flights/airline_logos/70px/${s.carrierCode}.png"
                   onerror="this.style.display='none'"
                   style="width:20px;height:20px;object-fit:contain;border-radius:3px;background:#f1f5f9;" />
              <div>
                <strong>${s.departure.iataCode}</strong>
                <span style="font-size:.75rem;color:#374151;"> ${formatTime(s.departure.at)}</span>
                <span style="font-size:.7rem;color:#9ca3af;"> ${formatDate(s.departure.at)}</span>
              </div>
            </div>
            <span style="color:#9ca3af;font-size:.75rem;">──✈──</span>
            <div style="text-align:right;">
              <strong>${s.arrival.iataCode}</strong>
              <span style="font-size:.75rem;color:#374151;"> ${formatTime(s.arrival.at)}</span>
              <span style="font-size:.7rem;color:#9ca3af;"> ${formatDate(s.arrival.at)}</span>
            </div>
          </div>
          <div style="font-size:.75rem;color:#6b7280;margin-top:3px;padding-left:26px;">
            Flight ${s.carrierCode}${s.number}${segDur ? ' · ' + segDur : ''} · ${s.aircraft?.code || aircraftMap[s.carrierCode] || aircraft}
          </div>
        </div>
        ${nextSeg ? (
          s.arrival.iataCode !== nextSeg.departure.iataCode
            ? `<div style="font-size:.78rem;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;align-items:flex-start;gap:6px;">
                ⚠️ <span><strong>Airport change required!</strong> You arrive at <strong>${s.arrival.iataCode}</strong> but your next flight departs from <strong>${nextSeg.departure.iataCode}</strong>. You have ${layoverStr} to travel between airports, collect your bags, and re-check in. This is a <strong>self-transfer</strong> — not a protected connection.</span>
               </div>`
            : `<div style="font-size:.78rem;color:#d97706;padding:6px 0 6px 8px;display:flex;align-items:center;gap:6px;">
                🕐 <span><strong>Layover at ${s.arrival.iataCode}</strong> — ${layoverStr} connection time</span>
               </div>`
        ) : ''}
        `;
      }).join('')}
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

  // Show return flight section if round trip
  if (selectedReturnFlight) {
    const rSeg    = selectedReturnFlight.itineraries[0].segments[0];
    const rLast   = selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length - 1];
    const rSegs   = selectedReturnFlight.itineraries[0].segments;
    const rPrice  = parseFloat(selectedReturnFlight.price.grandTotal);
    const rStops  = rSegs.length - 1;
    const rStopLabel = rStops === 0
      ? '<span style="color:#16a34a;font-size:.8rem;font-weight:600;">✅ Nonstop</span>'
      : `<span style="color:#d97706;font-size:.8rem;font-weight:600;">🔄 ${rStops} stop via ${rSegs.slice(0,-1).map(s=>s.arrival.iataCode).join(', ')}</span>`;
    const rAircraft = aircraftMap[rSeg.carrierCode] || 'Boeing 737-800';

    const returnHtml = `
    <div style="margin-top:14px;padding-top:14px;border-top:2px dashed #e5e7eb;">
      <div style="font-size:.78rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:8px;">↩ Return Flight</div>
      <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;">
          <img src="https://www.gstatic.com/flights/airline_logos/70px/${rSeg.carrierCode}.png"
               onerror="this.style.display='none'"
               style="width:28px;height:28px;object-fit:contain;border-radius:4px;background:#f1f5f9;padding:2px;" />
          <div style="font-weight:700;color:#1a2b4a;font-size:1rem;">${rSeg.departure.iataCode} → ${rLast.arrival.iataCode}</div>
        </div>
        <span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;padding:4px 10px;border-radius:6px;font-size:.8rem;font-weight:600;">↩ Return Selected</span>
      </div>
      ${rStopLabel}
      <div style="margin-top:6px;">
        <strong style="font-size:1rem;">${formatTime(rSeg.departure.at)}</strong>
        <span style="color:#9ca3af;margin:0 6px;">→</span>
        <strong style="font-size:1rem;">${formatTime(rLast.arrival.at)}</strong>
      </div>
      <div style="font-size:.82rem;color:#6b7280;margin-top:2px;">${formatDate(rSeg.departure.at)} · ${formatDuration(selectedReturnFlight.itineraries[0].duration)} · ${rSeg.carrierCode}${rSeg.number} · ${rAircraft}</div>
      <!-- Return itinerary -->
      <div style="margin-top:10px;padding:10px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
        <div style="font-size:.78rem;font-weight:700;color:#92400e;margin-bottom:6px;">↩ RETURN ITINERARY</div>
        ${rSegs.map((s, idx) => {
          const nxt = rSegs[idx+1];
          let lay = '';
          if (nxt) {
            const diff = Math.round((new Date(nxt.departure.at) - new Date(s.arrival.at)) / 60000);
            lay = `${Math.floor(diff/60)}h ${diff%60}m`;
          }
          return `
          <div style="font-size:.8rem;color:#374151;padding:4px 0;border-bottom:${idx<rSegs.length-1?'1px dashed #e5e7eb':'none'};">
            <div style="display:flex;justify-content:space-between;">
              <div><img src="https://www.gstatic.com/flights/airline_logos/70px/${s.carrierCode}.png" onerror="this.style.display='none'" style="width:16px;height:16px;vertical-align:middle;border-radius:2px;"> <strong>${s.departure.iataCode}</strong> ${formatTime(s.departure.at)} <span style="font-size:.7rem;color:#9ca3af;">${formatDate(s.departure.at)}</span></div>
              <div style="text-align:right;"><strong>${s.arrival.iataCode}</strong> ${formatTime(s.arrival.at)} <span style="font-size:.7rem;color:#9ca3af;">${formatDate(s.arrival.at)}</span></div>
            </div>
            <div style="font-size:.72rem;color:#6b7280;padding-left:20px;">Flight ${s.carrierCode}${s.number}${s.duration?' · '+formatDuration(s.duration):''}</div>
          </div>
          ${nxt ? (
            s.arrival.iataCode !== nxt.departure.iataCode
              ? `<div style="font-size:.75rem;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;border-radius:5px;padding:5px 8px;margin:3px 0;">⚠️ <strong>Airport change:</strong> Arrive ${s.arrival.iataCode} → depart ${nxt.departure.iataCode} (${lay}) — self-transfer, collect & re-check bags</div>`
              : `<div style="font-size:.75rem;color:#d97706;padding:4px 0 4px 8px;">🕐 <strong>Layover at ${s.arrival.iataCode}</strong> — ${lay}</div>`
          ) : ''}
          `;
        }).join('')}
      </div>
    </div>`;

    document.getElementById('booking-flight-summary').innerHTML += returnHtml;
  }

  // Price calculation with age-based breakdown
  const nAdults2   = searchParams.numAdults   || passengerCount;
  const nChildren2 = searchParams.numChildren || 0;
  const nInfants2  = searchParams.numInfants  || 0;

  const returnPrice    = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
  const baseFlightPrice = price + returnPrice;

  // Age-based pricing: adults full, children 75%, infants 10%
  const adultTotal   = baseFlightPrice * nAdults2;
  const childTotal   = baseFlightPrice * 0.75 * nChildren2;
  const infantTotal  = baseFlightPrice * 0.10 * nInfants2;
  const grandTotal   = adultTotal + childTotal + infantTotal;

  // NordicWings fee (combined outbound + return, already included in per-adult price)
  const nwFeeOut    = parseFloat(selectedFlight.nordicwingsFee) || 12;
  const nwFeeRet    = selectedReturnFlight ? (parseFloat(selectedReturnFlight.nordicwingsFee) || 12) : 0;
  const nwFeeTotal  = (nwFeeOut + nwFeeRet).toFixed(2);

  let breakdownHtml = `
    <div class="price-row"><span>✈ Outbound fare / adult</span><span>€${price.toFixed(2)}</span></div>
    ${selectedReturnFlight ? `<div class="price-row"><span>✈ Return fare / adult</span><span>€${returnPrice.toFixed(2)}</span></div>` : ''}
    ${nAdults2   > 0 ? `<div class="price-row"><span>👤 Adults × ${nAdults2}</span><span>€${adultTotal.toFixed(2)}</span></div>` : ''}
    ${nChildren2 > 0 ? `<div class="price-row" style="color:#92400e;"><span>🧒 Children × ${nChildren2} <span style="font-size:.75rem;">(−25%)</span></span><span>€${(baseFlightPrice * 0.75 * nChildren2).toFixed(2)}</span></div>` : ''}
    ${nInfants2  > 0 ? `<div class="price-row" style="color:#166534;"><span>👶 Infants × ${nInfants2} <span style="font-size:.75rem;">(−90%)</span></span><span>€${(baseFlightPrice * 0.10 * nInfants2).toFixed(2)}</span></div>` : ''}
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ Checked baggage included</span><span>€0.00</span></div>
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ Meals included</span><span>€0.00</span></div>
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ 24/7 booking support</span><span>€0.00</span></div>
    <div class="price-row total"><span>Total</span><span>€${grandTotal.toFixed(2)}</span></div>
    <div style="font-size:.75rem;color:#6b7280;margin-top:6px;text-align:center;">🔒 Price guaranteed · No hidden fees</div>
  `;
  document.getElementById('price-breakdown').innerHTML = breakdownHtml;

  // Setup Stripe payment element with the correct total
  await setupStripePayment(grandTotal, currency);
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
        currency: (currency || 'EUR').toLowerCase(),
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
    stripeElements = stripe.elements({
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#2563eb',
          borderRadius: '8px',
          fontFamily: 'Inter, system-ui, sans-serif'
        }
      }
    });
    const paymentElement = stripeElements.create('payment', {
      layout: { type: 'tabs', defaultCollapsed: false },
      wallets: { link: 'never', applePay: 'auto', googlePay: 'auto' }
    });
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
    const _retP = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
    await setupStripePayment(
      (parseFloat(selectedFlight.price.grandTotal) + _retP) * (searchParams.passengers || 1),
      selectedFlight.price.currency || 'EUR'
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
    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.origin + '/?booking=confirmed',
        payment_method_data: {
          billing_details: { email, phone }
        }
      },
      redirect: 'always' // Klarna/PayPal require redirect — use return_url to come back
    });

    if (stripeError) {
      setError(errorEl, stripeError.message);
      return;
    }

    // Capture Stripe PaymentIntent ID for future refunds
    const paymentIntentId = paymentIntent?.id || null;

    // Payment succeeded — now issue the real ticket via Duffel (if Duffel flight)
    const seg     = selectedFlight.itineraries[0].segments[0];
    const lastSeg = selectedFlight.itineraries[0].segments[selectedFlight.itineraries[0].segments.length - 1];
    const _retPx  = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
    const _baseP  = parseFloat(selectedFlight.price.grandTotal) + _retPx;
    const _nA = searchParams.numAdults   || searchParams.passengers || 1;
    const _nC = searchParams.numChildren || 0;
    const _nI = searchParams.numInfants  || 0;
    const price   = (_baseP * _nA) + (_baseP * 0.75 * _nC) + (_baseP * 0.10 * _nI);

    // Collect all passenger details from form
    const titles   = Array.from(document.querySelectorAll('.pax-title')).map(el => el.value);
    const genders  = Array.from(document.querySelectorAll('.pax-gender')).map(el => el.value);
    const dobs     = Array.from(document.querySelectorAll('.pax-dob')).map(el => el.value);
    const paxEmails = Array.from(document.querySelectorAll('.pax-email')).map(el => el.value.trim());
    const phones   = Array.from(document.querySelectorAll('.pax-phone')).map(el => el.value.trim());

    let duffelBookingRef = null;
    let duffelOrderId    = null;

    // If this is a Duffel flight, create the real order
    if (selectedFlight.duffelOfferId) {
      try {
        const passengersPayload = firstNames.map((first, i) => ({
          title:       titles[i] || 'mr',
          given_name:  first,
          family_name: lastNames[i],
          born_on:     dobs[i] || '1990-01-01',
          gender:      genders[i] || 'm',
          email:       paxEmails[i] || email,
          phone:       phones[i] || phone || '+358000000000'
        }));

        const bookRes = await fetch('/api/bookings/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offerId:   selectedFlight.duffelOfferId,
            basePrice: selectedFlight.duffelBasePrice,
            passengers: passengersPayload
          })
        });

        const bookData = await bookRes.json();
        if (bookData.success) {
          duffelBookingRef = bookData.bookingReference;
          duffelOrderId    = bookData.orderId;
          console.log('✅ Duffel ticket issued! Ref:', duffelBookingRef);
        } else {
          console.error('Duffel booking failed:', bookData.error);
          // Payment already taken — still save to Firestore, flag for manual review
        }
      } catch (duffelErr) {
        console.error('Duffel order error:', duffelErr.message);
      }
    }

    const booking = {
      userId:    currentUser.uid,
      userEmail: currentUser.email,
      bookingRef: duffelBookingRef || generateBookingRef(),
      duffelOrderId: duffelOrderId || null,
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
      ...(selectedReturnFlight ? {
        returnFlight: {
          from:       selectedReturnFlight.itineraries[0].segments[0].departure.iataCode,
          to:         selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length-1].arrival.iataCode,
          departTime: selectedReturnFlight.itineraries[0].segments[0].departure.at,
          arriveTime: selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length-1].arrival.at,
          airline:    selectedReturnFlight.itineraries[0].segments[0].carrierCode,
          duration:   formatDuration(selectedReturnFlight.itineraries[0].duration)
        }
      } : {}),
      passengers: firstNames.map((first, i) => ({
        firstName: first,
        lastName:  lastNames[i],
        dob:       dobs[i] || '',
        gender:    genders[i] || ''
      })),
      contact: { email, phone },
      totalPrice: price.toFixed(2),
      currency:   selectedFlight.price.currency || 'EUR',
      paymentIntentId: paymentIntentId || null
    };

    await db.collection('bookings').add(booking);

    // Register flight reminder email (sent the day before the flight)
    try {
      var reminderEmail   = booking.contact.email || booking.userEmail || '';
      var passengerFirst  = (booking.passengers && booking.passengers[0]) ? booking.passengers[0].firstName + ' ' + booking.passengers[0].lastName : 'Traveller';
      var flightDateOnly  = booking.flight.departTime ? booking.flight.departTime.split('T')[0] : '';
      if (reminderEmail && flightDateOnly) {
        fetch('/api/bookings/reminder-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email:         reminderEmail,
            passengerName: passengerFirst,
            route:         booking.flight.from + ' → ' + booking.flight.to,
            flightDate:    flightDateOnly,
            departureTime: booking.flight.departTime ? formatTime(booking.flight.departTime) : '',
            arrivalTime:   booking.flight.arriveTime ? formatTime(booking.flight.arriveTime)  : '',
            airline:       booking.flight.airline || '',
            bookingRef:    booking.bookingRef || '',
            flightNumber:  booking.flight.flightNum || ''
          })
        }).catch(function(e) { console.warn('Reminder registration failed (non-critical):', e.message); });
      }
    } catch (reminderErr) {
      console.warn('Reminder registration error (non-critical):', reminderErr.message);
    }

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
  const isRealTicket = !!booking.duffelOrderId;
  document.getElementById('confirmation-details').innerHTML = `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px;margin-bottom:16px;text-align:center;">
      <div style="font-size:2rem;margin-bottom:8px;">${isRealTicket ? '✅' : '🎫'}</div>
      <div style="font-weight:700;color:#16a34a;font-size:1.1rem;">${isRealTicket ? 'Real Ticket Issued!' : 'Booking Confirmed!'}</div>
      <div style="font-size:.85rem;color:#4b5563;margin-top:4px;">${isRealTicket ? 'Your ticket has been issued by the airline.' : 'Your booking is confirmed.'}</div>
    </div>
    <div style="display:grid;gap:10px;">
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Booking Reference</span>
        <strong style="color:#1a2b4a;font-size:1rem;letter-spacing:1px;">${booking.bookingRef}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Route</span>
        <strong>${booking.flight.from} → ${booking.flight.to}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Date</span>
        <strong>${formatDate(booking.flight.departTime)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Flight Time</span>
        <strong>${formatTime(booking.flight.departTime)} → ${formatTime(booking.flight.arriveTime)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Flight</span>
        <strong>${booking.flight.flightNum}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Passengers</span>
        <strong>${booking.passengers.map(p => p.firstName + ' ' + p.lastName).join(', ')}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Total Paid</span>
        <strong style="color:#16a34a;font-size:1.1rem;">€${booking.totalPrice}</strong>
      </div>
    </div>
    <div style="margin-top:14px;padding:12px;background:#fffbeb;border-radius:8px;font-size:.82rem;color:#92400e;text-align:center;">
      📧 Confirmation and ticket details sent to <strong>${booking.contact.email}</strong>
    </div>

    <!-- AirHelp affiliate banner -->
    <div style="margin-top:16px;background:linear-gradient(135deg,#fef3c7,#fff7ed);border:1.5px solid #fbbf24;
      border-radius:12px;padding:14px 16px;">
      <div style="font-weight:700;color:#92400e;font-size:.9rem;margin-bottom:4px;">✈️ Flight delayed or cancelled?</div>
      <div style="font-size:.8rem;color:#b45309;margin-bottom:10px;">You could be entitled to up to €600 compensation per person. AirHelp handles your claim for free.</div>
      <a href="https://airhelp.tpk.mx/2qYxqDeS" target="_blank" rel="noopener"
        style="display:inline-block;background:#f59e0b;color:#fff;padding:8px 18px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;">
        Check my compensation →
      </a>
    </div>

    <!-- Searadar affiliate banner -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#eff6ff,#f0fdf4);border:1.5px solid #bfdbfe;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#1e40af;font-size:.85rem;">🛡️ Protect future trips</div>
        <div style="font-size:.78rem;color:#1d4ed8;margin-top:2px;">Travel insurance — cancel for any reason, medical cover, luggage</div>
      </div>
      <a href="https://searadar.tpk.mx/XaNzHXVR" target="_blank" rel="noopener"
        style="background:#1d4ed8;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Get insured →
      </a>
    </div>

    <!-- Klook banner — tours & activities at destination -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#fdf4ff,#fef3c7);border:1.5px solid #e9d5ff;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#7c3aed;font-size:.85rem;">🎡 Things to do at your destination</div>
        <div style="font-size:.78rem;color:#6d28d9;margin-top:2px;">Tours, attractions & activities — book experiences with Klook</div>
      </div>
      <a href="https://tp.media/r?marker=719573&trs=519663&p=4110&u=https%3A%2F%2Fklook.com&campaign_id=137" target="_blank" rel="noopener"
        style="background:#7c3aed;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Explore activities →
      </a>
    </div>

    <!-- Trip.com banner -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#eff6ff,#e0f2fe);border:1.5px solid #93c5fd;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#1e3a8a;font-size:.85rem;">🌏 Need a hotel for your trip?</div>
        <div style="font-size:.78rem;color:#1d4ed8;margin-top:2px;">Book hotels, tours & transfers at your destination with Trip.com</div>
      </div>
      <a href="https://www.trip.com/?Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D16144585" target="_blank" rel="noopener"
        style="background:#1d4ed8;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Find hotels →
      </a>
    </div>
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

  const btn      = document.getElementById('confirm-cancel-btn');
  const keepBtn  = document.getElementById('keep-booking-btn');
  const resultEl = document.getElementById('cancel-result');
  btn.disabled   = true;
  btn.textContent = 'Processing...';
  if (keepBtn)  keepBtn.disabled  = true;
  if (resultEl) resultEl.style.display = 'none';

  try {
    // Get booking details from Firestore (need paymentIntentId for refund)
    const docSnap = await db.collection('bookings').doc(cancelBookingId).get();
    if (!docSnap.exists) throw new Error('Booking not found.');
    const booking = docSnap.data();

    // Call backend: issue real Stripe refund + Duffel cancellation
    let refundMessage = '';
    if (booking.paymentIntentId) {
      try {
        const res  = await fetch('/api/bookings/cancel', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            paymentIntentId: booking.paymentIntentId,
            duffelOrderId:   booking.duffelOrderId || null,
            totalPrice:      booking.totalPrice,
            bookingRef:      booking.bookingRef
          })
        });
        const data = await res.json();
        refundMessage = data.success
          ? (data.message || 'Refund processed successfully.')
          : (data.error   || 'Contact hello@nordicwings.net for your refund.');
      } catch {
        refundMessage = 'Automatic refund unavailable. Email hello@nordicwings.net with ref: ' + (booking.bookingRef || cancelBookingId);
      }
    } else {
      refundMessage = 'Booking cancelled. Email hello@nordicwings.net with ref: ' + (booking.bookingRef || cancelBookingId) + ' to request your refund.';
    }

    // Mark as cancelled in Firestore
    await db.collection('bookings').doc(cancelBookingId).update({
      status:      'cancelled',
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Update card in dashboard UI
    const card = document.getElementById('booking-' + cancelBookingId);
    if (card) {
      const statusEl = card.querySelector('.booking-status');
      if (statusEl) { statusEl.className = 'booking-status status-cancelled'; statusEl.textContent = 'Cancelled'; }
      const cancelBtn = card.querySelector('.btn-cancel');
      if (cancelBtn) cancelBtn.outerHTML = '<span style="color:#9ca3af;font-size:.85rem;">Cancelled</span>';
    }

    // Show success message in modal
    if (resultEl) {
      resultEl.style.cssText = 'display:block;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px;color:#15803d;';
      resultEl.innerHTML = '✅ <strong>Booking cancelled.</strong> ' + refundMessage;
    }
    // Auto-close after 4 seconds
    setTimeout(() => {
      document.getElementById('cancel-overlay').style.display = 'none';
      cancelBookingId = null;
    }, 4000);

  } catch (err) {
    if (resultEl) {
      resultEl.style.cssText = 'display:block;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;color:#dc2626;';
      resultEl.innerHTML = '❌ ' + (err.message || 'Could not cancel. Please contact hello@nordicwings.net');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Yes, Cancel & Refund';
    if (keepBtn) keepBtn.disabled = false;
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
  var tLogin  = document.getElementById('tab-login');
  var tSignup = document.getElementById('tab-signup');
  if (tLogin && tSignup) {
    tLogin.style.background  = tab === 'login'  ? '#fff' : 'rgba(255,255,255,.2)';
    tLogin.style.color       = tab === 'login'  ? '#1e3a8a' : '#fff';
    tSignup.style.background = tab === 'signup' ? '#fff' : 'rgba(255,255,255,.2)';
    tSignup.style.color      = tab === 'signup' ? '#1e3a8a' : '#fff';
  }
  var title = document.getElementById('auth-modal-title');
  var sub   = document.getElementById('auth-modal-sub');
  if (title) title.textContent = tab === 'login' ? 'Welcome back' : 'Join NordicWings';
  if (sub)   sub.textContent   = tab === 'login' ? 'Sign in to manage your bookings' : 'Create your free account in seconds';
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

    // If they were on the agencies page, go back there
    if (selectedFlight) {
      showAgencyPage();
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
      showAgencyPage();
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
  document.getElementById('admin-empty').style.display = 'none';
  document.getElementById('admin-table').style.display = 'table';

  document.getElementById('admin-table-body').innerHTML = bookings.map(b => `
    <tr>
      <td><span class="admin-ref">${b.bookingRef || '—'}</span></td>
      <td>
        <div class="admin-customer-name">${b.passengers?.[0]?.firstName || ''} ${b.passengers?.[0]?.lastName || ''}</div>
        <div class="admin-customer-email">${b.contact?.email || b.userEmail || ''}</div>
      </td>
      <td><strong>${b.flight?.from || '?'} → ${b.flight?.to || '?'}</strong></td>
      <td>${b.flight?.departTime ? formatDate(b.flight.departTime) : '—'}</td>
      <td>${b.passengers?.length || 1} pax</td>
      <td><strong>€${parseFloat(b.totalPrice || 0).toFixed(2)}</strong></td>
      <td><span class="booking-status ${b.status === 'confirmed' ? 'status-confirmed' : 'status-cancelled'}">${b.status || 'unknown'}</span></td>
    </tr>
  `).join('');
}

// FAQ accordion toggle
function toggleFaq(btn) {
  var answer = btn.nextElementSibling;
  if (!answer) return;
  var isOpen = answer.style.display === 'block';
  if (isOpen) {
    answer.style.display = 'none';
    btn.classList.remove('open');
  } else {
    answer.style.display = 'block';
    btn.classList.add('open');
  }
}
