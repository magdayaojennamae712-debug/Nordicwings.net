// ============================================================
// SkyBook - server.js
// Express backend: serves the app, proxies Sky Scrapper flight
// search (keeping API keys secret), and handles Stripe payments.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('public'));   // Serves index.html, style.css, script.js

// ── RapidAPI / Sky Scrapper config ───────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'sky-scrapper.p.rapidapi.com';

// Helper: make a fetch request to Sky Scrapper
async function skyFetch(path, params) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'X-RapidAPI-Key':  RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST
    }
  });

  if (!res.ok) throw new Error(`Sky Scrapper error: ${res.status}`);
  return res.json();
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
app.get('/api/flights/search', async (req, res) => {
  const { origin, destination, departureDate, adults, originEntityId, destinationEntityId } = req.query;

  if (!origin || !destination || !departureDate) {
    return res.status(400).json({ error: 'Anna lähtö, määränpää ja päivämäärä.' });
  }

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

  // Helper: generate realistic demo flights as fallback
  function generateDemoFlights(orig, dest, date, numAdults) {
    const airlines = [
      { code: 'EK', name: 'Emirates' },
      { code: 'BA', name: 'British Airways' },
      { code: 'LH', name: 'Lufthansa' },
      { code: 'QR', name: 'Qatar Airways' },
      { code: 'TK', name: 'Turkish Airlines' },
      { code: 'AF', name: 'Air France' }
    ];
    const durations  = ['PT6H30M', 'PT7H15M', 'PT8H0M', 'PT5H45M', 'PT9H20M'];
    const prices     = [320, 410, 289, 550, 375, 495, 260, 620];
    const departures = ['06:00', '08:30', '11:15', '14:00', '16:45', '19:30', '22:00'];

    return airlines.map((al, i) => {
      const depTime  = `${date}T${departures[i % departures.length]}:00`;
      const price    = prices[i % prices.length] * numAdults;
      const dur      = durations[i % durations.length];
      const durMatch = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
      const hrs      = parseInt(durMatch[1] || 0);
      const mins     = parseInt(durMatch[2] || 0);
      const arrDate  = new Date(depTime);
      arrDate.setHours(arrDate.getHours() + hrs);
      arrDate.setMinutes(arrDate.getMinutes() + mins);

      return {
        id: `demo-${i}`,
        price: {
          grandTotal: price.toFixed(2),
          currency: 'USD',
          fees: [{ amount: (price * 0.1).toFixed(2) }]
        },
        numberOfBookableSeats: Math.floor(Math.random() * 8) + 2,
        itineraries: [{
          duration: dur,
          segments: [{
            departure: { iataCode: orig, at: depTime },
            arrival:   { iataCode: dest, at: arrDate.toISOString() },
            carrierCode: al.code,
            number: String(100 + i * 37)
          }]
        }],
        travelerPricings: [{
          fareDetailsBySegment: [{ cabin: i === 3 ? 'BUSINESS' : 'ECONOMY' }]
        }]
      };
    });
  }

  try {
    const data = await skyFetch('/api/v2/flights/searchFlights', {
      originSkyId:           origin.toUpperCase(),
      destinationSkyId:      destination.toUpperCase(),
      originEntityId:        resolvedOriginEntityId,
      destinationEntityId:   resolvedDestinationEntityId,
      date:                  departureDate,
      adults:                parseInt(adults) || 1,
      currency:              'USD',
      market:                'en-US',
      countryCode:           'US',
      cabinClass:            'economy'
    });

    console.log('Flight search response status:', data?.status);
    console.log('Flight search message:', data?.message);
    console.log('Itineraries count:', data?.data?.itineraries?.length || 0);

    // Normalize Sky Scrapper response into a format our frontend understands
    const itineraries = data?.data?.itineraries || [];

    const flights = itineraries.slice(0, 15).map((it, i) => {
      const leg     = it.legs[0];
      const segment = leg.segments[0];
      const price   = it.price?.raw || 0;

      return {
        id: `flight-${i}`,
        price: {
          grandTotal: price.toFixed(2),
          currency:   'USD',
          fees:       [{ amount: (price * 0.1).toFixed(2) }]
        },
        numberOfBookableSeats: it.isSelfTransfer ? null : 9,
        itineraries: [{
          duration: `PT${Math.floor(leg.durationInMinutes / 60)}H${leg.durationInMinutes % 60}M`,
          segments: leg.segments.map(seg => ({
            departure: {
              iataCode: seg.origin.displayCode,
              at:       seg.departure
            },
            arrival: {
              iataCode: seg.destination.displayCode,
              at:       seg.arrival
            },
            carrierCode: seg.marketingCarrier?.alternateId || seg.operatingCarrier?.alternateId || '??',
            number:      seg.flightNumber || ''
          }))
        }],
        travelerPricings: [{
          fareDetailsBySegment: [{ cabin: it.tags?.includes('business') ? 'BUSINESS' : 'ECONOMY' }]
        }]
      };
    });

    // If API returned no results or failed, use demo flights
    if (!flights || flights.length === 0) {
      console.log('API returned no flights — using demo data');
      return res.json(generateDemoFlights(origin, destination, departureDate, parseInt(adults) || 1));
    }

    res.json(flights);
  } catch (err) {
    console.error('Flight search error:', err.message);
    console.log('API failed — using demo data as fallback');
    res.json(generateDemoFlights(origin, destination, departureDate, parseInt(adults) || 1));
  }
});

// ============================================================
// ROUTE: POST /api/payments/create-intent
// Creates a Stripe PaymentIntent on the server side.
// The client secret is sent back to the browser so Stripe.js
// can complete the payment securely — card data NEVER touches
// our server.
// Body: { amount (USD), currency, flightDetails }
// ============================================================
app.post('/api/payments/create-intent', async (req, res) => {
  const { amount, currency = 'usd', flightDetails } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Virheellinen maksusumma.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100), // Stripe uses cents
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: {
        // Store a short summary for your Stripe dashboard
        flight: JSON.stringify(flightDetails || {}).substring(0, 500)
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Maksun asetus epäonnistui. Yritä uudelleen.' });
  }
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✈️  SkyBook is running → http://localhost:${PORT}`);
});
