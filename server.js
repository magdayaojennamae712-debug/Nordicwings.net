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

    const airports = (data.data || []).slice(0, 6).map(loc => ({
      iataCode:    loc.skyId,
      entityId:    loc.entityId,
      name:        loc.presentation?.suggestionTitle || loc.skyId,
      cityName:    loc.presentation?.subtitle || '',
      countryName: ''
    }));

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

  try {
    const data = await skyFetch('/api/v2/flights/searchFlights', {
      originSkyId:           origin.toUpperCase(),
      destinationSkyId:      destination.toUpperCase(),
      originEntityId:        originEntityId      || '',
      destinationEntityId:   destinationEntityId || '',
      date:                  departureDate,
      adults:                parseInt(adults) || 1,
      currency:              'USD',
      market:                'en-US',
      countryCode:           'US'
    });

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

    res.json(flights);
  } catch (err) {
    console.error('Flight search error:', err.message);
    res.status(500).json({ error: 'Lentoja ei voitu hakea. Yritä uudelleen.' });
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
