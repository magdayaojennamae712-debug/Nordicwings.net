// ============================================================
// NordicWings - server.js
// Express backend: serves the app, proxies Sky Scrapper flight
// search (keeping API keys secret), and handles Stripe payments.
// ============================================================

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting

// ── Security: Helmet (sets safe HTTP headers) ─────────────────
app.use(helmet({
  // Content Security Policy: restrict what scripts/styles/connections are allowed
  contentSecurityPolicy:    false,  // Disabled — Firebase + Stripe + inline scripts need this off
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  // Prevent clickjacking
  frameguard: { action: 'sameorigin' },
  // Hide server info from attackers
  hidePoweredBy: true,
  // Prevent MIME sniffing
  noSniff: true,
  // Force HTTPS
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Prevent XSS
  xssFilter: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── Security: CORS (only allow your own domain) ───────────────
const allowedOrigins = [
  'http://localhost:3000',
  'https://nordicwings.net',
  'https://www.nordicwings.net',
  'https://nordicwings-production.up.railway.app'
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// ── Security: Block suspicious User-Agents (scanners/bots) ──────
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const blocked = ['sqlmap', 'nikto', 'masscan', 'nmap', 'zgrab', 'python-requests/2.', 'go-http-client/1', 'curl/'];
  if (blocked.some(b => ua.includes(b))) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
});

// ── Security: Rate Limiting ────────────────────────────────────
// General limiter: max 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for payment routes: max 10 per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please try again later.' },
});

// Flight search limiter: max 30 searches per 15 minutes
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many searches. Please slow down and try again.' },
});

app.use(generalLimiter);

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '10kb' })); // Limit body size to prevent attacks
app.use(express.static('public'));

// ── Security: Input Sanitizer ─────────────────────────────────
// Strips dangerous characters from inputs
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"`;]/g, '').trim().substring(0, 200);
}

// Validate IATA airport code (must be 2-4 uppercase letters)
function isValidAirportCode(code) {
  return /^[A-Z]{2,4}$/.test(code);
}

// Validate date format YYYY-MM-DD
function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0,0,0,0);
  return date >= today; // Must be today or future
}

// ── RapidAPI / Sky Scrapper config ───────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'sky-scrapper.p.rapidapi.com';

// Helper: make a fetch request to Sky Scrapper
async function skyFetch(path, params) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'X-RapidAPI-Key':  RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Sky Scrapper error: ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ============================================================
// ROUTE: GET /api/airports/search
// Autocomplete airport/city names from a keyword.
// Used when the user types in the origin or destination field.
// ============================================================
app.get('/api/airports/search', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword || keyword.length < 2) return res.json([]);

  try {
    const data = await skyFetch('/api/v1/flights/searchAirport', {
      query:  keyword,
      locale: 'en-US'
    });

    console.log('Airport search raw data:', JSON.stringify(data).substring(0, 500));

    const airports = (data.data || []).slice(0, 6).map(loc => ({
      iataCode:    loc.skyId,
      entityId:    loc.entityId,
      name:        loc.presentation?.suggestionTitle || loc.skyId,
      cityName:    loc.presentation?.subtitle || '',
      countryName: ''
    }));

    console.log('Airports returned:', JSON.stringify(airports));
    res.json(airports);
  } catch (err) {
    console.error('Airport search error:', err.message);
    res.json([]);
  }
});

