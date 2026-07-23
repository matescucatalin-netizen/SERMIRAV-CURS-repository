// update-rates.js
// Citeste periodic pagina publica de afisaj ExchangeOnline (Datagram) si scrie
// automat cursurile in Firebase, pentru fiecare locatie configurata mai jos.
// Nu modifica nimic pe partea ExchangeOnline - doar citeste pagina, exact ca un browser normal.

import * as cheerio from 'cheerio';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// ============ CONFIGURARE LOCATII ============
// Adauga aici cate o intrare pentru fiecare panou. "credEnv" e numele variabilei
// de mediu (secret GitHub) care contine cheia de service account Firebase pt acel proiect.
const LOCATIONS = [
  {
    name: 'Hermes',
    sourceUrl: 'https://screen.exchangeonline.ro/sermiravexch/baraganescu00000',
    databaseURL: 'https://sermirav-exchange-default-rtdb.europe-west1.firebasedatabase.app',
    credEnv: 'FIREBASE_CRED_HERMES',
    node: 'hermesSimplu',
  },
  // Exemplu pentru Centru, de completat cand avem link-ul + cheia:
  // {
  //   name: 'Centru',
  //   sourceUrl: 'https://screen.exchangeonline.ro/....',
  //   databaseURL: 'https://sermirav-centru-default-rtdb.europe-west1.firebasedatabase.app',
  //   credEnv: 'FIREBASE_CRED_CENTRU',
  //   node: 'centruSimplu',
  // },
];

// Codurile pe care le urmarim (trebuie sa corespunda cu cele din panou)
const TRACKED_CODES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'PLN', 'TRY', 'HUF'];

// ============ PARSARE PAGINA EXCHANGEONLINE ============
async function fetchRatesFromSource(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SermiravRatesSync/1.0 (+contact: proprietar panou)' },
  });
  if (!res.ok) throw new Error(`Eroare la citirea paginii sursa: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const rates = [];
  // Cautam randuri de tabel care contin un cod de 3 litere mari (EUR, USD, etc.)
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th').map((__, c) => $(c).text().trim()).get();
    const rowText = cells.join(' | ');
    const codeMatch = rowText.match(/\b([A-Z]{3})\b/);
    if (!codeMatch) return;
    const code = codeMatch[1];
    if (!TRACKED_CODES.includes(code)) return;

    // Extragem toate numerele din rand, cu virgula sau punct zecimal
    const numbers = cells
      .join(' ')
      .match(/\d+[.,]\d+/g);
    if (!numbers || numbers.length < 2) return;

    const parsed = numbers.map(n => parseFloat(n.replace(',', '.')));
    // De obicei ultimele doua numere valide sunt cumparam / vindem
    const buy = parsed[parsed.length - 2];
    const sell = parsed[parsed.length - 1];
    if (!isFinite(buy) || !isFinite(sell)) return;

    rates.push({ code, buy, sell });
  });

  // Deduplica (in caz ca acelasi cod apare de mai multe ori in pagina)
  const seen = new Set();
  return rates.filter(r => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

// ============ SCRIERE IN FIREBASE ============
async function syncLocation(loc) {
  const credJson = process.env[loc.credEnv];
  if (!credJson) {
    console.log(`[${loc.name}] Lipseste secretul ${loc.credEnv} - sar peste aceasta locatie.`);
    return;
  }

  const app = initializeApp(
    {
      credential: cert(JSON.parse(credJson)),
      databaseURL: loc.databaseURL,
    },
    loc.name // nume unic pentru fiecare app initializata in acelasi proces
  );
  const db = getDatabase(app);
  const ref = db.ref(loc.node);

  console.log(`[${loc.name}] Citesc cursurile de pe ${loc.sourceUrl} ...`);
  const freshRates = await fetchRatesFromSource(loc.sourceUrl);

  if (freshRates.length === 0) {
    console.log(`[${loc.name}] Nu am gasit niciun curs valid pe pagina sursa - nu ating Firebase (siguranta).`);
    return;
  }

  const snap = await ref.once('value');
  const current = snap.val() || { rates: [], gold: {} };
  const currentRates = Array.isArray(current.rates) ? current.rates : [];

  // Combinam: pastram toate valutele curente, suprascriem doar codurile gasite proaspat
  let changed = false;
  const mergedRates = TRACKED_CODES.map(code => {
    const existing = currentRates.find(r => r.code === code);
    const fresh = freshRates.find(r => r.code === code);
    if (fresh && (!existing || existing.buy !== fresh.buy || existing.sell !== fresh.sell)) {
      changed = true;
      return { code, buy: fresh.buy, sell: fresh.sell };
    }
    return existing || { code, buy: 0, sell: 0 };
  });

  if (!changed) {
    console.log(`[${loc.name}] Nicio schimbare fata de Firebase - nu scriu nimic.`);
    return;
  }

  await ref.update({ rates: mergedRates }); // nu atingem "gold", ramane cum e
  console.log(`[${loc.name}] ✓ Actualizat in Firebase (${mergedRates.length} valute).`);
}

// ============ RULARE ============
(async () => {
  for (const loc of LOCATIONS) {
    try {
      await syncLocation(loc);
    } catch (e) {
      console.error(`[${loc.name}] Eroare:`, e.message);
      // Nu oprim tot scriptul daca o locatie da eroare - continuam cu urmatoarea
    }
  }
})();