// ============================================================
// ROUTE: GET /api/flights/search
// Search real flights using Sky Scrapper API via RapidAPI.
// Query params: origin, destination, departureDate, adults
//               originEntityId, destinationEntityId
// ============================================================
app.get('/api/flights/search', searchLimiter, async (req, res) => {
  const { origin, destination, departureDate, adults, originEntityId, destinationEntityId } = req.query;

  // Validate and sanitize all inputs
  const cleanOrigin = sanitize(origin || '').toUpperCase();
  const cleanDest   = sanitize(destination || '').toUpperCase();
  const cleanDate   = sanitize(departureDate || '');
  const cleanAdults = Math.min(Math.max(parseInt(adults) || 1, 1), 9);

  if (!cleanOrigin || !cleanDest || !cleanDate) {
    return res.status(400).json({ error: 'Please provide origin, destination, and date.' });
  }
  if (!isValidAirportCode(cleanOrigin)) {
    return res.status(400).json({ error: 'Invalid departure airport code.' });
  }
  if (!isValidAirportCode(cleanDest)) {
    return res.status(400).json({ error: 'Invalid destination airport code.' });
  }
  if (!isValidDate(cleanDate)) {
    return res.status(400).json({ error: 'Invalid or past date provided.' });
  }

  // ── FAST PATH: return demo flights immediately, no external API needed ──
  function generateDemoFlightsFast(orig, dest, date, numAdults) {

    // ── WORLDWIDE AIRPORT → COUNTRY MAP ──────────────────────
    const airportCountry = {
      'HEL':'FI','OUL':'FI','TMP':'FI','TKU':'FI','JYV':'FI','KUO':'FI','JOE':'FI','RVN':'FI','KEM':'FI','IVL':'FI','KAJ':'FI','VAA':'FI','MHQ':'FI',
      'MNL':'PH','DVO':'PH','CEB':'PH','ILO':'PH','BCD':'PH','KLO':'PH','ZAM':'PH','GES':'PH','DGT':'PH','MPH':'PH','PPS':'PH','TAG':'PH',
      'JFK':'US','LAX':'US','ORD':'US','ATL':'US','DFW':'US','DEN':'US','SFO':'US','SEA':'US','MIA':'US','BOS':'US','LAS':'US','PHX':'US','MSP':'US','DTW':'US','EWR':'US','IAH':'US','IAD':'US','CLT':'US','MCO':'US','PHL':'US',
      'LHR':'GB','LGW':'GB','MAN':'GB','STN':'GB','BHX':'GB','EDI':'GB','GLA':'GB','LTN':'GB','BRS':'GB',
      'CDG':'FR','ORY':'FR','NCE':'FR','LYS':'FR','MRS':'FR','TLS':'FR','NTE':'FR','BOD':'FR','LIL':'FR',
      'FRA':'DE','MUC':'DE','BER':'DE','DUS':'DE','HAM':'DE','STR':'DE','CGN':'DE','LEJ':'DE','NUE':'DE',
      'AMS':'NL','EIN':'NL','RTM':'NL',
      'MAD':'ES','BCN':'ES','PMI':'ES','AGP':'ES','VLC':'ES','SVQ':'ES','BIO':'ES','ALC':'ES',
      'FCO':'IT','MXP':'IT','LIN':'IT','VCE':'IT','NAP':'IT','PMO':'IT','CTA':'IT','BGY':'IT',
      'ARN':'SE','GOT':'SE','MMX':'SE',
      'CPH':'DK','AAL':'DK','BLL':'DK',
      'OSL':'NO','BGO':'NO','TRD':'NO','SVG':'NO',
      'DXB':'AE','AUH':'AE','SHJ':'AE',
      'BKK':'TH','HKT':'TH','CNX':'TH',
      'SIN':'SG',
      'KUL':'MY','LGK':'MY','PEN':'MY',
      'NRT':'JP','HND':'JP','KIX':'JP','NGO':'JP','ITM':'JP','CTS':'JP','FUK':'JP',
      'ICN':'KR','GMP':'KR','PUS':'KR',
      'HKG':'HK',
      'PEK':'CN','SHA':'CN','PVG':'CN','CAN':'CN','CTU':'CN','SZX':'CN',
      'DEL':'IN','BOM':'IN','MAA':'IN','BLR':'IN','CCU':'IN','HYD':'IN',
      'SYD':'AU','MEL':'AU','BNE':'AU','PER':'AU','ADL':'AU',
      'AKL':'NZ','CHC':'NZ','WLG':'NZ',
      'YYZ':'CA','YVR':'CA','YUL':'CA','YYC':'CA',
      'GRU':'BR','GIG':'BR','SSA':'BR','BSB':'BR',
      'EZE':'AR','AEP':'AR',
      'MEX':'MX','CUN':'MX','GDL':'MX',
      'BOG':'CO','MDE':'CO',
      'JNB':'ZA','CPT':'ZA',
      'NBO':'KE',
      'ADD':'ET',
      'LOS':'NG',
      'CAI':'EG',
      'IST':'TR','SAW':'TR','ADB':'TR',
      'DOH':'QA',
      'RUH':'SA','JED':'SA','DMM':'SA',
      'TLV':'IL',
      'VIE':'AT','GRZ':'AT',
      'ZRH':'CH','GVA':'CH',
      'LIS':'PT','OPO':'PT',
      'ATH':'GR','SKG':'GR',
      'WAW':'PL','KRK':'PL',
      'BUD':'HU',
      'PRG':'CZ',
      'DUB':'IE',
      'BRU':'BE',
      'MLE':'MV',
      'CMB':'LK',
      'KTM':'NP',
      'DPS':'ID','CGK':'ID',
      'SGN':'VN','HAN':'VN',
    };

    const domesticConfig = {
      'FI': { airlines:['AY','AY','AY','AY','AY','AY'], price:[45,95],  mins:60 },
      'PH': { airlines:['PR','5J','Z2','PR','5J','Z2'], price:[25,70],  mins:70 },
      'US': { airlines:['AA','UA','DL','WN','B6','AS'], price:[80,280], mins:180 },
      'GB': { airlines:['BA','EI','BE','BA','FR','LM'], price:[50,180], mins:75 },
      'AU': { airlines:['QF','VA','JQ','QF','VA','JQ'], price:[60,200], mins:120 },
      'IN': { airlines:['AI','6E','SG','G8','AI','6E'], price:[30,120], mins:90 },
      'JP': { airlines:['JL','NH','BC','GK','JL','NH'], price:[60,180], mins:80 },
      'CN': { airlines:['CA','MU','CZ','HU','3U','ZH'], price:[50,180], mins:120 },
    };

    const knownRoutes = {
      'HEL-LHR': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','BA','SK','LH','U2','FR'] },
      'HEL-CDG': { totalMins: 210, stops: [], basePrice: 138, airlines: ['AY','AF','LH','BA','SK','U2'] },
      'HEL-AMS': { totalMins: 195, stops: [], basePrice: 125, airlines: ['AY','KL','LH','BA','SK','U2'] },
      'HEL-FRA': { totalMins: 185, stops: [], basePrice: 122, airlines: ['AY','LH','BA','AF','SK','U2'] },
      'HEL-BCN': { totalMins: 300, stops: [], basePrice: 145, airlines: ['AY','VY','FR','IB','U2','SK'] },
      'HEL-MAD': { totalMins: 315, stops: [], basePrice: 148, airlines: ['AY','IB','FR','VY','LH','BA'] },
      'HEL-FCO': { totalMins: 270, stops: [], basePrice: 142, airlines: ['AY','AZ','FR','LH','BA','U2'] },
      'HEL-ATH': { totalMins: 270, stops: [], basePrice: 155, airlines: ['AY','A3','LH','BA','FR','SK'] },
      'HEL-IST': { totalMins: 225, stops: [], basePrice: 160, airlines: ['AY','TK','LH','BA','FR','PC'] },
      'HEL-VIE': { totalMins: 175, stops: [], basePrice: 118, airlines: ['AY','OS','LH','BA','SK','U2'] },
      'HEL-ZRH': { totalMins: 200, stops: [], basePrice: 135, airlines: ['AY','LX','LH','BA','SK','U2'] },
      'HEL-ARN': { totalMins: 60,  stops: [], basePrice: 55,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-CPH': { totalMins: 90,  stops: [], basePrice: 72,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-OSL': { totalMins: 105, stops: [], basePrice: 78,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-WAW': { totalMins: 150, stops: [], basePrice: 98,  airlines: ['AY','LO','FR','LH','SK','U2'] },
      'HEL-BUD': { totalMins: 185, stops: [], basePrice: 112, airlines: ['AY','W6','LH','BA','FR','SK'] },
      'HEL-PRG': { totalMins: 175, stops: [], basePrice: 108, airlines: ['AY','OK','LH','BA','FR','W6'] },
      'HEL-DUB': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','EI','FR','BA','SK','LH'] },
      'HEL-DXB': { totalMins: 390, stops: [], basePrice: 310,  airlines: ['AY','EK','QR','TK','LH','FZ'] },
      'HEL-BKK': { totalMins: 810, stops: ['DXB'], basePrice: 590, airlines: ['AY','EK','TG','QR','TK','LH'] },
      'HEL-SIN': { totalMins: 870, stops: ['DXB'], basePrice: 620, airlines: ['AY','SQ','EK','QR','TK','LH'] },
      'HEL-MNL': { totalMins: 960, stops: ['DXB'], basePrice: 650, airlines: ['AY','EK','QR','TK','PR','LH'] },
      'HEL-JFK': { totalMins: 570, stops: ['LHR'], basePrice: 480, airlines: ['AY','BA','LH','AF','KL','TK'] },
      'HEL-LAX': { totalMins: 690, stops: ['LHR'], basePrice: 540, airlines: ['AY','BA','LH','AF','KL','AA'] },
      'HEL-NRT': { totalMins: 870, stops: ['HKG'], basePrice: 680, airlines: ['AY','JL','NH','KL','LH','BA'] },
      'HEL-PEK': { totalMins: 780, stops: [], basePrice: 580,  airlines: ['AY','CA','LH','KL','BA','AF'] },
      'MNL-DVO': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'DVO-MNL': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-CEB': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'CEB-MNL': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'LHR-JFK': { totalMins: 435, stops: [], basePrice: 380, airlines: ['BA','VS','AA','UA','DL','U2'] },
      'LHR-DXB': { totalMins: 405, stops: [], basePrice: 290, airlines: ['BA','EK','QR','TK','LH','FZ'] },
      'DXB-SIN': { totalMins: 420, stops: [], basePrice: 250, airlines: ['EK','SQ','QR','TK','FZ','MH'] },
      'DXB-BKK': { totalMins: 390, stops: [], basePrice: 220, airlines: ['EK','TG','QR','TK','FZ','MH'] },
      'BKK-SIN': { totalMins: 135, stops: [], basePrice: 80,  airlines: ['TG','SQ','FD','AK','MH','QZ'] },
      'SIN-MNL': { totalMins: 195, stops: [], basePrice: 110, airlines: ['SQ','PR','5J','CX','MH','QZ'] },
      'AMS-JFK': { totalMins: 525, stops: [], basePrice: 400, airlines: ['KL','UA','DL','AA','BA','AF'] },
    };

    const key   = `${orig}-${dest}`;
    const revKey= `${dest}-${orig}`;
    let route   = knownRoutes[key] || knownRoutes[revKey];

    if (!route) {
      const origC = airportCountry[orig];
      const destC = airportCountry[dest];
      const isDom = origC && destC && origC === destC;
      if (isDom && domesticConfig[origC]) {
        const cfg = domesticConfig[origC];
        route = { totalMins: cfg.mins + 20, stops: [], basePrice: cfg.price[0] + 20, airlines: cfg.airlines };
      } else if (isDom) {
        route = { totalMins: 90, stops: [], basePrice: 70, airlines: ['AY','LH','BA','AF','KL','TK'] };
      } else {
        const hubs = ['HEL','LHR','CDG','AMS','FRA','JFK','LAX','NRT','SIN','DXB','ICN','BKK','KUL','DEL','BOM'];
        route = (hubs.includes(orig)||hubs.includes(dest))
          ? { totalMins: 600, stops: ['DXB'], basePrice: 420, airlines: ['EK','QR','TK','BA','LH','AY'] }
          : { totalMins: 180, stops: [], basePrice: 120, airlines: ['LH','BA','AF','KL','TK','AY'] };
      }
    }

    const airlineCodes   = route.airlines || ['AY','LH','BA','AF','KL','TK'];
    const flightBases    = [100,200,300,400,500,600];
    const priceMods      = [1.0, 2.8, 0.95, 1.0, 0.90, 0.95];
    const departureTimes = ['06:15','08:30','10:45','13:00','15:30','18:00'];

    const options = airlineCodes.map((code, idx) => ({
      code, flightBase: flightBases[idx]||100+idx*100, cabinPriceMod: priceMods[idx]||1.0,
    }));

    return options.map((al, i) => {
      const depTimeStr  = `${date}T${departureTimes[i % departureTimes.length]}:00`;
      const depDate     = new Date(depTimeStr);
      const isBusiness  = i === 1;
      const basePrice   = route.basePrice * al.cabinPriceMod * numAdults;
      const finalPrice  = Math.round((basePrice + (i % 3) * 40) * (isBusiness ? 2.8 : 1));
      const totalMins   = route.totalMins;
      const segments    = [];

      if (route.stops.length === 0) {
        const arrDate = new Date(depDate.getTime() + totalMins * 60000);
        segments.push({ departure:{iataCode:orig, at:depDate.toISOString()}, arrival:{iataCode:dest, at:arrDate.toISOString()}, carrierCode:al.code, number:String(al.flightBase+i*13), duration:`PT${Math.floor(totalMins/60)}H${totalMins%60}M` });
      } else {
        const stopover   = route.stops[i % route.stops.length];
        const seg1Mins   = Math.round(totalMins * 0.45);
        const seg2Mins   = totalMins - seg1Mins - 90;
        const midArr     = new Date(depDate.getTime() + seg1Mins * 60000);
        const midDep     = new Date(midArr.getTime() + 90 * 60000);
        const finalArr   = new Date(midDep.getTime() + seg2Mins * 60000);
        segments.push({ departure:{iataCode:orig,    at:depDate.toISOString()}, arrival:{iataCode:stopover, at:midArr.toISOString()}, carrierCode:al.code, number:String(al.flightBase+i*13),   duration:`PT${Math.floor(seg1Mins/60)}H${seg1Mins%60}M` });
        segments.push({ departure:{iataCode:stopover,at:midDep.toISOString()}, arrival:{iataCode:dest,     at:finalArr.toISOString()},carrierCode:al.code, number:String(al.flightBase+i*13+1), duration:`PT${Math.floor(seg2Mins/60)}H${seg2Mins%60}M` });
      }

      return {
        id: `demo-${i}`,
        price: { grandTotal: finalPrice.toFixed(2), currency:'EUR', fees:[{amount:(finalPrice*0.10).toFixed(2)}] },
        numberOfBookableSeats: [9,4,7,2,6,8][i]||5,
        itineraries: [{ duration:`PT${Math.floor(totalMins/60)}H${totalMins%60}M`, segments }],
        travelerPricings: [{ fareDetailsBySegment:[{ cabin: isBusiness ? 'BUSINESS' : 'ECONOMY' }] }]
      };
    });
  }

  // Return demo flights IMMEDIATELY — no external API call needed
  const fastDemo = generateDemoFlightsFast(cleanOrigin, cleanDest, cleanDate, cleanAdults);
  console.log(`Fast demo flights for ${cleanOrigin}->${cleanDest}: ${fastDemo.length} results`);
  return res.json(fastDemo);

  // Auto-lookup entityId if missing — tries exact match first, then first result
  async function getEntityId(skyId) {
    try {
      const data = await skyFetch('/api/v1/flights/searchAirport', { query: skyId, locale: 'en-US' });
      const results = data.data || [];
      // Try exact match first
      const exact = results.find(loc => loc.skyId === skyId);
      if (exact?.entityId) return exact.entityId;
      // Fall back to first result
      if (results[0]?.entityId) return results[0].entityId;
      return '';
    } catch { return ''; }
  }

  let resolvedOriginEntityId      = originEntityId;
  let resolvedDestinationEntityId = destinationEntityId;

  if (!resolvedOriginEntityId)      resolvedOriginEntityId      = await getEntityId(origin.toUpperCase());
  if (!resolvedDestinationEntityId) resolvedDestinationEntityId = await getEntityId(destination.toUpperCase());

  console.log(`Flight search: ${origin} (${resolvedOriginEntityId}) → ${destination} (${resolvedDestinationEntityId}) on ${departureDate}`);

  // Helper: generate realistic demo flights with correct stopovers and durations
  function generateDemoFlights(orig, dest, date, numAdults) {

    // ── WORLDWIDE AIRPORT → COUNTRY MAP ──────────────────────
    const airportCountry = {
      // Finland
      'HEL':'FI','OUL':'FI','TMP':'FI','TKU':'FI','JYV':'FI','KUO':'FI',
      'JOE':'FI','RVN':'FI','KEM':'FI','IVL':'FI','KAJ':'FI','VAA':'FI','MHQ':'FI',
      // Philippines
      'MNL':'PH','DVO':'PH','CEB':'PH','ILO':'PH','BCD':'PH','KLO':'PH',
      'ZAM':'PH','GES':'PH','DGT':'PH','MPH':'PH','PPS':'PH','TAG':'PH',
      // USA
      'JFK':'US','LAX':'US','ORD':'US','ATL':'US','DFW':'US','DEN':'US',
      'SFO':'US','SEA':'US','MIA':'US','BOS':'US','LAS':'US','PHX':'US',
      'IAH':'US','MSP':'US','DTW':'US','PHL':'US','CLT':'US','EWR':'US',
      'BWI':'US','SLC':'US','HNL':'US','SAN':'US','PDX':'US','AUS':'US',
      'MCO':'US','TPA':'US','BNA':'US','RDU':'US','STL':'US','MCI':'US',
      // UK
      'LHR':'GB','LGW':'GB','MAN':'GB','STN':'GB','EDI':'GB','GLA':'GB',
      'LTN':'GB','BHX':'GB','BRS':'GB','NCL':'GB','LBA':'GB','ABZ':'GB',
      // Germany
      'FRA':'DE','MUC':'DE','BER':'DE','DUS':'DE','HAM':'DE','STR':'DE',
      'CGN':'DE','NUE':'DE','HAJ':'DE','LEJ':'DE','DRS':'DE',
      // France
      'CDG':'FR','ORY':'FR','NCE':'FR','LYS':'FR','MRS':'FR','TLS':'FR',
      'BOD':'FR','NTE':'FR','LIL':'FR',
      // Spain
      'MAD':'ES','BCN':'ES','AGP':'ES','PMI':'ES','ALC':'ES','VLC':'ES',
      'LPA':'ES','TFN':'ES','IBZ':'ES','SVQ':'ES','BIO':'ES',
      // Italy
      'FCO':'IT','MXP':'IT','LIN':'IT','NAP':'IT','VCE':'IT','CIA':'IT',
      'BLQ':'IT','CTA':'IT','PMO':'IT','BRI':'IT','FLR':'IT',
      // Australia
      'SYD':'AU','MEL':'AU','BNE':'AU','PER':'AU','ADL':'AU','CBR':'AU',
      'OOL':'AU','CNS':'AU','DRW':'AU','TSV':'AU','HBA':'AU','MKY':'AU',
      // India
      'DEL':'IN','BOM':'IN','BLR':'IN','MAA':'IN','CCU':'IN','HYD':'IN',
      'COK':'IN','AMD':'IN','GOI':'IN','PNQ':'IN','JAI':'IN','LKO':'IN',
      // Japan
      'NRT':'JP','HND':'JP','KIX':'JP','NGO':'JP','CTS':'JP','OKA':'JP',
      'FUK':'JP','HIJ':'JP','SDJ':'JP','KOJ':'JP','OIT':'JP',
      // China
      'PEK':'CN','PVG':'CN','SHA':'CN','CAN':'CN','SZX':'CN','CTU':'CN',
      'KMG':'CN','WUH':'CN','CSX':'CN','XIY':'CN','HGH':'CN','NKG':'CN',
      // Brazil
      'GRU':'BR','GIG':'BR','BSB':'BR','SSA':'BR','FOR':'BR','REC':'BR',
      'POA':'BR','CWB':'BR','BEL':'BR','MAO':'BR','CGH':'BR','SDU':'BR',
      // Canada
      'YYZ':'CA','YVR':'CA','YUL':'CA','YYC':'CA','YEG':'CA','YOW':'CA',
      'YWG':'CA','YHZ':'CA','YQB':'CA','YYJ':'CA',
      // Indonesia
      'CGK':'ID','DPS':'ID','SUB':'ID','MES':'ID','UPG':'ID','PLM':'ID',
      'PDG':'ID','BPN':'ID','SOC':'ID','AMQ':'ID','MDC':'ID',
      // Thailand
      'BKK':'TH','DMK':'TH','HKT':'TH','CNX':'TH','HDY':'TH','USM':'TH',
      'CEI':'TH','KBV':'TH',
      // Malaysia
      'KUL':'MY','LGK':'MY','PEN':'MY','BKI':'MY','KCH':'MY','JHB':'MY',
      'MYY':'MY','SDK':'MY',
      // Norway
      'OSL':'NO','BGO':'NO','TRD':'NO','SVG':'NO','TOS':'NO','BOO':'NO',
      'ALF':'NO','LKL':'NO','EVE':'NO',
      // Sweden
      'ARN':'SE','GOT':'SE','MMX':'SE','LLA':'SE','UME':'SE','OSD':'SE',
      // Denmark
      'CPH':'DK','AAL':'DK','BLL':'DK','FAE':'DK',
      // Netherlands
      'AMS':'NL','EIN':'NL','RTM':'NL',
      // Turkey
      'IST':'TR','SAW':'TR','ADB':'TR','AYT':'TR','ESB':'TR','TZX':'TR',
      'GZT':'TR','SZF':'TR','BJV':'TR',
      // UAE
      'DXB':'AE','AUH':'AE','SHJ':'AE',
      // South Korea
      'ICN':'KR','GMP':'KR','PUS':'KR','CJU':'KR','CJJ':'KR',
      // Mexico
      'MEX':'MX','CUN':'MX','GDL':'MX','MTY':'MX','TIJ':'MX','OAX':'MX',
      // Argentina
      'EZE':'AR','AEP':'AR','COR':'AR','MDZ':'AR','BRC':'AR','IGR':'AR',
      // South Africa
      'JNB':'ZA','CPT':'ZA','DUR':'ZA','PLZ':'ZA','GRJ':'ZA',
      // New Zealand
      'AKL':'NZ','CHC':'NZ','WLG':'NZ','ZQN':'NZ','DUD':'NZ',
      // Colombia
      'BOG':'CO','MDE':'CO','CTG':'CO','CLO':'CO','BAQ':'CO',
      // Chile
      'SCL':'CL','PMC':'CL','ANF':'CL','IQQ':'CL','CCP':'CL',
      // Portugal
      'LIS':'PT','OPO':'PT','FAO':'PT','PDL':'PT','FNC':'PT',
      // Greece
      'ATH':'GR','SKG':'GR','HER':'GR','RHO':'GR','CFU':'GR','JMK':'GR',
      // Austria
      'VIE':'AT','GRZ':'AT','INN':'AT','SZG':'AT',
      // Switzerland
      'ZRH':'CH','GVA':'CH','BSL':'CH',
      // Poland
      'WAW':'PL','KRK':'PL','KTW':'PL','GDN':'PL','POZ':'PL','WRO':'PL',
      // Romania
      'OTP':'RO','CLJ':'RO','TSR':'RO','IAS':'RO',
      // Hungary
      'BUD':'HU',
      // Czech Republic
      'PRG':'CZ','BRQ':'CZ',
      // Ireland
      'DUB':'IE','ORK':'IE','SNN':'IE',
      // Belgium
      'BRU':'BE','CRL':'BE','LGG':'BE',
      // Pakistan
      'KHI':'PK','LHE':'PK','ISB':'PK','PEW':'PK','MUX':'PK',
      // Bangladesh
      'DAC':'BD','CGP':'BD','JSR':'BD',
      // Sri Lanka
      'CMB':'LK',
      // Nepal
      'KTM':'NP','PKR':'NP',
      // Egypt
      'CAI':'EG','HRG':'EG','SSH':'EG','LXR':'EG','ASW':'EG',
      // Kenya
      'NBO':'KE','MBA':'KE','KIS':'KE',
      // Nigeria
      'LOS':'NG','ABV':'NG','PHC':'NG','KAN':'NG',
      // Ethiopia
      'ADD':'ET','DIR':'ET',
      // Russia
      'SVO':'RU','DME':'RU','LED':'RU','OVB':'RU','SVX':'RU','KZN':'RU',
      // Ukraine (pre-war routes)
      'KBP':'UA','LWO':'UA',
      // Singapore
      'SIN':'SG',
      // Hong Kong
      'HKG':'HK',
      // Taiwan
      'TPE':'TW','KHH':'TW','RMQ':'TW',
      // Vietnam
      'SGN':'VN','HAN':'VN','DAD':'VN','CXR':'VN','UIH':'VN',
      // Cambodia
      'PNH':'KH','REP':'KH',
      // Morocco
      'CMN':'MA','RAK':'MA','AGA':'MA','FEZ':'MA','TNG':'MA',
    };

    // ── DOMESTIC AIRLINES BY COUNTRY ─────────────────────────
    const domesticConfig = {
      'FI': { airlines:['AY','AY','AY','AY','AY','AY'], price:[45,95],  mins:60,  stops:[] },
      'PH': { airlines:['PR','5J','Z2','PR','5J','Z2'], price:[25,70],  mins:70,  stops:[] },
      'US': { airlines:['AA','UA','DL','WN','B6','AS'], price:[80,280], mins:180, stops:[] },
      'GB': { airlines:['BA','EI','BE','BA','FR','LM'], price:[50,180], mins:75,  stops:[] },
      'AU': { airlines:['QF','VA','JQ','QF','VA','JQ'], price:[60,200], mins:120, stops:[] },
      'IN': { airlines:['AI','6E','SG','G8','AI','6E'], price:[30,120], mins:90,  stops:[] },
      'JP': { airlines:['JL','NH','BC','GK','JL','NH'], price:[60,180], mins:80,  stops:[] },
      'CN': { airlines:['CA','MU','CZ','HU','3U','ZH'], price:[50,180], mins:120, stops:[] },
      'BR': { airlines:['G3','LA','AD','G3','LA','AD'], price:[50,180], mins:120, stops:[] },
      'CA': { airlines:['AC','WS','F8','AC','WS','AC'], price:[80,300], mins:150, stops:[] },
      'ID': { airlines:['GA','JT','QZ','SJ','ID','IN'], price:[25,100], mins:75,  stops:[] },
      'TH': { airlines:['TG','FD','WE','DD','TG','FD'], price:[30,100], mins:75,  stops:[] },
      'MY': { airlines:['MH','AK','OD','MH','AK','OD'], price:[25,90],  mins:75,  stops:[] },
      'NO': { airlines:['SK','DY','SK','DY','SK','DY'], price:[40,140], mins:65,  stops:[] },
      'SE': { airlines:['SK','DY','SK','DY','FR','SK'], price:[40,140], mins:65,  stops:[] },
      'DE': { airlines:['LH','EW','4U','LH','FR','LH'], price:[60,180], mins:75,  stops:[] },
      'ES': { airlines:['IB','VY','FR','VY','IB','FR'], price:[35,150], mins:90,  stops:[] },
      'IT': { airlines:['AZ','FR','U2','AZ','FR','U2'], price:[35,150], mins:90,  stops:[] },
      'TR': { airlines:['TK','PC','TK','PC','TK','XQ'], price:[30,120], mins:80,  stops:[] },
      'ZA': { airlines:['SA','FA','MN','SA','FA','MN'], price:[40,150], mins:90,  stops:[] },
      'MX': { airlines:['AM','Y4','VB','AM','Y4','VB'], price:[40,140], mins:90,  stops:[] },
      'KR': { airlines:['KE','OZ','7C','LJ','KE','OZ'], price:[50,150], mins:55,  stops:[] },
      'AR': { airlines:['AR','JA','LA','AR','JA','AR'], price:[40,150], mins:90,  stops:[] },
      'NZ': { airlines:['NZ','JQ','NZ','JQ','NZ','JQ'], price:[50,160], mins:60,  stops:[] },
      'CO': { airlines:['AV','LA','VX','AV','LA','AV'], price:[35,130], mins:60,  stops:[] },
      'CL': { airlines:['LA','JJ','LA','JJ','LA','JJ'], price:[40,140], mins:80,  stops:[] },
      'PT': { airlines:['TP','FR','U2','TP','FR','U2'], price:[40,130], mins:60,  stops:[] },
      'GR': { airlines:['A3','FR','U2','A3','FR','A3'], price:[40,140], mins:60,  stops:[] },
      'PK': { airlines:['PK','PA','ER','PK','PA','PK'], price:[25,100], mins:80,  stops:[] },
      'EG': { airlines:['MS','HF','ZS','MS','HF','MS'], price:[30,110], mins:60,  stops:[] },
      'NG': { airlines:['QS','IB','LH','QS','IB','QS'], price:[30,120], mins:70,  stops:[] },
      'RU': { airlines:['SU','S7','UT','SU','S7','UT'], price:[40,180], mins:120, stops:[] },
      'VN': { airlines:['VN','VJ','QH','VN','VJ','QH'], price:[25,90],  mins:80,  stops:[] },
      'MA': { airlines:['AT','TO','AT','TO','AT','TO'], price:[30,110], mins:70,  stops:[] },
    };

    // Real-world route data: total duration (minutes) + stopover airports
    const routeData = {
      // European short-haul (direct)
      default_short: { totalMins: 180, stops: [], basePrice: 120 },
      // Medium-haul (direct)
      default_medium: { totalMins: 360, stops: [], basePrice: 280 },
      // Long-haul (1 stop)
      default_long: { totalMins: 840, stops: ['DXB'], basePrice: 520 },
    };

    // Known real routes with accurate data
    const knownRoutes = {
      // ── Finnish domestic ──────────────────────────────────────
      'HEL-OUL': { totalMins: 65,  stops: [], basePrice: 60,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-TMP': { totalMins: 45,  stops: [], basePrice: 45,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-TKU': { totalMins: 40,  stops: [], basePrice: 42,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-JYV': { totalMins: 50,  stops: [], basePrice: 52,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KUO': { totalMins: 55,  stops: [], basePrice: 58,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-JOE': { totalMins: 60,  stops: [], basePrice: 62,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-RVN': { totalMins: 90,  stops: [], basePrice: 75,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-IVL': { totalMins: 105, stops: [], basePrice: 88,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KAJ': { totalMins: 70,  stops: [], basePrice: 65,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-VAA': { totalMins: 55,  stops: [], basePrice: 55,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KEM': { totalMins: 95,  stops: [], basePrice: 80,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'OUL-TMP': { totalMins: 60,  stops: [], basePrice: 55,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'OUL-TKU': { totalMins: 70,  stops: [], basePrice: 60,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      // ── Finland to Europe ─────────────────────────────────────
      'HEL-LHR': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','BA','SK','LH','U2','FR'] },
      'HEL-CDG': { totalMins: 210, stops: [], basePrice: 138, airlines: ['AY','AF','LH','BA','SK','U2'] },
      'HEL-AMS': { totalMins: 195, stops: [], basePrice: 125, airlines: ['AY','KL','LH','BA','SK','U2'] },
      'HEL-FRA': { totalMins: 185, stops: [], basePrice: 122, airlines: ['AY','LH','BA','AF','SK','U2'] },
      'HEL-BCN': { totalMins: 300, stops: [], basePrice: 145, airlines: ['AY','VY','FR','IB','U2','SK'] },
      'HEL-MAD': { totalMins: 315, stops: [], basePrice: 148, airlines: ['AY','IB','FR','VY','LH','BA'] },
      'HEL-FCO': { totalMins: 270, stops: [], basePrice: 142, airlines: ['AY','AZ','FR','LH','BA','U2'] },
      'HEL-ATH': { totalMins: 270, stops: [], basePrice: 155, airlines: ['AY','A3','LH','BA','FR','SK'] },
      'HEL-IST': { totalMins: 225, stops: [], basePrice: 160, airlines: ['AY','TK','LH','BA','FR','PC'] },
      'HEL-VIE': { totalMins: 175, stops: [], basePrice: 118, airlines: ['AY','OS','LH','BA','SK','U2'] },
      'HEL-ZRH': { totalMins: 200, stops: [], basePrice: 135, airlines: ['AY','LX','LH','BA','SK','U2'] },
      'HEL-ARN': { totalMins: 60,  stops: [], basePrice: 55,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-CPH': { totalMins: 90,  stops: [], basePrice: 72,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-OSL': { totalMins: 105, stops: [], basePrice: 78,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-WAW': { totalMins: 150, stops: [], basePrice: 98,  airlines: ['AY','LO','FR','LH','SK','U2'] },
      'HEL-BUD': { totalMins: 185, stops: [], basePrice: 112, airlines: ['AY','W6','LH','BA','FR','SK'] },
      'HEL-PRG': { totalMins: 175, stops: [], basePrice: 108, airlines: ['AY','OK','LH','BA','FR','W6'] },
      'HEL-DUB': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','EI','FR','BA','SK','LH'] },
      // ── Finland long haul ─────────────────────────────────────
      'HEL-DXB': { totalMins: 390, stops: [], basePrice: 310,  airlines: ['AY','EK','QR','TK','LH','FZ'] },
      'HEL-BKK': { totalMins: 810, stops: ['DXB'], basePrice: 590, airlines: ['AY','EK','TG','QR','TK','LH'] },
      'HEL-SIN': { totalMins: 870, stops: ['DXB'], basePrice: 620, airlines: ['AY','SQ','EK','QR','TK','LH'] },
      'HEL-MNL': { totalMins: 960, stops: ['DXB'], basePrice: 650, airlines: ['AY','EK','QR','TK','PR','LH'] },
      'HEL-JFK': { totalMins: 570, stops: ['LHR'], basePrice: 480, airlines: ['AY','BA','LH','AF','KL','TK'] },
      'HEL-LAX': { totalMins: 690, stops: ['LHR'], basePrice: 540, airlines: ['AY','BA','LH','AF','KL','AA'] },
      'HEL-NRT': { totalMins: 870, stops: ['HKG'], basePrice: 680, airlines: ['AY','JL','NH','KL','LH','BA'] },
      'HEL-PEK': { totalMins: 780, stops: [], basePrice: 580,  airlines: ['AY','CA','LH','KL','BA','AF'] },
      'HEL-DVO': { totalMins: 1020,stops: ['DXB'], basePrice: 680, airlines: ['AY','EK','QR','TK','PR','LH'] },
      // ── Philippine domestic ───────────────────────────────────
      'MNL-DVO': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'DVO-MNL': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-CEB': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'CEB-MNL': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'DVO-CEB': { totalMins: 55,  stops: [], basePrice: 25,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'CEB-DVO': { totalMins: 55,  stops: [], basePrice: 25,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-ILO': { totalMins: 55,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
 